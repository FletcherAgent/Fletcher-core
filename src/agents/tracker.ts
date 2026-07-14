import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parseAbi, decodeFunctionData, decodeAbiParameters, parseAbiParameters, Hex } from 'viem';
import { prisma } from '../core/db.js';
import { dbLogger } from '../services/logger.js';
import { WalletProfiler } from '../services/walletProfiler.js';

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
          const [wallets, signals, positions, logs] = await Promise.all([
            prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' } }),
            prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.position.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ wallets, signals, positions, logs }));
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

    // ── Router Whitelist Filter ───────────────────────────────────────────────
    // Only process transactions sent to a KNOWN swap router.
    // This prevents NFT purchases (Seaport), token approvals, and other
    // non-swap calls from reaching the decoder.
    const KNOWN_ROUTERS = new Set([
      (process.env.ROUTER_ADDRESS || '').toLowerCase(),          // Universal Router v4
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',              // SwapRouter02 (legacy fallback)
    ].filter(Boolean));

    if (toAddress && !KNOWN_ROUTERS.has(toAddress)) {
      // Silently skip — we don't care about non-swap txns
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Check if the fromAddress is in our registry
    const trackedWallet = await prisma.trackedWallet.findUnique({
      where: { address: fromAddress }
    });

    if (!trackedWallet || trackedWallet.status !== 'ACTIVE') {
      return; // Not tracked or not active
    }

    console.log(`[Tracker] 🚨 Swap activity detected from: ${trackedWallet.label || fromAddress} → ${toAddress} | TX: https://robinhoodchain.blockscout.com/tx/${activity.hash}`);
    dbLogger.info(`Swap activity detected from: ${trackedWallet.label || fromAddress} → ${toAddress}`, { txHash: activity.hash, wallet: trackedWallet.label || fromAddress });

    const calldata = activity.rawContract?.rawValue as Hex;
    if (!calldata || calldata.length < 10) return;

    try {
      const activityTime = activity.timestamp ? new Date(activity.timestamp).getTime() : Date.now();
      await this.decodeAndClassifySwap(calldata, fromAddress, toAddress, trackedWallet, activityTime, activity.hash);
    } catch (e: any) {
      if (e.name === 'AbiFunctionSignatureNotFoundError' || (e.message && e.message.includes('not found on ABI'))) {
        const sig = calldata.substring(0, 10);
        console.log(`[Tracker] ℹ️ Ignored non-swap calldata from ${trackedWallet.label || fromAddress} (sig: ${sig})`);
      } else {
        console.error(`[Tracker] Failed to decode calldata for wallet ${fromAddress}`, e);
      }
    }
  }

  private async decodeAndClassifySwap(calldata: Hex, walletAddress: string, routerAddress: string | undefined, trackedWallet: any, timestamp: number, txHash: string) {
    // Known router addresses (lowercase) — only decode if the target IS a known router
    const UNIVERSAL_ROUTER = (process.env.ROUTER_ADDRESS || '').toLowerCase();
    const WETH = (process.env.WETH_ADDRESS || '').toLowerCase();

    // === ABI definitions ===
    const swapRouter02Abi = parseAbi([
      'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
      'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)',
      'function multicall(bytes[] data) external payable returns (bytes[] results)',
    ]);

    const universalRouterAbi = parseAbi([
      'function execute(bytes commands, bytes[] inputs) external payable',
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
    ]);

    const funcSig = calldata.substring(0, 10).toLowerCase();

    // ── Universal Router execute() ────────────────────────────────────────────
    // Selector: 0x3593564c (execute with deadline) or 0x24856bc3 (execute without)
    const isUniversalRouter =
      funcSig === '0x3593564c' || funcSig === '0x24856bc3';

    if (isUniversalRouter) {
      try {
        const decoded = decodeFunctionData({ abi: universalRouterAbi, data: calldata });
        const commands = decoded.args[0] as Hex;   // bytes: each byte = 1 command
        const inputs   = decoded.args[1] as Hex[]; // bytes[]: params for each command

        // Convert commands hex string to array of command bytes
        // Skip '0x' prefix, then every 2 chars = 1 byte = 1 command
        const commandBytes = (commands.replace('0x', '').match(/.{1,2}/g) || [])
          .map(b => parseInt(b, 16));

        for (let i = 0; i < commandBytes.length; i++) {
          const cmd = commandBytes[i] & 0x3f; // mask flag bits
          const input = inputs[i];
          if (!input) continue;

          // Command 0x00 = V3_SWAP_EXACT_IN
          // Command 0x01 = V3_SWAP_EXACT_OUT
          if (cmd === 0x00 || cmd === 0x01) {
            await this.processUniversalRouterSwap(input, cmd, walletAddress, trackedWallet, timestamp, txHash);
          } 
          // Command 0x08 = V2_SWAP_EXACT_IN
          // Command 0x09 = V2_SWAP_EXACT_OUT
          else if (cmd === 0x08 || cmd === 0x09) {
            await this.processUniversalRouterSwapV2(input, cmd, walletAddress, trackedWallet, timestamp, txHash);
          } 
          // Command 0x10 = V4_SWAP
          else if (cmd === 0x10) {
            await this.processUniversalRouterSwapV4(input, cmd, walletAddress, trackedWallet, timestamp, txHash);
          }
          else {
            // e.g. 0x0b (WRAP_ETH), 0x0c (UNWRAP_WETH), 0x04 (SWEEP), etc.
            console.log(`[Tracker] ℹ️ UR Ignored Command: 0x${cmd.toString(16)} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
          }
        }
      } catch (err: any) {
        console.warn(`[Tracker] Failed to decode Universal Router execute() | TX: https://robinhoodchain.blockscout.com/tx/${txHash}: ${err.message}`);
      }
      return;
    }

    // ── SwapRouter02 exactInputSingle / multicall ─────────────────────────────
    try {
      const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: calldata });

      if (decoded.functionName === 'exactInputSingle') {
        const params = decoded.args[0] as any;
        this.emitSignal(
          params.tokenIn.toLowerCase(),
          params.tokenOut.toLowerCase(),
          BigInt(params.amountIn),
          walletAddress, trackedWallet, timestamp, txHash
        );

      } else if (decoded.functionName === 'multicall') {
        const multicallData = decoded.args[0] as Hex[];
        for (const data of multicallData) {
          try {
            const inner = decodeFunctionData({ abi: swapRouter02Abi, data });
            if (inner.functionName === 'exactInputSingle') {
              const params = inner.args[0] as any;
              this.emitSignal(
                params.tokenIn.toLowerCase(),
                params.tokenOut.toLowerCase(),
                BigInt(params.amountIn),
                walletAddress, trackedWallet, timestamp, txHash
              );
            }
          } catch { /* non-swap inner calls like refundETH — ignore */ }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbiFunctionSignatureNotFoundError' || (error.message && error.message.includes('not found on ABI'))) {
        const sig = calldata.substring(0, 10);
        console.log(`[Tracker] ℹ️ Ignored non-swap tx from ${trackedWallet.label || walletAddress} (sig: ${sig})`);
      } else {
        console.warn(`[Tracker] Unrecognized calldata: ${error.message}`);
      }
    }
  }

  /**
   * Decodes a single V3_SWAP_EXACT_IN or V3_SWAP_EXACT_OUT input from Universal Router.
   * Layout (ABI-encoded tuple): (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
   */
  private async processUniversalRouterSwap(
    input: Hex,
    cmd: number,
    walletAddress: string,
    trackedWallet: any,
    timestamp: number,
    txHash: string
  ) {
    try {
      // Decode the ABI-encoded input tuple
      // (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
      const [, amountIn, , path] = decodeAbiParameters(
        parseAbiParameters('address, uint256, uint256, bytes, bool'),
        input
      ) as [string, bigint, bigint, Hex, boolean];

      // Decode path: each hop is 20 bytes (address) + 3 bytes (fee) + ... + 20 bytes (address)
      // Minimum path: tokenIn (20) + fee (3) + tokenOut (20) = 43 bytes = 86 hex chars
      const pathHex = (path as string).replace('0x', '');
      if (pathHex.length < 86) return;

      // For V3_SWAP_EXACT_IN: path is tokenIn -> fee -> tokenOut -> ...
      // First token = bytes 0-19 (40 hex chars), last token = last 40 hex chars
      const tokenIn  = ('0x' + pathHex.substring(0, 40)).toLowerCase();
      const tokenOut = ('0x' + pathHex.substring(pathHex.length - 40)).toLowerCase();

      console.log(`[Tracker] 🔍 Universal Router Swap decoded: ${tokenIn} → ${tokenOut} (amountIn: ${amountIn})`);
      this.emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp, txHash);

    } catch (err: any) {
      console.warn(`[Tracker] Could not decode UR swap input: ${err.message}`);
    }
  }

  /**
   * Decodes a single V2_SWAP_EXACT_IN or V2_SWAP_EXACT_OUT input from Universal Router.
   * Layout (ABI-encoded tuple): (address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser)
   */
  private async processUniversalRouterSwapV2(
    input: Hex,
    cmd: number,
    walletAddress: string,
    trackedWallet: any,
    timestamp: number,
    txHash: string
  ) {
    try {
      const [, amountIn, , path] = decodeAbiParameters(
        parseAbiParameters('address, uint256, uint256, address[], bool'),
        input
      ) as [string, bigint, bigint, string[], boolean];

      if (!path || path.length < 2) return;

      const tokenIn = path[0].toLowerCase();
      const tokenOut = path[path.length - 1].toLowerCase();

      console.log(`[Tracker] 🔍 Universal Router V2 Swap decoded: ${tokenIn} → ${tokenOut} (amountIn: ${amountIn})`);
      this.emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp, txHash);
    } catch (err: any) {
      console.warn(`[Tracker] Could not decode UR V2 swap input: ${err.message}`);
    }
  }

  /**
   * Decodes V4_SWAP input from Universal Router (Command 0x10).
   * Parses actions and params to extract the tokens and amountIn for V4_SWAP_EXACT_IN_SINGLE (0x06).
   */
  private async processUniversalRouterSwapV4(
    input: Hex,
    cmd: number,
    walletAddress: string,
    trackedWallet: any,
    timestamp: number,
    txHash: string
  ) {
    try {
      const hex = input.startsWith('0x') ? input.substring(2) : input;
      
      const actionOffset = parseInt(hex.substring(0, 64), 16) * 2;
      const actionLength = parseInt(hex.substring(actionOffset, actionOffset + 64), 16) * 2;
      const actionsHex = hex.substring(actionOffset + 64, actionOffset + 64 + actionLength);
      const actionBytes = (actionsHex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16));

      const paramsOffset = parseInt(hex.substring(64, 128), 16) * 2;
      const paramsCount = parseInt(hex.substring(paramsOffset, paramsOffset + 64), 16);
      const params: string[] = [];

      for (let i = 0; i < paramsCount; i++) {
        const itemOffsetRelative = parseInt(hex.substring(paramsOffset + 64 + (i * 64), paramsOffset + 64 + (i * 64) + 64), 16) * 2;
        // Array offsets are relative to the start of the elements (after the 32-byte length word)
        const itemOffset = paramsOffset + 64 + itemOffsetRelative;
        const itemLength = parseInt(hex.substring(itemOffset, itemOffset + 64), 16) * 2;
        params.push(hex.substring(itemOffset + 64, itemOffset + 64 + itemLength));
      }
      
      for (let i = 0; i < actionBytes.length; i++) {
        const act = actionBytes[i];
        if (act === 0x06 && params[i]) {
          // V4_SWAP_EXACT_IN_SINGLE
          const paramHex = params[i].replace('0x', '');

          // Universal Router tightly packs or offsets the V4 ExactInputSingleParams.
          // Through raw byte analysis, we can extract the values at specific fixed positions:
          // The param data starts with a 32-byte tuple offset (0x0020), so the first struct element starts at 64 chars
          const c0Str = paramHex.substring(64, 128).slice(-40);
          const c1Str = paramHex.substring(128, 192).slice(-40);
          
          const zeroForOne = paramHex.substring(384, 448).endsWith('1');
          
          // Extract amountIn by finding the first non-zero chunk after zeroForOne
          const amountChunk = paramHex.substring(448);
          let amountInStr = '0';
          const match = amountChunk.match(/[1-9a-f][0-9a-f]*/);
          if (match) {
             amountInStr = match[0];
          }
          if (!amountInStr) amountInStr = '0';
          
          const amountIn = BigInt('0x' + amountInStr);

          let tokenInStr = zeroForOne ? c0Str : c1Str;
          let tokenOutStr = zeroForOne ? c1Str : c0Str;

          let tokenIn = '0x' + tokenInStr.toLowerCase();
          let tokenOut = '0x' + tokenOutStr.toLowerCase();
            
          const WETH = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
          
          // In V4, native ETH is represented as address(0)
          if (tokenIn === '0x0000000000000000000000000000000000000000' || tokenIn === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            tokenIn = WETH;
          }
          if (tokenOut === '0x0000000000000000000000000000000000000000' || tokenOut === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            tokenOut = WETH;
          }

          console.log(`[Tracker] 🔍 Universal Router V4 Swap decoded: ${tokenIn} → ${tokenOut} (amountIn: ${amountIn})`);
          this.emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp, txHash);
        }
      }
    } catch (err: any) {
      console.warn(`[Tracker] Could not decode UR V4 swap input | TX: https://robinhoodchain.blockscout.com/tx/${txHash}: ${err.message}`);
    }
  }

  private emitSignal(tokenIn: string, tokenOut: string, amountIn: bigint, walletAddress: string, trackedWallet: any, timestamp: number, txHash: string) {
    const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
    
    // Classification
    if (tokenIn === WETH_ADDRESS) {
      // BUY tokenOut
      console.log(`[Tracker] 🛒 BUY Signal: ${walletAddress} bought ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
      dbLogger.info(`BUY Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenOut, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });
      
      // Async trigger for on-chain profiling
      WalletProfiler.processBuy(walletAddress, tokenOut, txHash);

      // Track buy time for anti-farm
      this.lastBuyTime.set(`${walletAddress}-${tokenOut}`, timestamp);

      if (this.onCopyBuySignal) {
        this.onCopyBuySignal(walletAddress, tokenOut, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp);
      }
    } else if (tokenOut === WETH_ADDRESS) {
      // SELL tokenIn
      console.log(`[Tracker] 💥 SELL Signal: ${walletAddress} sold ${tokenIn} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
      dbLogger.info(`SELL Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenIn, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });
      
      // Async trigger for on-chain profiling
      WalletProfiler.processSell(walletAddress, tokenIn, txHash);

      // Anti-farm check
      const buyTime = this.lastBuyTime.get(`${walletAddress}-${tokenIn}`);
      if (buyTime && (timestamp - buyTime < 120000)) {
        const msg = `Anti-farm triggered: ${trackedWallet.label || walletAddress} flipped ${tokenIn} in < 2 min. Demoting to Tier 3.`;
        console.warn(`[Tracker] 🚨 ` + msg);
        dbLogger.warn(msg, { wallet: walletAddress, token: tokenIn });
        prisma.trackedWallet.update({
          where: { address: walletAddress },
          data: { tier: 3 }
        }).catch(e => console.error("Failed to demote wallet", e));
      }

      if (this.onCopySellSignal) {
        this.onCopySellSignal(walletAddress, tokenIn, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp);
      }
    } else {
      console.log(`[Tracker] 🔄 SWAP Signal: ${walletAddress} swapped ${tokenIn} for ${tokenOut}`);
    }
  }
}
