import { Bot } from 'grammy';
import { parseAbi, erc20Abi } from 'viem';
import { publicClient } from '../services/viem.js';
import { ScoutAgent } from '../agents/scout.js';
import { TraderAgent } from '../agents/trader.js';
import { LpManagerAgent } from '../agents/lp.js';
import { LPEngineAgent, type LPProposal } from '../agents/lpengine.js';
import { RiskWardenAgent } from '../agents/risk.js';
import { GuardianAgent } from '../agents/guardian.js';
import { TrackerAgent } from '../agents/tracker.js';
import { prisma } from './db.js';

export class Orchestrator {
  private scout: ScoutAgent;
  private trader: TraderAgent;
  private lpManager: LpManagerAgent;
  private lpEngine: LPEngineAgent;
  private riskWarden: RiskWardenAgent;
  private guardian: GuardianAgent;
  private tracker: TrackerAgent;
  private bot: Bot;

  private processingTokens: Set<string> = new Set();

  constructor(bot: Bot) {
    this.bot = bot;
    this.scout = new ScoutAgent(bot);
    this.trader = new TraderAgent(bot);
    this.lpManager = new LpManagerAgent();
    this.lpEngine = new LPEngineAgent();
    this.riskWarden = new RiskWardenAgent();
    this.guardian = new GuardianAgent();
    this.tracker = new TrackerAgent();

    // ─── LP Engine proposal handler ────────────────────────────────────────
    this.lpEngine.onProposal = async (proposal: LPProposal) => {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) {
        console.warn('[Orchestrator] TELEGRAM_CHAT_ID not set — LP proposal dropped');
        return;
      }

      const modeCfg = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
      const isDryRun = (modeCfg?.value || 'LIVE') === 'DRY_RUN';
      const dryRunTag = isDryRun ? '\n🧪 *DRY RUN — no tx will be sent*' : '';

      const isAuto = proposal.description.includes('✅ *Auto-') || proposal.description.includes('❌ *Auto-');

      const msgOptions: any = { parse_mode: 'Markdown' };

      if (!isAuto) {
        // Inline keyboard: Approve / Reject (only for manual flows)
        const approveData = `lp_approve:${proposal.positionId}:${proposal.type}`;
        const rejectData  = `lp_reject:${proposal.positionId}:${proposal.type}`;
        msgOptions.reply_markup = {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: approveData },
            { text: '❌ Reject',  callback_data: rejectData  },
          ]],
        };
      }

      try {
        await bot.api.sendMessage(chatId, `${proposal.description}${dryRunTag}`, msgOptions);
        console.log(`[Orchestrator] LP proposal sent to Telegram: ${proposal.type} | pos: ${proposal.positionId}`);
      } catch (e) {
        console.error('[Orchestrator] Failed to send LP proposal to Telegram:', e);
      }
    };

    // ─── LP Engine notification handler ──────────────────────────────────────
    this.lpEngine.onNotification = async (message: string) => {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return;

      try {
        await bot.api.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('[Orchestrator] Failed to send telegram notification:', e);
      }
    };

    // ─── LP Guardian Events ────────────────────────────────────────────────
    this.guardian.onLPCloseSignal = async (pos, reason) => {
      console.log(`[Orchestrator] 🚨 Guardian requested LP CLOSE for ${pos.id}. Reason: ${reason}`);
      await this.lpEngine.proposeClosePosition(pos.id, reason).catch(console.error);
    };

    this.guardian.onLPCompoundSignal = async (pos) => {
      console.log(`[Orchestrator] 🌾 Guardian requested LP COMPOUND for ${pos.id}`);
      // In MANUAL mode, this forwards harvest proposal
      await this.lpEngine.proposeHarvest(pos.id).catch(console.error);
    };

    this.guardian.onLPRebalanceSignal = async (pos, reason) => {
      console.log(`[Orchestrator] ⚖️ Guardian requested LP REBALANCE for ${pos.id}. Reason: ${reason}`);
      // For MVP, rebalance is just close.
      await this.lpEngine.proposeClosePosition(pos.id, reason).catch(console.error);
    };

    // Wire up events
    this.guardian.onExitSignal = async (pos: any, reason: string, txHash?: string) => {
      const tokenAddress = pos.tokenAddress;
      console.log(`[Orchestrator] Guardian requested exit for ${tokenAddress} (${reason}), forwarding to Trader...`);
      
      const walletAddress = process.env.USER_WALLET_ADDRESS;
      let tokenAmountToSell = 0n;
      let isPaperTrade = false;

      if (pos.tradingMode === 'DRY_RUN') {
        // Calculate the theoretical token amount we own based on the simulated entry
        const tokensOwned = pos.entryPrice > 0 ? (pos.size / pos.entryPrice) : 0;
        const tokensOwnedStr = (tokensOwned * 1e18).toLocaleString('fullwide', {useGrouping:false, maximumFractionDigits:0});
        tokenAmountToSell = BigInt(tokensOwnedStr);
        console.log(`[Orchestrator] Calculated DRY_RUN simulated token balance: ${tokenAmountToSell}`);
      } else if (walletAddress && walletAddress.startsWith('0x')) {
        try {
          const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
          tokenAmountToSell = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`]
          });
          console.log(`[Orchestrator] Fetched real token balance: ${tokenAmountToSell}`);
        } catch (e) {
          console.error(`[Orchestrator] Failed to fetch token balance for ${tokenAddress}`, e);
        }
      }

      if (tokenAmountToSell === 0n) {
        console.warn(`[Orchestrator] Real wallet balance is 0. Closing position in DB without swapping.`);
        await prisma.position.update({ where: { id: pos.id }, data: { status: 'CLOSED' } });
        return;
      }

      if (tokenAmountToSell > 0n) {
        // Mark as EXITING so Guardian stops monitoring it and doesn't retry instantly
        await prisma.position.update({ where: { id: pos.id }, data: { status: 'EXITING' } });
        this.trader.processExitSignal(pos.id, tokenAddress, tokenAmountToSell, reason, txHash);
      } else {
        console.warn(`[Orchestrator] Aborting exit signal: Unable to process balance for ${tokenAddress}`);
      }
    };

    this.scout.onSignal = async (tokenAddress) => {
      const lowerToken = tokenAddress.toLowerCase();
      if (this.processingTokens.has(lowerToken)) return;
      this.processingTokens.add(lowerToken);

      try {
        const COOLDOWN_MS = 60 * 60 * 1000;
        const existingPos = await prisma.position.findFirst({
           where: { 
             tokenAddress: { equals: tokenAddress, mode: 'insensitive' }, 
             OR: [
               { status: { in: ['OPEN', 'PENDING', 'EXITING'] } },
               { createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) } }
             ]
           }
        });
        if (existingPos) {
           console.log(`[Orchestrator] ℹ️ Dedup: Active position or cooldown exists for ${tokenAddress}, ignoring Scout signal.`);
           return;
        }

        console.log(`[Orchestrator] Received signal for ${tokenAddress}, consulting Risk Warden...`);
      
      // Save Signal to DB
      try {
        await prisma.signal.create({
          data: {
            tokenAddress,
            score: 100, // Hardcoded for now based on Scout heuristic passing
            passed: true,
            rawContext: { source: 'SCOUT' },
            source: 'SCOUT'
          }
        });
      } catch (e) {
        console.error(`[Orchestrator] Failed to save SCOUT signal to DB`, e);
      }

      const riskEvaluation = await this.riskWarden.evaluateSignal(tokenAddress);
      
      if (riskEvaluation.approved) {
        console.log(`[Orchestrator] Risk Warden approved. Forwarding to Trader with size ${riskEvaluation.recommendedSize}...`);
        this.trader.processSignal(tokenAddress, riskEvaluation.recommendedSize, 'SCOUT');
        
        // Guardian now polls DB for OPEN positions autonomously, so we don't start monitoring manually here.
      } else {
        console.warn(`[Orchestrator] Risk Warden rejected signal for ${tokenAddress}. Reason: ${riskEvaluation.reason}`);
      }
      } finally {
        setTimeout(() => this.processingTokens.delete(lowerToken), 10000);
      }
    };

    // Tracker Events
    // Tracker Events
    this.tracker.onSwapActivity = async (walletLabel, txHash, toAddress, value) => {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        const msg = `🚨 <b>SWAP ACTIVITY DETECTED</b>\n\n👤 <b>From:</b> <code>${walletLabel}</code>\n🎯 <b>To (Contract):</b> <code>${toAddress}</code>\n💰 <b>Value:</b> ${value} ETH\n🔗 <a href="https://robinhoodchain.blockscout.com/tx/${txHash}">View Transaction</a>`;
        this.bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML' }).catch(console.error);
      }
    };

    this.tracker.onCopyBuySignal = async (wallet, token, amount, tier, bundleId, timestamp, txHash) => {
      console.log(`[Orchestrator-DEBUG] onCopyBuySignal triggered for ${token} from ${wallet}`);
      const lowerToken = token.toLowerCase();
      if (this.processingTokens.has(lowerToken)) {
        console.log(`[Orchestrator] ℹ️ Dedup: Already processing a signal for ${token}, ignoring this concurrent CopyBuy.`);
        return;
      }
      this.processingTokens.add(lowerToken);

      try {
        console.log(`[Orchestrator-DEBUG] Checking existing position for ${token}`);
        const COOLDOWN_MS = 60 * 60 * 1000;
        const existingPos = await prisma.position.findFirst({
           where: { 
             tokenAddress: { equals: token, mode: 'insensitive' }, 
             OR: [
               { status: { in: ['OPEN', 'PENDING', 'EXITING'] } },
               { createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) } }
             ]
           }
        });
        if (existingPos) {
           console.log(`[Orchestrator] ℹ️ Dedup: Active position or cooldown exists for ${token}, ignoring CopyBuy signal.`);
           return;
        }

      console.log(`[Orchestrator] 🎯 CopyBuy Signal received for ${token} from ${wallet} (Tier: ${tier})`);
      
      let tokenMetadata = token;
      try {
        const [name, symbol] = await Promise.all([
          publicClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
          publicClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'symbol' })
        ]);
        tokenMetadata = `${name} (${symbol}) - <code>${token}</code>`;
      } catch (e) {
        tokenMetadata = `<code>${token}</code>`;
      }

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        this.bot.api.sendMessage(
          chatId,
          `🛒 <b>BUY SIGNAL DETECTED</b>\n\n👤 <b>Wallet:</b> <code>${wallet}</code> (Tier ${tier})\n🪙 <b>Token:</b> ${tokenMetadata}\n💰 <b>Amount:</b> ${Number(amount) / 1e18} ETH\n⏰ <b>Time:</b> ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n🔗 <a href="https://robinhoodchain.blockscout.com/tx/${txHash}">View Transaction</a>`,
          { parse_mode: 'HTML' }
        ).catch(console.error);
      }

      // 1. Freshness Filter (max 60 seconds)
      const ageMs = Date.now() - timestamp;
      if (ageMs > 60000) {
        console.warn(`[Orchestrator] 🚫 Signal rejected: Stale signal (${Math.floor(ageMs/1000)}s old)`);
        return;
      }


      // 2. Min Buy Size Filter (0.001 ETH)
      const minBuy = 1000000000000000n; // 0.001 ETH
      if (amount < minBuy) {
        console.warn(`[Orchestrator] 🚫 Signal rejected: Buy amount too small (${Number(amount)/1e18} ETH < 0.001)`);
        return;
      }

      // 3. Dedup Filter (already monitoring)
      if (this.guardian.isMonitoring(token)) {
        console.log(`[Orchestrator] ℹ️ Dedup: Already monitoring position for ${token}, ignoring extra signal.`);
        return;
      }

      // Save Signal to DB
      try {
        await prisma.signal.create({
          data: {
            tokenAddress: token,
            score: 100,
            passed: true,
            rawContext: { source: 'COPYTRADE', wallet, tier, bundleId, amount: amount.toString() },
            source: 'COPYTRADE',
            copiedFrom: wallet
          }
        });
      } catch (e) {
        console.error(`[Orchestrator] Failed to save COPYTRADE signal to DB`, e);
      }

      // Update TrackedWallet totalSignals count
      try {
        await prisma.trackedWallet.update({
          where: { address: wallet.toLowerCase() },
          data: { totalSignals: { increment: 1 } }
        });
      } catch (e) {
        console.error(`[Orchestrator] Failed to increment totalSignals for wallet ${wallet}`, e);
      }

      // 4. Chase Guard (Proxy via Freshness for v1, as precise entry mcap requires full log parsing)
      // For now, pass to risk warden with tier sizing
      const riskEvaluation = await this.riskWarden.evaluateSignal(token);
      
      
      if (riskEvaluation.approved) {
        let sizeModifier = 1n; // Tier 1
        if (tier === 2) sizeModifier = 2n; // divide by 2 for Tier 2

        const finalSize = riskEvaluation.recommendedSize / sizeModifier;
        
        if (chatId) {
          this.bot.api.sendMessage(
            chatId,
            `✅ <b>Risk Warden Approved</b>\nForwarding BUY to Trader with size: <code>${Number(finalSize) / 1e18} WETH</code>`,
            { parse_mode: 'HTML' }
          ).catch(console.error);
        }

        if (finalSize === 0n) {
          console.log(`[Orchestrator] 📄 Size is 0, skipping trade.`);
          return;
        }

        console.log(`[Orchestrator] Forwarding CopyBuy to Trader. Size: ${finalSize}...`);
        

        this.trader.processSignal(token, finalSize, 'COPYTRADE', wallet, txHash);
        // Guardian DB polling handles monitoring
      } else {
        console.warn(`[Orchestrator] CopyBuy Risk Warden VETO for ${token}: ${riskEvaluation.reason}`);
        if (chatId) {
          this.bot.api.sendMessage(
            chatId,
            `🚨 <b>RISK WARDEN VETO</b>\nReason: ${riskEvaluation.reason}`,
            { parse_mode: 'HTML' }
          ).catch(console.error);
        }
      }
      } catch (err: any) {
        console.error(`[Orchestrator] ❌ Unhandled error in onCopyBuySignal for ${token}:`, err);
      } finally {
        setTimeout(() => this.processingTokens.delete(lowerToken), 10000);
      }
    };

    this.tracker.onCopySellSignal = async (wallet, token, amount, tier, bundleId, timestamp, txHash) => {
      try {
        console.log(`[Orchestrator] 💥 CopySell Signal received for ${token} from ${wallet}`);
      
      let tokenMetadata = token;
      try {
        const [name, symbol] = await Promise.all([
          publicClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
          publicClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'symbol' })
        ]);
        tokenMetadata = `${name} (${symbol}) - <code>${token}</code>`;
      } catch (e) {
        tokenMetadata = `<code>${token}</code>`;
      }

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        this.bot.api.sendMessage(
          chatId,
          `💥 <b>SELL SIGNAL DETECTED</b>\n\n👤 <b>Wallet:</b> <code>${wallet}</code> (Tier ${tier})\n🪙 <b>Token:</b> ${tokenMetadata}\n🔗 <a href="https://robinhoodchain.blockscout.com/tx/${txHash}">View Transaction</a>\n\nProcessing exit protocol...`,
          { parse_mode: 'HTML' }
        ).catch(console.error);
      }
      
      // Feature Flag check for CopyExit
      const config = await prisma.systemConfig.findUnique({
        where: { key: 'copyExitEnabled' }
      });
      if (config && config.value === 'true') {
        console.log(`[Orchestrator] Copy-Exit is ON. Forcing Guardian to trigger exit...`);
        // We reuse the guardian exit logic which forwards to trader
        const pos = await prisma.position.findFirst({ where: { tokenAddress: { equals: token, mode: 'insensitive' }, status: 'OPEN' } });
        if (pos) {
          this.guardian.onExitSignal!(pos, `COPY_EXIT_TRIGGERED_BY_${wallet}`, txHash);
        } else {
          console.log(`[Orchestrator] No OPEN position found for ${token} to copy-exit.`);
        }
      } else {
        console.log(`[Orchestrator] Copy-Exit is OFF. Ignoring sell signal.`);
      }
      } catch (err: any) {
        console.error(`[Orchestrator] ❌ Unhandled error in onCopySellSignal for ${token}:`, err);
      }
    };
  }

  /**
   * Manually injects a token into the pipeline (Useful for Dry Run / Telegram commands)
   */
  public injectManualSignal(tokenAddress: string) {
    console.log(`[Orchestrator] 🧪 Manual Dry Run injected for ${tokenAddress}`);
    // We bypass Scout's listener and force it to score this token
    (this.scout as any).scoreLaunch(tokenAddress);
  }

  public setTraderMode(mode: 'AUTO' | 'CONFIRM') {
    this.trader.executionMode = mode;
    console.log(`[Orchestrator] Trader execution mode set to ${mode}`);
  }

  // Expose lpEngine for bot commands
  public getLPEngine(): LPEngineAgent {
    return this.lpEngine;
  }

  private scheduleLPCron() {
    const runCron = () => {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const h = parseInt(parts.find(p => p.type === 'hour')!.value);
      const m = parseInt(parts.find(p => p.type === 'minute')!.value);

      // NIGHT mode (Aggressive Scouting): Run every hour
      if (m === 0) {
        console.log(`[Orchestrator] 🚀 LP Engine hourly scan triggered (Hour: ${h})`);
        this.lpEngine.runNightMode().catch(console.error);
      }
    };
    // Poll every minute
    setInterval(runCron, 60_000);
    console.log('[Orchestrator] LP cron scheduled (Hourly scan at minute :00)');
  }

  public async processAlphaSpotSignal(tokenAddress: string, score: number) {
    const lowerToken = tokenAddress.toLowerCase();
    if (this.processingTokens.has(lowerToken)) {
      console.log(`[Orchestrator] ℹ️ Dedup: Already processing a signal for ${tokenAddress}, ignoring Alpha signal.`);
      return;
    }
    this.processingTokens.add(lowerToken);

    try {
      const COOLDOWN_MS = 60 * 60 * 1000;
      const existingPos = await prisma.position.findFirst({
         where: { 
           tokenAddress: { equals: tokenAddress, mode: 'insensitive' }, 
           OR: [
             { status: { in: ['OPEN', 'PENDING', 'EXITING'] } },
             { createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) } }
           ]
         }
      });
      if (existingPos) {
         console.log(`[Orchestrator] ℹ️ Dedup: Active position or cooldown exists for ${tokenAddress}, ignoring Alpha signal.`);
         return;
      }

      console.log(`[Orchestrator] Received Alpha Spot signal for ${tokenAddress}, consulting Risk Warden...`);
    
      try {
        await prisma.signal.create({
          data: {
            tokenAddress,
            score: score,
            passed: true,
            rawContext: { source: 'ALPHA' },
            source: 'ALPHA'
          }
        });
      } catch (e) {
        console.error(`[Orchestrator] Failed to save ALPHA signal to DB`, e);
      }

      const riskEvaluation = await this.riskWarden.evaluateSignal(tokenAddress);
      
      if (riskEvaluation.approved) {
        console.log(`[Orchestrator] Risk Warden approved Alpha Spot. Forwarding to Trader with size ${riskEvaluation.recommendedSize}...`);
        this.trader.processSignal(tokenAddress, riskEvaluation.recommendedSize, 'ALPHA');
      } else {
        console.warn(`[Orchestrator] Risk Warden rejected Alpha signal for ${tokenAddress}. Reason: ${riskEvaluation.reason}`);
      }
    } finally {
      setTimeout(() => this.processingTokens.delete(lowerToken), 10000);
    }
  }

  public async startAll() {
    console.log("🚀 Orchestrator: Starting all Fletcher agents (Minimum Viable Swarm)...");
    
    // Recover any pending transactions that crashed during deployment
    await this.trader.recoverPendingTrades();

    // Start monitoring for new token launches
    await this.scout.startListening();
    
    // Start tracking wallets via webhook
    this.tracker.startListening();

    // Start Guardian DB polling
    this.guardian.init();

    // ─── LP Engine: DAY mode cron (09:00 WIB) ──────────────────────────────
    this.scheduleLPCron();

    // Start Dormant cleanup cronjob (every 12 hours)
    setInterval(async () => {
      try {
        console.log('[Orchestrator] 🧹 Running Dormant Wallet cleanup...');
        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        
        const dormantWallets = await prisma.trackedWallet.updateMany({
          where: {
            status: { not: 'DORMANT' },
            lastTradeAt: { lt: fourteenDaysAgo }
          },
          data: { status: 'DORMANT' }
        });
        
        if (dormantWallets.count > 0) {
          console.log(`[Orchestrator] 💤 Marked ${dormantWallets.count} wallets as DORMANT.`);
        }
      } catch (e) {
        console.error('[Orchestrator] Error in dormant cleanup', e);
      }
    }, 12 * 60 * 60 * 1000);
  }
}
