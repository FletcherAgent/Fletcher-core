import { encodeFunctionData, encodeAbiParameters, decodeAbiParameters, parseAbiParameters, parseAbi, parseEther, concat, toHex, pad, erc20Abi, decodeEventLog } from 'viem';
import { detectBestFee } from '../services/poolFeeDetector.js';
import { dbLogger } from '../services/logger.js';
import { Bot, InlineKeyboard } from 'grammy';
import { prisma } from '../core/db.js';
import { publicClient, walletClient, account } from '../services/viem.js';

export class TraderAgent {
  private bot: Bot;
  public executionMode: 'AUTO' | 'CONFIRM' = 'AUTO';
  private pendingTrades: Map<string, { calldata: string, value: bigint, toAddress: `0x${string}`, expectedOut: bigint, amountOutMinimum: bigint, tokenAddress: string, sizeInWeth: bigint, timeoutId: NodeJS.Timeout, source: string, copiedFrom?: string }> = new Map();

  constructor(bot: Bot) {
    this.bot = bot;

    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data.startsWith('confirm_')) {
        const tradeId = data.replace('confirm_', '');
        await ctx.answerCallbackQuery({ text: "Executing Trade..." });
        await this.executePendingTrade(tradeId, ctx.chat?.id);
      } else if (data.startsWith('reject_')) {
        const tradeId = data.replace('reject_', '');
        await ctx.answerCallbackQuery({ text: "Trade Rejected" });
        this.cancelPendingTrade(tradeId, ctx.chat?.id, "Manually rejected by user.");
      }
    });
  }

  private async getTradingMode(): Promise<string> {
    const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    return config ? config.value : 'LIVE';
  }

  public async processSignal(tokenAddress: string, sizeInWeth: bigint, source: string = 'SCOUT', copiedFrom?: string, txHash?: string) {
    const tradeId = Math.random().toString(36).substring(7);
    console.log(`[Trader] Processing Signal for ${tokenAddress} - Size: ${sizeInWeth}`);
    if (!walletClient || !account) {
      console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
      return;
    }
    
    const calldataResult = await this.constructUnsignedSwapTx(tokenAddress, sizeInWeth, txHash);
    if (calldataResult) {
      const { calldata, amountOutMinimum, expectedOut, toAddress, value } = calldataResult;
      
      try {
        if (this.executionMode === 'CONFIRM' && process.env.TELEGRAM_CHAT_ID) {
          const timeoutId = setTimeout(() => {
            this.cancelPendingTrade(tradeId, Number(process.env.TELEGRAM_CHAT_ID), "Timeout (5 mins) reached.");
          }, 5 * 60 * 1000);

          this.pendingTrades.set(tradeId, { 
            calldata, value, toAddress, 
            amountOutMinimum, expectedOut, tokenAddress, sizeInWeth, timeoutId,
            source, copiedFrom
          });

          const keyboard = new InlineKeyboard()
            .text("✅ Confirm Buy", `confirm_${tradeId}`)
            .text("❌ Reject", `reject_${tradeId}`);
          
          await this.bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚨 **PENDING BUY**\nToken: \`${tokenAddress}\`\nSize: \`${Number(sizeInWeth)/1e18} WETH\`\n\nDo you want to execute this trade?`, { parse_mode: 'Markdown', reply_markup: keyboard });
          return;
        }

        if (!walletClient || !account) throw new Error("WalletClient is null");
        const mode = await this.getTradingMode();
        let txHash: `0x${string}`;
        let receiptStatus: 'success' | 'reverted' = 'success';
        let blockNumber = 0n;
        
        if (mode === 'DRY_RUN') {
          console.log(`[Trader] 🛡️ DRY RUN: Simulating BUY transaction for ${tokenAddress}...`);
          txHash = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}` as `0x${string}`;
          blockNumber = await publicClient.getBlockNumber();
        } else {
          console.log(`[Trader] ⚡ Broadcasting BUY transaction for ${tokenAddress}...`);
          txHash = await walletClient.sendTransaction({
            account,
            to: toAddress,
            data: calldata as `0x${string}`,
            value: value
          });
          console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
        }
        
        const estimatedEntryPrice = Number(sizeInWeth) / Number(expectedOut || 1n);
        await this.registerPendingPosition(tokenAddress, estimatedEntryPrice, Number(sizeInWeth) / 1e18, txHash, source, copiedFrom);

        if (mode === 'DRY_RUN') {
          receiptStatus = 'success';
        } else {
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          receiptStatus = receipt.status;
          blockNumber = receipt.blockNumber;
        }

        if (receiptStatus === 'success') {
          console.log(`[Trader] 🎯 BUY TX Confirmed in block ${blockNumber}`);
          dbLogger.info(`BUY TX Confirmed`, { txHash, token: tokenAddress, block: blockNumber.toString(), sizeEth: (Number(sizeInWeth) / 1e18).toFixed(6), mode });
          this.emitToSigningBoundary(tokenAddress, txHash, 'BUY EXECUTED');
          await this.confirmPosition(txHash);
        } else {
          await this.failPendingPosition(txHash);
          throw new Error('Transaction reverted by network');
        }
      } catch (error) {
        console.error(`[Trader] ❌ BUY TX Failed:`, error);
        dbLogger.error(`BUY TX Failed`, { token: tokenAddress, error: String(error) });
        this.emitToSigningBoundary(tokenAddress, "FAILED", 'BUY REJECTED');
      }
    }
  }

  public async executePendingTrade(tradeId: string, chatId?: number) {
    const trade = this.pendingTrades.get(tradeId);
    if (!trade) {
      if (chatId) await this.bot.api.sendMessage(chatId, `❌ Trade ${tradeId} not found or expired.`);
      return;
    }

    clearTimeout(trade.timeoutId);
    this.pendingTrades.delete(tradeId);

    try {
      const mode = await this.getTradingMode();
      let txHash: `0x${string}`;
      let receiptStatus: 'success' | 'reverted' = 'success';
      let blockNumber = 0n;

      if (mode === 'DRY_RUN') {
        console.log(`[Trader] 🛡️ DRY RUN: Simulating CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
        txHash = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}` as `0x${string}`;
        blockNumber = await publicClient.getBlockNumber();
        if (chatId) await this.bot.api.sendMessage(chatId, `🚀 **DRY RUN TX Simulated!**\nHash: \`${txHash}\``, { parse_mode: 'Markdown' });
      } else {
        console.log(`[Trader] ⚡ Broadcasting CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
        txHash = await walletClient!.sendTransaction({
          account: account!,
          to: trade.toAddress,
          data: trade.calldata as `0x${string}`,
          value: trade.value
        });
        console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
        if (chatId) await this.bot.api.sendMessage(chatId, `🚀 **TX Broadcasted!**\nHash: \`${txHash}\`\nWaiting for block confirmation...`, { parse_mode: 'Markdown' });
      }
      
      const estimatedEntryPrice = Number(trade.sizeInWeth) / Number(trade.expectedOut || 1n); 
      await this.registerPendingPosition(trade.tokenAddress, estimatedEntryPrice, Number(trade.sizeInWeth) / 1e18, txHash, trade.source, trade.copiedFrom);

      if (mode === 'DRY_RUN') {
        receiptStatus = 'success';
      } else {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        receiptStatus = receipt.status;
        blockNumber = receipt.blockNumber;
      }

      if (receiptStatus === 'success') {
        console.log(`[Trader] 🎯 BUY TX Confirmed in block ${blockNumber}`);
        this.emitToSigningBoundary(trade.tokenAddress, txHash, 'BUY EXECUTED');
        await this.confirmPosition(txHash);
        if (chatId) await this.bot.api.sendMessage(chatId, `✅ **Trade Confirmed!**\nBlock: ${blockNumber}`);
      } else {
        await this.failPendingPosition(txHash);
        throw new Error('Transaction reverted by network');
      }
    } catch (error) {
      console.error(`[Trader] ❌ BUY TX Failed:`, error);
      this.emitToSigningBoundary(trade.tokenAddress, "FAILED", 'BUY REJECTED');
      if (chatId) await this.bot.api.sendMessage(chatId, `❌ **Trade Failed!**\nReason: ${(error as Error).message}`);
    }
  }

  public cancelPendingTrade(tradeId: string, chatId?: number, reason?: string) {
    const trade = this.pendingTrades.get(tradeId);
    if (trade) {
      clearTimeout(trade.timeoutId);
      this.pendingTrades.delete(tradeId);
      if (chatId) {
        this.bot.api.sendMessage(chatId, `🗑️ Trade Cancelled.\nReason: ${reason || 'Unknown'}`).catch(console.error);
      }
    }
  }
  public async processExitSignal(posId: string, tokenAddress: string, amountInToken: bigint, reason: string, txHash?: string) {
    if (!walletClient || !account) {
      console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
      await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
      return;
    }
    
    const calldataResult = await this.constructUnsignedSellTx(tokenAddress, amountInToken, txHash);
    if (calldataResult) {
      const { calldata, amountOutMinimum, expectedOut, toAddress } = calldataResult;
      
      try {
        const estimatedExitPrice = Number(expectedOut || 1n) / Number(amountInToken || 1n);
        const mode = await this.getTradingMode();
        let txHashFinal: `0x${string}`;
        let receiptStatus: 'success' | 'reverted' = 'success';
        let blockNumber = 0n;

        if (mode === 'DRY_RUN') {
          console.log(`[Trader] 🛡️ DRY RUN: Simulating SELL transaction for ${tokenAddress}...`);
          txHashFinal = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}` as `0x${string}`;
          blockNumber = await publicClient.getBlockNumber();
        } else {
          // --- 0. Check and Approve Allowance ---
          const currentAllowance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account!.address, toAddress]
          });

          if (currentAllowance < amountInToken) {
            console.log(`[Trader] 🔓 Approving Router to spend ${tokenAddress}...`);
            const approveData = encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [toAddress, 2n ** 256n - 1n] // MaxUint256
            });
            const approveTxHash = await walletClient!.sendTransaction({
              account: account!,
              to: tokenAddress as `0x${string}`,
              data: approveData
            });
            await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
            console.log(`[Trader] ✅ Approve confirmed!`);
          }

          console.log(`[Trader] ⚡ Broadcasting SELL transaction for ${tokenAddress}...`);
          txHashFinal = await walletClient!.sendTransaction({
            account: account!,
            to: toAddress,
            data: calldata as `0x${string}`
          });
          
          console.log(`[Trader] ✅ SELL TX Broadcasted: ${txHashFinal}. Waiting for confirmation...`);
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHashFinal });
          receiptStatus = receipt.status;
          blockNumber = receipt.blockNumber;
        }

        if (receiptStatus === 'success') {
          console.log(`[Trader] 🎯 SELL TX Confirmed in block ${blockNumber}`);
          dbLogger.info(`SELL TX Confirmed`, { txHash: txHashFinal, token: tokenAddress, block: blockNumber.toString(), reason, mode });
          this.emitToSigningBoundary(tokenAddress, txHashFinal, `SELL EXECUTED [${reason}]`);

          await this.updatePositionStatus(posId, tokenAddress, estimatedExitPrice);
        } else {
          throw new Error('Transaction reverted by network');
        }
      } catch (error) {
        console.error(`[Trader] ❌ SELL TX Failed:`, error);
        dbLogger.error(`SELL TX Failed`, { token: tokenAddress, error: String(error) });
        this.emitToSigningBoundary(tokenAddress, "FAILED", 'SELL REJECTED');
        
        if (reason === 'UNSUPPORTED_OR_RUG_NO_QUOTES') {
           console.log(`[Trader] 🚮 Token is a rug/unsupported. Marking position as CLOSED (100% loss) to clear it.`);
           const pos = await prisma.position.findUnique({ where: { id: posId } });
           if (pos) {
             await prisma.position.update({
               where: { id: posId },
               data: { status: 'CLOSED', pnl: -1, exitPrice: 0 }
             }).catch(console.error);
           }
        } else {
           await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
        }
      }
    } else {
      console.error(`[Trader] ❌ Failed to construct SELL calldata for ${tokenAddress}. Marking as EXIT_FAILED.`);
      await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
    }
  }

  /**
   * Constructs a BUY transaction payload using Universal Router v4 execute().
   * Uses NOXA dynamic duplication if txHash points to a NOXA swap.
   */
  public async constructUnsignedSwapTx(tokenOut: string, amountIn: bigint, txHash?: string): Promise<{ calldata: string, amountOutMinimum: bigint, expectedOut: bigint, toAddress: `0x${string}`, value: bigint } | null> {
    console.log(`[Trader] Constructing BUY calldata for WETH -> ${tokenOut}...`);

    const WETH_ADDRESS = process.env.WETH_ADDRESS;
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
    const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
    const USER_WALLET = process.env.USER_WALLET_ADDRESS;

    if (!WETH_ADDRESS || !QUOTER_ADDRESS || !ROUTER_ADDRESS || !USER_WALLET) {
      throw new Error('❌ CRITICAL: WETH_ADDRESS, QUOTER_ADDRESS, ROUTER_ADDRESS, or USER_WALLET_ADDRESS missing in .env');
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins

    // --- NOXA DYNAMIC DUPLICATION (Fallback) ---
    if (txHash) {
      try {
        console.log(`[Trader] Attempting NOXA Dynamic Duplication from ${txHash}...`);
        const originalTx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
        if (originalTx && originalTx.input.startsWith('0xc1120e3d') && originalTx.to?.toLowerCase() === '0xf193ede778a92dc37cb450a1ef1565ed1e8b7964') {
          console.log(`[Trader] 🎯 NOXA Transaction Detected! Slicing calldata...`);
          // The calldata is: 0xc1120e3d + 10 words (320 bytes = 640 hex chars)
          // Word 4 (index 4) is minOut. Word 5 is recipient.
          // Let's decode it fully using ABI
          const noxaAbiParams = parseAbiParameters('address, address, address, uint256, uint256, address, uint256, uint256, uint256, uint256');
          const decodedParams = decodeAbiParameters(noxaAbiParams, `0x${originalTx.input.slice(10)}`) as any;
          
          // Calculate proportional minOut
          const originalAmountIn = originalTx.value;
          let calculatedMinOut = 0n;
          if (originalAmountIn > 0n) {
            calculatedMinOut = (BigInt(decodedParams[4]) * amountIn) / originalAmountIn;
          }
          const slippageMinOut = (calculatedMinOut * 99n) / 100n; // 1% extra slippage

          // Replace Recipient (Word 5) and minOut (Word 4)
          decodedParams[4] = slippageMinOut;
          decodedParams[5] = USER_WALLET as `0x${string}`;
          decodedParams[6] = deadline;

          const newCalldata = concat(['0xc1120e3d', encodeAbiParameters(noxaAbiParams, decodedParams as any)]);
          console.log(`[Trader] ✅ NOXA Calldata Cloned! Expected MinOut: ${slippageMinOut}`);
          
          return {
            calldata: newCalldata,
            amountOutMinimum: slippageMinOut,
            expectedOut: calculatedMinOut,
            toAddress: originalTx.to,
            value: amountIn
          };
        }
      } catch (err) {
        console.warn(`[Trader] NOXA Duplication failed, falling back to Universal Router...`, err);
      }
    }
    // -------------------------------------------

    try {
      // 1. Fetch Total Supply for 2% Cap check
      const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)']);
      let totalSupply = 0n;
      try {
        totalSupply = await publicClient.readContract({
          address: tokenOut as `0x${string}`,
          abi: erc20Abi,
          functionName: 'totalSupply'
        }) as bigint;
      } catch { console.warn(`[Trader] Could not fetch totalSupply for ${tokenOut}`); }

      // 2. Detect best pool fee tier dynamically
      const { fee: POOL_FEE, expectedOut: rawExpectedOut } = await detectBestFee(
        WETH_ADDRESS, tokenOut, amountIn
      );
      let expectedOut = rawExpectedOut;

      // 3. 2% Supply Cap
      if (totalSupply > 0n && expectedOut > 0n) {
        const twoPercent = (totalSupply * 2n) / 100n;
        if (expectedOut > twoPercent) {
          console.warn(`[Trader] 🚨 2% CAP HIT! Clamping size...`);
          amountIn = (amountIn * twoPercent) / expectedOut;
          expectedOut = twoPercent;
        }
      }

      // 4. Slippage Protection (1%)
      if (expectedOut === 0n) {
        throw new Error('No active pool found (expectedOut = 0). Aborting to prevent TX revert.');
      }
      const amountOutMinimum = (expectedOut * 99n) / 100n;
      console.log(`[Trader] 🛡️ BUY amountOutMinimum: ${amountOutMinimum}`);

      // 5. Encode Universal Router execute() payload for Uniswap V4
      // Command 0x10 = V4_SWAP
      const commands = '0x10' as `0x${string}`;

      // In Universal Router, V4_SWAP input is abi.encode(IV4Router.ExactInputSingleParams)
      // ExactInputSingleParams = (PoolKey key, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)
      // PoolKey = (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
      
      const isZeroForOne = BigInt(WETH_ADDRESS) < BigInt(tokenOut);
      const currency0 = isZeroForOne ? WETH_ADDRESS : tokenOut;
      const currency1 = isZeroForOne ? tokenOut : WETH_ADDRESS;
      let tickSpacing = 60;
      if (POOL_FEE === 500) tickSpacing = 10;
      else if (POOL_FEE === 10000) tickSpacing = 200;

      const exactInputSingleParamsAbi = [{
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: [ { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' } ] },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' }
        ]
      }];
      
      const swapInput = encodeAbiParameters(exactInputSingleParamsAbi as any, [
        {
          poolKey: {
            currency0: currency0 as `0x${string}`,
            currency1: currency1 as `0x${string}`,
            fee: POOL_FEE,
            tickSpacing,
            hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`
          },
          zeroForOne: isZeroForOne,
          amountIn,
          amountOutMinimum,
          hookData: '0x' as `0x${string}`
        }
      ]);

      const universalRouterAbi = parseAbi([
        'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
      ]);

      const calldata = encodeFunctionData({
        abi: universalRouterAbi,
        functionName: 'execute',
        args: [commands, [swapInput], deadline]
      });

      console.log(`[Trader] ✅ BUY Calldata (Universal Router V4): ${calldata.substring(0, 66)}...`);
      return { calldata, amountOutMinimum, expectedOut, toAddress: ROUTER_ADDRESS as `0x${string}`, value: amountIn };

    } catch (error) {
      console.error('[Trader] Failed to build BUY calldata:', error);
      return null;
    }
  }

  /**
   * Constructs a SELL transaction payload using Universal Router v4 execute().
   * Command 0x00 = V3_SWAP_EXACT_IN: tokenIn -> WETH
   */
  public async constructUnsignedSellTx(tokenIn: string, amountIn: bigint, txHash?: string): Promise<{ calldata: string, amountOutMinimum: bigint, expectedOut: bigint, toAddress: `0x${string}` } | null> {
    console.log(`[Trader] Constructing Universal Router SELL calldata for ${tokenIn} -> WETH...`);

    const WETH_ADDRESS = process.env.WETH_ADDRESS;
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
    const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
    const USER_WALLET = process.env.USER_WALLET_ADDRESS;

    if (!WETH_ADDRESS || !QUOTER_ADDRESS || !ROUTER_ADDRESS || !USER_WALLET) {
      throw new Error('❌ CRITICAL: Missing env variables for SELL tx construction.');
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5);

    if (txHash) {
      try {
        console.log(`[Trader] Attempting Dynamic Duplication for SELL from ${txHash}...`);
        const originalTx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
        
        if (originalTx && originalTx.to) {
           const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
           const erc20AbiForLog = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
           
           let originalAmountIn = 0n;
           for (const log of receipt.logs) {
             if (log.address.toLowerCase() === tokenIn.toLowerCase()) {
               try {
                 const decoded = decodeEventLog({ abi: erc20AbiForLog, data: log.data, topics: log.topics });
                 if ((decoded.args as any).from.toLowerCase() === originalTx.from.toLowerCase()) {
                   originalAmountIn = (decoded.args as any).value as bigint;
                   break;
                 }
               } catch(e) {}
             }
           }

           if (originalAmountIn > 0n) {
             const origHex = originalAmountIn.toString(16).padStart(64, '0');
             const newHex = amountIn.toString(16).padStart(64, '0');
             const zeroHex = '0000000000000000000000000000000000000000000000000000000000000000';
             
             let modifiedInput: string = originalTx.input;
             const index = modifiedInput.indexOf(origHex);
             if (index !== -1) {
                modifiedInput = modifiedInput.substring(0, index) + newHex + modifiedInput.substring(index + 64);
                
                // Zero out the next 32-bytes (amountOutMinimum) to bypass slippage errors
                const nextIndex = index + 64;
                if (nextIndex + 64 <= modifiedInput.length) {
                  modifiedInput = modifiedInput.substring(0, nextIndex) + zeroHex + modifiedInput.substring(nextIndex + 64);
                }
                
                console.log(`[Trader] ✅ Dynamic Duplication SUCCESS. Replaced amountIn & amountOutMinimum.`);
                return {
                  calldata: modifiedInput as `0x${string}`,
                  amountOutMinimum: 0n,
                  expectedOut: 1n,
                  toAddress: originalTx.to
                };
             }
           }
        }
      } catch(e) {
        console.error(`[Trader] Dynamic Duplication failed for SELL:`, e);
      }
    }

    try {
      // 1. Detect best pool fee tier dynamically
      let POOL_FEE = 10000;
      let expectedOut = 0n;
      let useNative = false;
      
      try {
        const best = await detectBestFee(tokenIn, WETH_ADDRESS, amountIn);
        POOL_FEE = best.fee;
        expectedOut = best.expectedOut;
      } catch (e) {
        console.warn(`[Trader] Quoter failed for WETH. Trying Native... or falling back to default fee 10000.`);
        useNative = true;
        POOL_FEE = 10000;
        expectedOut = 1n; // Bypass slippage to guarantee execution
      }

      // 2. Slippage Protection (1%)
      const amountOutMinimum = expectedOut > 1n ? (expectedOut * 99n) / 100n : 0n;
      console.log(`[Trader] 🛡️ SELL amountOutMinimum: ${amountOutMinimum}`);

      // 3. Encode Universal Router execute() payload for Uniswap V4
      // Command 0x10 = V4_SWAP
      const commands = '0x10' as `0x${string}`;

      const TARGET_OUT = useNative ? '0x0000000000000000000000000000000000000000' : WETH_ADDRESS;
      const isZeroForOne = BigInt(tokenIn) < BigInt(TARGET_OUT);
      const currency0 = isZeroForOne ? tokenIn : TARGET_OUT;
      const currency1 = isZeroForOne ? TARGET_OUT : tokenIn;
      
      let tickSpacing = 60;
      if (POOL_FEE === 500) tickSpacing = 10;
      else if (POOL_FEE === 10000) tickSpacing = 200;

      const exactInputSingleParamsAbi = [{
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: [ { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' } ] },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' }
        ]
      }];
      
      const swapInput = encodeAbiParameters(exactInputSingleParamsAbi as any, [
        {
          poolKey: {
            currency0: currency0 as `0x${string}`,
            currency1: currency1 as `0x${string}`,
            fee: POOL_FEE,
            tickSpacing,
            hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`
          },
          zeroForOne: isZeroForOne,
          amountIn,
          amountOutMinimum,
          hookData: '0x' as `0x${string}`
        }
      ]);

      const universalRouterAbi = parseAbi([
        'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
      ]);

      const calldata = encodeFunctionData({
        abi: universalRouterAbi,
        functionName: 'execute',
        args: [commands, [swapInput], deadline]
      });

      console.log(`[Trader] ✅ SELL Calldata (Universal Router): ${calldata.substring(0, 66)}...`);
      return { calldata, amountOutMinimum, expectedOut, toAddress: ROUTER_ADDRESS as `0x${string}` };

    } catch (error) {
      console.error('[Trader] Failed to build SELL calldata:', error);
      return null;
    }
  }

  /**
   * Registers the position in the database after successful execution.
  /**
   * Registers a position in PENDING state before tx confirmation
   */
  public async registerPendingPosition(tokenAddress: string, entryPrice: number, size: number, txHash: string, source: string = "SCOUT", copiedFrom?: string) {
    try {
      let tokenName = null;
      let tokenSymbol = null;
      try {
        const [name, symbol] = await Promise.all([
          publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
          publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' })
        ]);
        tokenName = name as string;
        tokenSymbol = symbol as string;
      } catch (e) {
        console.warn(`[Trader] Could not fetch name/symbol for ${tokenAddress}`);
      }

      const position = await prisma.position.create({
        data: {
          tokenAddress,
          tokenName,
          tokenSymbol,
          type: 'TRENCH',
          status: 'PENDING',
          entryPrice,
          size,
          txHash,
          source,
          copiedFrom,
          tradingMode: await this.getTradingMode()
        }
      });
      console.log(`[Trader] 💾 DB UPDATE: Position registered as PENDING -> ID: ${position.id}, txHash: ${txHash}`);
    } catch (error) {
      console.error("[Trader] Failed to register pending position in DB", error);
    }
  }

  public async confirmPosition(txHash: string) {
    try {
      await prisma.position.updateMany({
        where: { txHash, status: 'PENDING' },
        data: { status: 'OPEN' }
      });
      console.log(`[Trader] 💾 DB UPDATE: Position confirmed to OPEN for txHash: ${txHash}`);
    } catch (error) {
      console.error("[Trader] Failed to confirm position in DB", error);
    }
  }

  public async failPendingPosition(txHash: string) {
    try {
      await prisma.position.updateMany({
        where: { txHash, status: 'PENDING' },
        data: { status: 'FAILED' }
      });
      console.log(`[Trader] 💾 DB UPDATE: Position marked as FAILED for txHash: ${txHash}`);
    } catch (error) {
      console.error("[Trader] Failed to fail position in DB", error);
    }
  }

  public async recoverPendingTrades() {
    console.log(`[Trader] 🔄 Running recovery for PENDING trades...`);
    try {
      const pendingPositions = await prisma.position.findMany({ where: { status: 'PENDING' } });
      for (const pos of pendingPositions) {
        if (!pos.txHash) continue;
        
        console.log(`[Trader] 🔍 Checking pending txHash ${pos.txHash} for ${pos.tokenAddress}...`);
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: pos.txHash as `0x${string}` });
          if (receipt.status === 'success') {
            console.log(`[Trader] 🎯 Recovered BUY TX Confirmed for ${pos.tokenAddress}`);
            await this.confirmPosition(pos.txHash);
            dbLogger.info(`BUY TX Recovered & Confirmed`, { txHash: pos.txHash, token: pos.tokenAddress });
          } else {
            console.log(`[Trader] ❌ Recovered BUY TX Reverted for ${pos.tokenAddress}`);
            await this.failPendingPosition(pos.txHash);
          }
        } catch (e) {
          console.warn(`[Trader] ⏳ TX ${pos.txHash} still pending or not found.`);
        }
      }
    } catch (e) {
      console.error("[Trader] Failed to recover pending trades", e);
    }
  }

  /**
   * Updates a position's status to CLOSED in the database.
   */
  public async updatePositionStatus(posId: string, tokenAddress: string, exitPrice: number) {
    try {
      const position = await prisma.position.findUnique({
        where: { id: posId }
      });
      if (position) {
        const pnlRatio = (exitPrice - position.entryPrice) / position.entryPrice;
        
        await prisma.position.update({
          where: { id: position.id },
          data: { status: 'CLOSED', exitPrice, pnl: pnlRatio }
        });
        console.log(`[Trader] 💾 DB UPDATE: Position ${position.id} CLOSED in DB. PNL: ${(pnlRatio*100).toFixed(2)}%`);

        if (position.source === 'COPYTRADE' && position.copiedFrom) {
          const isWin = pnlRatio > 0;
          
          const wallet = await prisma.trackedWallet.findUnique({ where: { address: position.copiedFrom } });
          if (wallet) {
            const newTotal = wallet.copiedSignals + 1;
            const currentWins = ((wallet.winRate || 0) / 100) * wallet.copiedSignals;
            const newWinRate = ((currentWins + (isWin ? 1 : 0)) / newTotal) * 100;
            
            const currentAvgPnl = wallet.avgPnlR || 0;
            const newAvgPnl = ((currentAvgPnl * wallet.copiedSignals) + pnlRatio) / newTotal;

            let newTier = wallet.tier;
            if (newTotal >= 5) {
              if (newWinRate < 35 && wallet.tier < 3) newTier = 3;
              else if (newWinRate >= 55 && wallet.tier > 1) newTier = 1;
            }

            let newConsecutiveLosses = isWin ? 0 : wallet.consecutiveLosses + 1;
            let newStatus = wallet.status;

            if (newConsecutiveLosses >= 3) {
              newStatus = 'PAUSED';
              const emergencyMsg = `EMERGENCY: Wallet ${wallet.address} hit 3 consecutive losses. Status set to PAUSED.`;
              console.error(`[Trader] 🚨 ` + emergencyMsg);
              dbLogger.error(emergencyMsg, { wallet: wallet.address, consecutiveLosses: newConsecutiveLosses });
            }

            await prisma.trackedWallet.update({
              where: { address: wallet.address },
              data: {
                copiedSignals: newTotal,
                winRate: newWinRate,
                avgPnlR: newAvgPnl,
                tier: newTier,
                consecutiveLosses: newConsecutiveLosses,
                status: newStatus
              }
            });
            console.log(`[Trader] 📊 Updated stats for wallet ${wallet.address}: WinRate ${newWinRate.toFixed(2)}%, Avg PNL ${newAvgPnl.toFixed(4)}. Tier is now ${newTier}, Status: ${newStatus}`);
          }
        }
      }
    } catch (e) {
      console.error("[Trader] Failed to update position in DB", e);
    }
  }

  private emitToSigningBoundary(tokenAddress: string, txHash: string, action: string) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    console.log(`[Notification] Auto-Trade executed: ${action} for ${tokenAddress}. Hash: ${txHash}`);
    
    if (chatId) {
      let msg = `🤖 *AUTO-TRADE EXECUTED*\n\nAction: **${action}**\nToken: \`${tokenAddress}\``;
      if (txHash !== "FAILED") {
        msg += `\n\n✅ Transaction Hash:\n\`${txHash}\``;
      } else {
        msg += `\n\n❌ Transaction Failed (Reverted/Error)`;
      }

      this.bot.api.sendMessage(
        chatId,
        msg,
        { parse_mode: "Markdown" }
      ).catch(err => console.error("[Trader] Failed to send Telegram message", err));
    } else {
      console.warn("[Trader] TELEGRAM_CHAT_ID is not set in .env! Cannot send execution message.");
    }
  }
}
