import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parseAbiItem, decodeEventLog, Hex } from 'viem';
import { prisma } from '../core/db.js';
import { dbLogger } from '../services/logger.js';
import { WalletProfiler } from '../services/walletProfiler.js';
import { publicClient } from '../services/viem.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export class TrackerAgent {
  public onCopyBuySignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number, txHash: string) => void;
  public onCopySellSignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number, txHash: string) => void;
  public onSwapActivity?: (walletLabel: string, txHash: string, toAddress: string, value: number) => void;

  private server: any;
  private processedTxHashes: Set<string> = new Set<string>();
  private lastBuyTime: Map<string, number> = new Map(); // For anti-farm: wallet-token -> timestamp

  constructor() {}

  public startListening(port?: number) {
    const listenPort = port || parseInt(process.env.PORT || '3001', 10);
    console.log(`🎯 Tracker Agent: Starting Webhook server on port ${listenPort}...`);

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS Headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/api/dashboard') {
        try {
          const [wallets, signals, positions, lpPositions, logs, totalSignals, openPositionsCount, tradingModeConfig, maxPosConfig] = await Promise.all([
            prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' } }),
            prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.position.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.lPPosition.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
            prisma.signal.count(),
            prisma.position.count({ where: { status: 'OPEN' } }),
            prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }),
            prisma.systemConfig.findUnique({ where: { key: 'MAX_POSITION_SIZE' } })
          ]);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            wallets, 
            signals, 
            positions, 
            lpPositions,
            logs, 
            metrics: {
              totalSignals,
              openPositionsCount,
              tradingMode: tradingModeConfig?.value || 'LIVE',
              maxPositionSize: maxPosConfig?.value ? parseInt(maxPosConfig.value, 10) : 2000
            }
          }));
        } catch (e) {
          console.error(`[Tracker] API Error:`, e);
          res.writeHead(500);
          res.end();
        }
      } else if (req.method === 'POST' && req.url === '/webhook/alchemy') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body);
            if (payload.event && payload.event.activity) {
              for (const activity of payload.event.activity) {
                await this.processActivity(activity);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (e) {
            console.error(`[Tracker] Webhook error:`, e);
            res.writeHead(500);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(listenPort, '0.0.0.0', () => {
      console.log(`[Tracker] 🟢 Webhook Server is actively listening for Alchemy events (/webhook/alchemy)`);
    });
  }

  private async processActivity(activity: any) {
    if (!activity.hash || !activity.fromAddress) return;

    const fromAddress = activity.fromAddress.toLowerCase();

    // Check if the fromAddress is in our registry
    const trackedWallet = await prisma.trackedWallet.findUnique({
      where: { address: fromAddress }
    });

    if (!trackedWallet || trackedWallet.status !== 'ACTIVE') {
      return; 
    }

    // Deduplicate by txHash to avoid processing the same transaction multiple times
    if (this.processedTxHashes?.has(activity.hash)) {
      return;
    }
    if (!this.processedTxHashes) {
      this.processedTxHashes = new Set<string>();
    }
    this.processedTxHashes.add(activity.hash);
    if (this.processedTxHashes.size > 10000) {
      this.processedTxHashes.clear();
      this.processedTxHashes.add(activity.hash);
    }

    console.log(`[Tracker] 🚨 Swap activity detected from: ${trackedWallet.label || fromAddress} | TX: https://robinhoodchain.blockscout.com/tx/${activity.hash}`);
    
    // Defer processing to not block the webhook response
    setTimeout(() => {
      this.analyzeTransactionReceipt(fromAddress, trackedWallet, activity.hash, activity.timestamp).catch(e => {
        console.error(`[Tracker] Error in analyzeTransactionReceipt for ${activity.hash}:`, e);
      });
    }, 2000); // Wait 2s for RPC indexing
  }

  private async analyzeTransactionReceipt(walletAddress: string, trackedWallet: any, txHash: string, timestampStr: string) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      if (receipt.status !== 'success') return;

      const tx = await publicClient.getTransaction({ hash: txHash as Hex });
      
      const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
      const walletLower = walletAddress.toLowerCase();
      
      let wethSpent = 0n;
      let wethReceived = 0n;
      
      // Native ETH tracking
      if (tx.from.toLowerCase() === walletLower && tx.value > 0n) {
        wethSpent += tx.value;
      }
      
      // We will map which tokens left the wallet and which tokens arrived
      const tokensAcquired = new Map<string, bigint>();
      const tokensSpent = new Map<string, bigint>();

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: [TRANSFER_EVENT],
            data: log.data,
            topics: log.topics
          });

          if (decoded.eventName === 'Transfer') {
            const { from, to, value } = decoded.args;
            const tokenAddr = log.address.toLowerCase();
            const fromAddr = from.toLowerCase();
            const toAddr = to.toLowerCase();

            if (fromAddr === walletLower) {
              if (tokenAddr === WETH_ADDRESS) wethSpent += value;
              else {
                const current = tokensSpent.get(tokenAddr) || 0n;
                tokensSpent.set(tokenAddr, current + value);
              }
            }
            
            if (toAddr === walletLower) {
              if (tokenAddr === WETH_ADDRESS) wethReceived += value;
              else {
                const current = tokensAcquired.get(tokenAddr) || 0n;
                tokensAcquired.set(tokenAddr, current + value);
              }
            }
          }
        } catch (e) {
          // Not a standard transfer event
        }
      }

      const timestamp = timestampStr ? new Date(timestampStr).getTime() : Date.now();

      // Analyze Net Flow to determine BUY or SELL
      // BUY condition: WETH spent > 0, Token acquired > 0
      if (wethSpent > 0n && tokensAcquired.size > 0) {
        for (const [tokenAddr, tokenAmount] of tokensAcquired.entries()) {
          // If we spent WETH and got Token, it's a BUY of Token.
          // We assume the wethSpent was entirely used for this token (simplification for single swaps)
          await this.emitSignal(WETH_ADDRESS, tokenAddr, wethSpent, walletAddress, trackedWallet, timestamp, txHash);
        }
      }

      // SELL condition: Token spent > 0, WETH received > 0 (or native ETH received... native ETH trace is hard, we rely on WETH/WETH unwrapping if any, or just assume if Token left, it was a sell)
      if (tokensSpent.size > 0) {
        for (const [tokenAddr, tokenAmount] of tokensSpent.entries()) {
          // We consider it a sell if any token leaves the wallet and they get WETH back.
          // Wait, if wethReceived == 0, maybe they got native ETH? We can't trace internal native ETH transfers easily via logs.
          // But if they spent a token, we can assume it's a SELL anyway, and let Orchestrator handle size based on position.
          await this.emitSignal(tokenAddr, WETH_ADDRESS, tokenAmount, walletAddress, trackedWallet, timestamp, txHash);
        }
      }

    } catch (e: any) {
      console.error(`[Tracker] ❌ Failed to analyze receipt for ${txHash}: ${e.message}`);
    }
  }

  private async emitSignal(tokenIn: string, tokenOut: string, amountIn: bigint, walletAddress: string, trackedWallet: any, timestamp: number, txHash: string) {
    const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
    
    console.log(`[Tracker-DEBUG] emitSignal called. tokenIn: ${tokenIn}, tokenOut: ${tokenOut}, WETH: ${WETH_ADDRESS}, amount: ${amountIn}`);

    if (tokenIn === WETH_ADDRESS) {
      // BUY targetToken
      console.log(`[Tracker-DEBUG] It is a BUY! Firing onCopyBuySignal...`);
      WalletProfiler.processBuy(walletAddress, tokenOut, txHash);
      console.log(`[Tracker] 🛒 BUY Signal: ${walletAddress} bought ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
      dbLogger.info(`BUY Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenOut, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });

      try {
        await prisma.signal.create({
          data: {
            tokenAddress: tokenOut,
            score: 90,
            passed: true,
            source: 'COPYTRADE',
            copiedFrom: walletAddress,
            rawContext: { type: 'BUY', wallet: trackedWallet.label || walletAddress, tier: trackedWallet.tier, amountWei: amountIn.toString(), txHash }
          }
        });
        console.log(`[Tracker] ✅ BUY signal saved to DB for ${tokenOut}`);
      } catch (e: any) {}
      
      this.lastBuyTime.set(`${walletAddress}-${tokenOut}`, timestamp);

      if (this.onCopyBuySignal) {
        this.onCopyBuySignal(walletAddress, tokenOut, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
      }
    } else if (tokenOut === WETH_ADDRESS) {
      // SELL tokenIn
      console.log(`[Tracker] 💥 SELL Signal: ${walletAddress} sold ${tokenIn} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
      dbLogger.info(`SELL Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenIn, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });

      try {
        await prisma.signal.create({
          data: {
            tokenAddress: tokenIn,
            score: 90,
            passed: true,
            source: 'COPYTRADE',
            copiedFrom: walletAddress,
            rawContext: { type: 'SELL', wallet: trackedWallet.label || walletAddress, tier: trackedWallet.tier, amountWei: amountIn.toString(), txHash }
          }
        });
      } catch (e: any) {}
      
      WalletProfiler.processSell(walletAddress, tokenIn, txHash);

      const buyTime = this.lastBuyTime.get(`${walletAddress}-${tokenIn}`);
      if (buyTime && (timestamp - buyTime < 120000)) {
        const msg = `Anti-farm triggered: ${trackedWallet.label || walletAddress} flipped ${tokenIn} in < 2 min. Demoting to Tier 3.`;
        console.warn(`[Tracker] 🚨 ` + msg);
        dbLogger.warn(msg, { wallet: walletAddress, token: tokenIn });
        prisma.trackedWallet.update({
          where: { address: walletAddress },
          data: { tier: 3 }
        }).catch(e => {});
      }

      if (this.onCopySellSignal) {
        this.onCopySellSignal(walletAddress, tokenIn, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
      }
    } else {
      console.log(`[Tracker] 🚫 Ignored SWAP (No WETH involved): ${walletAddress} swapped ${tokenIn} for ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
    }
  }
}
