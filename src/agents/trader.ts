import { encodeFunctionData, parseAbi, parseEther } from 'viem';
import { Bot, InlineKeyboard } from 'grammy';
import { prisma } from '../core/db.js';
import { publicClient, walletClient, account } from '../services/viem.js';

export class TraderAgent {
  private bot: Bot;
  public executionMode: 'AUTO' | 'CONFIRM' = 'AUTO';
  private pendingTrades: Map<string, { calldata: string, value: bigint, toAddress: `0x${string}`, amountOutMinimum: bigint, tokenAddress: string, sizeInWeth: bigint, timeoutId: NodeJS.Timeout }> = new Map();

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

  public async processSignal(tokenAddress: string, sizeInWeth: bigint) {
    if (!walletClient || !account) {
      console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
      return;
    }
    
    const calldataResult = await this.constructUnsignedSwapTx(tokenAddress, sizeInWeth);
    if (calldataResult) {
      const { calldata, amountOutMinimum, toAddress, value } = calldataResult;
      
      try {
        if (this.executionMode === 'CONFIRM' && process.env.TELEGRAM_CHAT_ID) {
          const tradeId = Math.random().toString(36).substring(7);
          const timeoutId = setTimeout(() => {
            this.cancelPendingTrade(tradeId, Number(process.env.TELEGRAM_CHAT_ID), "Timeout (5 mins) reached.");
          }, 5 * 60 * 1000);

          this.pendingTrades.set(tradeId, { 
            calldata: calldataResult.calldata, value: calldataResult.value, toAddress: calldataResult.toAddress, 
            amountOutMinimum: calldataResult.amountOutMinimum, tokenAddress, sizeInWeth, timeoutId 
          });

          const keyboard = new InlineKeyboard()
            .text("✅ Confirm Buy", `confirm_${tradeId}`)
            .text("❌ Reject", `reject_${tradeId}`);
          
          await this.bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚨 **PENDING BUY**\nToken: \`${tokenAddress}\`\nSize: \`${Number(sizeInWeth)/1e18} WETH\`\n\nDo you want to execute this trade?`, { parse_mode: 'Markdown', reply_markup: keyboard });
          return;
        }

        console.log(`[Trader] ⚡ Broadcasting BUY transaction for ${tokenAddress}...`);
        const txHash = await walletClient.sendTransaction({
          account,
          to: toAddress,
          data: calldata as `0x${string}`,
          value: value
        });
        
        console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        if (receipt.status === 'success') {
          console.log(`[Trader] 🎯 BUY TX Confirmed in block ${receipt.blockNumber}`);
          this.emitToSigningBoundary(tokenAddress, txHash, 'BUY EXECUTED');

          const estimatedEntryPrice = Number(sizeInWeth) / Number(amountOutMinimum);
          await this.registerPosition(tokenAddress, estimatedEntryPrice, Number(sizeInWeth) / 1e18);
        } else {
          throw new Error('Transaction reverted by network');
        }
      } catch (error) {
        console.error(`[Trader] ❌ BUY TX Failed:`, error);
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
      console.log(`[Trader] ⚡ Broadcasting CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
      const txHash = await walletClient!.sendTransaction({
        account: account!,
        to: trade.toAddress,
        data: trade.calldata as `0x${string}`,
        value: trade.value
      });
      
      console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
      if (chatId) await this.bot.api.sendMessage(chatId, `🚀 **TX Broadcasted!**\nHash: \`${txHash}\`\nWaiting for block confirmation...`, { parse_mode: 'Markdown' });
      
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        console.log(`[Trader] 🎯 BUY TX Confirmed in block ${receipt.blockNumber}`);
        this.emitToSigningBoundary(trade.tokenAddress, txHash, 'BUY EXECUTED');

        const estimatedEntryPrice = Number(trade.sizeInWeth) / Number(trade.amountOutMinimum || 1n); // Prevent division by zero if amountOutMin is 0
        await this.registerPosition(trade.tokenAddress, estimatedEntryPrice, Number(trade.sizeInWeth) / 1e18);
        if (chatId) await this.bot.api.sendMessage(chatId, `✅ **Trade Confirmed!**\nBlock: ${receipt.blockNumber}`);
      } else {
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

  public async processExitSignal(tokenAddress: string, amountInToken: bigint, reason: string) {
    if (!walletClient || !account) {
      console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
      return;
    }
    
    const calldataResult = await this.constructUnsignedSellTx(tokenAddress, amountInToken);
    if (calldataResult) {
      const { calldata, amountOutMinimum, toAddress } = calldataResult;
      
      try {
        console.log(`[Trader] ⚡ Broadcasting SELL transaction for ${tokenAddress}...`);
        const txHash = await walletClient.sendTransaction({
          account,
          to: toAddress,
          data: calldata as `0x${string}`
        });

        console.log(`[Trader] ✅ SELL TX Broadcasted: ${txHash}. Waiting for confirmation...`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        if (receipt.status === 'success') {
          console.log(`[Trader] 🎯 SELL TX Confirmed in block ${receipt.blockNumber}`);
          this.emitToSigningBoundary(tokenAddress, txHash, `SELL EXECUTED [${reason}]`);

          const estimatedExitPrice = Number(amountOutMinimum) / Number(amountInToken);
          await this.updatePositionStatus(tokenAddress, estimatedExitPrice);
        } else {
          throw new Error('Transaction reverted by network');
        }
      } catch (error) {
        console.error(`[Trader] ❌ SELL TX Failed:`, error);
        this.emitToSigningBoundary(tokenAddress, "FAILED", `SELL REJECTED [${reason}]`);
      }
    }
  }

  /**
   * Constructs an unsigned transaction payload for the user/vault to sign.
   * using Uniswap V3 SwapRouter exactInputSingle
   */
  public async constructUnsignedSwapTx(tokenOut: string, amountIn: bigint): Promise<{ calldata: string, amountOutMinimum: bigint, toAddress: `0x${string}`, value: bigint } | null> {
    console.log(`[Trader] Constructing exactInputSingle calldata for WETH -> ${tokenOut}...`);
    
    // Uniswap V3 exactInputSingle signature
    const exactInputSingleAbi = parseAbi([
      'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
      'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)'
    ]);

    const quoterAbi = parseAbi([
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ]);

    // WETH address on Robinhood Chain (Placeholder, assume standard WETH for now)
    const WETH_ADDRESS = process.env.WETH_ADDRESS!; 
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS!; // Uniswap V3 QuoterV2 (Standard)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins

    let amountOutMinimum = 0n;

    try {
      // 1. Fetch Total Supply for NOXA 2% Cap limit
      const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)']);
      let totalSupply = 0n;
      try {
        totalSupply = await publicClient.readContract({
          address: tokenOut as `0x${string}`,
          abi: erc20Abi,
          functionName: 'totalSupply'
        }) as bigint;
      } catch (e) {
        console.warn(`[Trader] Could not fetch totalSupply for ${tokenOut}`);
      }

      // 2. Simulate via QuoterV2 to get exact output
      let expectedOut = 0n;
      try {
        expectedOut = await publicClient.readContract({
          address: QUOTER_ADDRESS as `0x${string}`,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [WETH_ADDRESS as `0x${string}`, tokenOut as `0x${string}`, 3000, amountIn, 0n]
        }) as bigint;
        console.log(`[Trader] QuoterV2 expected output: ${expectedOut}`);
      } catch (e) {
        console.warn(`[Trader] QuoterV2 simulation failed. Falling back to Sniper Mode.`);
        expectedOut = 0n;
      }

      // 3. NOXA 2% Cap Clamping
      if (totalSupply > 0n && expectedOut > 0n) {
        const twoPercent = (totalSupply * 2n) / 100n;
        if (expectedOut > twoPercent) {
          console.warn(`[Trader] 🚨 2% CAP HIT! Expected ${expectedOut} > Max ${twoPercent}. Clamping size...`);
          // Proportional scale down of amountIn
          amountIn = (amountIn * twoPercent) / expectedOut;
          expectedOut = twoPercent;
          console.log(`[Trader] Adjusted amountIn: ${amountIn}`);
        }
      }

      // 4. Slippage Protection (1%)
      if (expectedOut > 0n) {
        amountOutMinimum = (expectedOut * 99n) / 100n;
        console.log(`[Trader] 🛡️ Slippage protection set. Min out: ${amountOutMinimum}`);
      } else {
        // Fallback
        amountOutMinimum = 0n;
        console.log(`[Trader] 🎯 Sniper fallback: amountOutMinimum = 0`);
      }

      // 5. Encode actual tx
      const calldata = encodeFunctionData({
        abi: exactInputSingleAbi,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: WETH_ADDRESS as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          fee: 3000, // standard 0.3% pool fee, should be dynamic
          recipient: (process.env.USER_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
          deadline,
          amountIn: amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n
        }]
      });

      console.log(`[Trader] Unsigned BUY Calldata generated: ${calldata}`);
      return { calldata, amountOutMinimum, toAddress: process.env.ROUTER_ADDRESS! as `0x${string}`, value: amountIn };

    } catch (error) {
      console.error("[Trader] Failed to build calldata or fetch quote", error);
      return null;
    }
  }

  /**
   * Constructs an unsigned transaction payload to sell the token back to WETH.
   */
  public async constructUnsignedSellTx(tokenIn: string, amountIn: bigint): Promise<{ calldata: string, amountOutMinimum: bigint, toAddress: `0x${string}` } | null> {
    console.log(`[Trader] Constructing exactInputSingle calldata for ${tokenIn} -> WETH...`);
    
    const exactInputSingleAbi = parseAbi([
      'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
      'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)'
    ]);

    const quoterAbi = parseAbi([
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ]);

    const WETH_ADDRESS = process.env.WETH_ADDRESS!; 
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS!;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins

    let amountOutMinimum = 0n;

    try {
      // Simulate via QuoterV2 to get exact output
      let expectedOut = 0n;
      try {
        expectedOut = await publicClient.readContract({
          address: QUOTER_ADDRESS as `0x${string}`,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [tokenIn as `0x${string}`, WETH_ADDRESS as `0x${string}`, 3000, amountIn, 0n]
        }) as bigint;
        console.log(`[Trader] QuoterV2 expected output (SELL): ${expectedOut}`);
      } catch (e) {
        console.warn(`[Trader] QuoterV2 SELL simulation failed.`);
        expectedOut = 0n;
      }

      if (expectedOut > 0n) {
        amountOutMinimum = (expectedOut * 99n) / 100n; // 1% slippage for sells too
        console.log(`[Trader] 🛡️ SELL Slippage protection set. Min out: ${amountOutMinimum}`);
      } else {
        amountOutMinimum = 0n;
        console.log(`[Trader] 🎯 Pure Sniper SELL fallback: amountOutMinimum = 0`);
      }

      const calldata = encodeFunctionData({
        abi: exactInputSingleAbi,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: WETH_ADDRESS as `0x${string}`,
          fee: 3000,
          recipient: (process.env.USER_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
          deadline,
          amountIn: amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n
        }]
      });

      console.log(`[Trader] Unsigned SELL Calldata generated: ${calldata}`);
      return { calldata, amountOutMinimum, toAddress: process.env.ROUTER_ADDRESS! as `0x${string}` };

    } catch (error) {
      console.error("[Trader] Failed to build sell calldata or fetch quote", error);
      return null;
    }
  }

  /**
   * Registers the position in the database after successful execution.
   */
  public async registerPosition(tokenAddress: string, entryPrice: number, size: number) {
    try {
      const position = await prisma.position.create({
        data: {
          tokenAddress,
          type: 'TRENCH',
          status: 'OPEN',
          entryPrice,
          size
        }
      });
      console.log(`[Trader] 💾 DB UPDATE: Position registered -> ID: ${position.id}`);
    } catch (error) {
      console.error("[Trader] Failed to register position in DB", error);
    }
  }

  /**
   * Updates a position's status to CLOSED in the database.
   */
  public async updatePositionStatus(tokenAddress: string, exitPrice: number) {
    try {
      const position = await prisma.position.findFirst({
        where: { tokenAddress, status: 'OPEN' },
        orderBy: { createdAt: 'desc' }
      });
      if (position) {
        await prisma.position.update({
          where: { id: position.id },
          data: { status: 'CLOSED', exitPrice }
        });
        console.log(`[Trader] 💾 DB UPDATE: Position ${position.id} CLOSED in DB.`);
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
