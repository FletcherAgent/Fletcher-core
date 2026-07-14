import { parseAbi } from 'viem';
import { publicClient } from '../services/viem.js';
import { ScoutAgent } from '../agents/scout.js';
import { TraderAgent } from '../agents/trader.js';
import { LpManagerAgent } from '../agents/lp.js';
import { RiskWardenAgent } from '../agents/risk.js';
import { GuardianAgent } from '../agents/guardian.js';
import { TrackerAgent } from '../agents/tracker.js';
import { prisma } from './db.js';
export class Orchestrator {
    scout;
    trader;
    lpManager;
    riskWarden;
    guardian;
    tracker;
    bot;
    constructor(bot) {
        this.bot = bot;
        this.scout = new ScoutAgent(bot);
        this.trader = new TraderAgent(bot);
        this.lpManager = new LpManagerAgent();
        this.riskWarden = new RiskWardenAgent();
        this.guardian = new GuardianAgent();
        this.tracker = new TrackerAgent();
        // Wire up events
        this.guardian.onExitSignal = async (tokenAddress, reason) => {
            console.log(`[Orchestrator] Guardian requested exit for ${tokenAddress} (${reason}), forwarding to Trader...`);
            const walletAddress = process.env.USER_WALLET_ADDRESS;
            let tokenAmountToSell = 0n;
            if (walletAddress && walletAddress.startsWith('0x')) {
                try {
                    const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
                    tokenAmountToSell = await publicClient.readContract({
                        address: tokenAddress,
                        abi: erc20Abi,
                        functionName: 'balanceOf',
                        args: [walletAddress]
                    });
                    console.log(`[Orchestrator] Fetched real token balance: ${tokenAmountToSell}`);
                }
                catch (e) {
                    console.error(`[Orchestrator] Failed to fetch token balance for ${tokenAddress}`, e);
                }
            }
            if (tokenAmountToSell > 0n) {
                this.trader.processExitSignal(tokenAddress, tokenAmountToSell, reason);
            }
            else {
                console.warn(`[Orchestrator] Aborting exit signal: Wallet has 0 balance for ${tokenAddress}`);
            }
        };
        this.scout.onSignal = async (tokenAddress) => {
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
            }
            catch (e) {
                console.error(`[Orchestrator] Failed to save SCOUT signal to DB`, e);
            }
            const riskEvaluation = await this.riskWarden.evaluateSignal(tokenAddress);
            if (riskEvaluation.approved) {
                console.log(`[Orchestrator] Risk Warden approved. Forwarding to Trader with size ${riskEvaluation.recommendedSize}...`);
                this.trader.processSignal(tokenAddress, riskEvaluation.recommendedSize, 'SCOUT');
                // Simulating the post-fill workflow: Start Guardian monitoring immediately
                this.guardian.startMonitoring(tokenAddress, riskEvaluation.recommendedSize);
            }
            else {
                console.warn(`[Orchestrator] Risk Warden rejected signal for ${tokenAddress}. Reason: ${riskEvaluation.reason}`);
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
            console.log(`[Orchestrator] 🎯 CopyBuy Signal received for ${token} from ${wallet} (Tier: ${tier})`);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                this.bot.api.sendMessage(chatId, `🛒 <b>BUY SIGNAL DETECTED</b>\n\n👤 <b>Wallet:</b> <code>${wallet}</code> (Tier ${tier})\n🪙 <b>Token:</b> <code>${token}</code>\n💰 <b>Amount:</b> ${Number(amount) / 1e18} ETH\n🔗 <a href="https://robinhoodchain.blockscout.com/tx/${txHash}">View Transaction</a>`, { parse_mode: 'HTML' }).catch(console.error);
            }
            // 1. Freshness Filter (max 60 seconds)
            const ageMs = Date.now() - timestamp;
            if (ageMs > 60000) {
                console.warn(`[Orchestrator] 🚫 Signal rejected: Stale signal (${Math.floor(ageMs / 1000)}s old)`);
                return;
            }
            // 2. Min Buy Size Filter (0.001 ETH)
            const minBuy = 1000000000000000n; // 0.001 ETH
            if (amount < minBuy) {
                console.warn(`[Orchestrator] 🚫 Signal rejected: Buy amount too small (${Number(amount) / 1e18} ETH < 0.001)`);
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
            }
            catch (e) {
                console.error(`[Orchestrator] Failed to save COPYTRADE signal to DB`, e);
            }
            // Update TrackedWallet totalSignals count
            try {
                await prisma.trackedWallet.update({
                    where: { address: wallet.toLowerCase() },
                    data: { totalSignals: { increment: 1 } }
                });
            }
            catch (e) {
                console.error(`[Orchestrator] Failed to increment totalSignals for wallet ${wallet}`, e);
            }
            // 4. Chase Guard (Proxy via Freshness for v1, as precise entry mcap requires full log parsing)
            // For now, pass to risk warden with tier sizing
            const riskEvaluation = await this.riskWarden.evaluateSignal(token);
            if (riskEvaluation.approved) {
                let sizeModifier = 1n; // Tier 1
                if (tier === 2)
                    sizeModifier = 2n; // divide by 2 for Tier 2
                const finalSize = riskEvaluation.recommendedSize / sizeModifier;
                if (chatId) {
                    this.bot.api.sendMessage(chatId, `✅ <b>Risk Warden Approved</b>\nForwarding BUY to Trader with size: <code>${Number(finalSize) / 1e18} WETH</code>`, { parse_mode: 'HTML' }).catch(console.error);
                }
                if (finalSize === 0n) {
                    console.log(`[Orchestrator] 📄 Size is 0, skipping trade.`);
                    return;
                }
                const isPaperTrade = tier === 3;
                console.log(`[Orchestrator] Forwarding CopyBuy to Trader. Size: ${finalSize}... Paper Trade: ${isPaperTrade}`);
                this.trader.processSignal(token, finalSize, 'COPYTRADE', wallet, isPaperTrade);
                this.guardian.startMonitoring(token, finalSize);
            }
            else {
                console.warn(`[Orchestrator] CopyBuy Risk Warden VETO for ${token}: ${riskEvaluation.reason}`);
                if (chatId) {
                    this.bot.api.sendMessage(chatId, `🚨 <b>RISK WARDEN VETO</b>\nReason: ${riskEvaluation.reason}`, { parse_mode: 'HTML' }).catch(console.error);
                }
            }
        };
        this.tracker.onCopySellSignal = async (wallet, token, amount, tier, bundleId, timestamp, txHash) => {
            console.log(`[Orchestrator] 💥 CopySell Signal received for ${token} from ${wallet}`);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                this.bot.api.sendMessage(chatId, `💥 <b>SELL SIGNAL DETECTED</b>\n\n👤 <b>Wallet:</b> <code>${wallet}</code> (Tier ${tier})\n🪙 <b>Token:</b> <code>${token}</code>\n🔗 <a href="https://robinhoodchain.blockscout.com/tx/${txHash}">View Transaction</a>\n\nProcessing exit protocol...`, { parse_mode: 'HTML' }).catch(console.error);
            }
            // Feature Flag check for CopyExit
            const config = await prisma.systemConfig.findUnique({
                where: { key: 'copyExitEnabled' }
            });
            if (config && config.value === 'true') {
                console.log(`[Orchestrator] Copy-Exit is ON. Forcing Guardian to trigger exit...`);
                // We reuse the guardian exit logic which forwards to trader
                this.guardian.onExitSignal(token, `COPY_EXIT_TRIGGERED_BY_${wallet}`);
            }
            else {
                console.log(`[Orchestrator] Copy-Exit is OFF. Ignoring sell signal.`);
            }
        };
    }
    /**
     * Manually injects a token into the pipeline (Useful for Dry Run / Telegram commands)
     */
    injectManualSignal(tokenAddress) {
        console.log(`[Orchestrator] 🧪 Manual Dry Run injected for ${tokenAddress}`);
        // We bypass Scout's listener and force it to score this token
        this.scout.scoreLaunch(tokenAddress);
    }
    setTraderMode(mode) {
        this.trader.executionMode = mode;
        console.log(`[Orchestrator] Trader execution mode set to ${mode}`);
    }
    async startAll() {
        console.log("🚀 Orchestrator: Starting all Fletcher agents (Minimum Viable Swarm)...");
        // Start monitoring for new token launches
        await this.scout.startListening();
        // Start tracking wallets via webhook
        this.tracker.startListening();
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
            }
            catch (e) {
                console.error('[Orchestrator] Error in dormant cleanup', e);
            }
        }, 12 * 60 * 60 * 1000);
    }
}
