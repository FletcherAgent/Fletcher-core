import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parseAbi, decodeFunctionData, Hex } from 'viem';
import { prisma } from '../core/db.js';

export class TrackerAgent {
  public onCopyBuySignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number) => void;
  public onCopySellSignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number) => void;

  private server: any;
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
          const [wallets, signals, positions] = await Promise.all([
            prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' } }),
            prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.position.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ wallets, signals, positions }));
        } catch (e) {
          console.error(`[Tracker] API error:`, e);
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
            // Verify Alchemy payload signature if needed here
            
            // Handle Address Activity webhook payload
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
    if (activity.category !== 'external' || !activity.rawContract) return; // Basic filtering

    const fromAddress = activity.fromAddress.toLowerCase();
    const toAddress = activity.toAddress?.toLowerCase(); // Target contract

    // Check if the fromAddress is in our registry
    const trackedWallet = await prisma.trackedWallet.findUnique({
      where: { address: fromAddress }
    });

    if (!trackedWallet || trackedWallet.status !== 'ACTIVE') {
      return; // Not tracked or not active
    }

    console.log(`[Tracker] 🚨 Activity detected from tracked wallet: ${trackedWallet.label || fromAddress}`);

    const calldata = activity.rawContract?.rawValue as Hex;
    if (!calldata || calldata.length < 10) return;

    try {
      const activityTime = activity.timestamp ? new Date(activity.timestamp).getTime() : Date.now();
      this.decodeAndClassifySwap(calldata, fromAddress, toAddress, trackedWallet, activityTime);
    } catch (e: any) {
      if (e.name === 'AbiFunctionSignatureNotFoundError' || (e.message && e.message.includes('not found on ABI'))) {
        // Ignored: The wallet called a function on the router that we don't track (e.g. approve, unwrapWETH, etc)
      } else {
        console.error(`[Tracker] Failed to decode calldata for wallet ${fromAddress}`, e);
      }
    }
  }

  private decodeAndClassifySwap(calldata: Hex, walletAddress: string, routerAddress: string | undefined, trackedWallet: any, timestamp: number) {
    // ABI for Universal Router and SwapRouter02
    const routerAbi = parseAbi([
      // SwapRouter02 exactInputSingle
      'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
      'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)',
      'function multicall(bytes[] data) external payable returns (bytes[] results)',
      
      // Universal Router execute
      'function execute(bytes commands, bytes[] inputs) external payable',
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
    ]);

    const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
    const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Sample USDC for classification

    try {
      const decoded = decodeFunctionData({
        abi: routerAbi,
        data: calldata
      });

      if (decoded.functionName === 'exactInputSingle') {
        const params = (decoded.args[0] as any);
        const tokenIn = params.tokenIn.toLowerCase();
        const tokenOut = params.tokenOut.toLowerCase();
        const amountIn = BigInt(params.amountIn);

        this.emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp);
      } else if (decoded.functionName === 'multicall') {
        const multicallData = decoded.args[0] as Hex[];
        for (const data of multicallData) {
          try {
            const innerDecoded = decodeFunctionData({ abi: routerAbi, data });
            if (innerDecoded.functionName === 'exactInputSingle') {
              const params = (innerDecoded.args[0] as any);
              const tokenIn = params.tokenIn.toLowerCase();
              const tokenOut = params.tokenOut.toLowerCase();
              const amountIn = BigInt(params.amountIn);
              this.emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp);
            }
          } catch (err) {
            // multicall might contain non-exactInputSingle commands (like refundETH), ignore
          }
        }
      } else if (decoded.functionName === 'execute') {
        // Universal Router (V3 Swap commands) - requires more complex parsing of `commands` bytes
        // For simplicity in v1, we focus on SwapRouter02 exactInputSingle wrapper decoding
        // Full Universal Router parsing can be added as a separate module
        console.log(`[Tracker] Universal Router 'execute' detected but not fully decoded in this version.`);
      }
    } catch (error: any) {
      if (error.name === 'AbiFunctionSignatureNotFoundError' || (error.message && error.message.includes('not found on ABI'))) {
        // Ignored: Non-swap router call
      } else {
        console.warn(`[Tracker] Unrecognized SwapRouter calldata: ${error}`);
      }
    }
  }

  private emitSignal(tokenIn: string, tokenOut: string, amountIn: bigint, walletAddress: string, trackedWallet: any, timestamp: number) {
    const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
    
    // Classification
    if (tokenIn === WETH_ADDRESS) {
      // BUY tokenOut
      console.log(`[Tracker] 🛒 BUY Signal: ${walletAddress} bought ${tokenOut}`);
      
      // Track buy time for anti-farm
      this.lastBuyTime.set(`${walletAddress}-${tokenOut}`, timestamp);

      if (this.onCopyBuySignal) {
        this.onCopyBuySignal(walletAddress, tokenOut, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp);
      }
    } else if (tokenOut === WETH_ADDRESS) {
      // SELL tokenIn
      console.log(`[Tracker] 💥 SELL Signal: ${walletAddress} sold ${tokenIn}`);
      
      // Anti-farm check
      const buyTime = this.lastBuyTime.get(`${walletAddress}-${tokenIn}`);
      if (buyTime && (timestamp - buyTime < 120000)) {
        console.warn(`[Tracker] 🚨 ANTI-FARM TRIGGERED: ${walletAddress} bought and sold ${tokenIn} within 2 mins! Demoting to Tier 3.`);
        prisma.trackedWallet.update({
          where: { address: walletAddress },
          data: { tier: 3 }
        }).catch(e => console.error("Failed to demote wallet", e));
      }

      if (this.onCopySellSignal) {
        this.onCopySellSignal(walletAddress, tokenIn, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp);
      }
    }
  }
}
