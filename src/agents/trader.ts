import { encodeFunctionData, parseAbi, parseEther } from 'viem';
import { Bot } from 'grammy';
import { prisma } from '../core/db.js';
import { publicClient, walletClient, account } from '../services/viem.js';

export class TraderAgent {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
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
        console.log(`[Trader] ⚡ Broadcasting BUY transaction for ${tokenAddress}...`);
        const txHash = await walletClient.sendTransaction({
          account,
          to: toAddress,
          data: calldata as `0x${string}`,
          value: value
        });
        
        console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}`);
        this.emitToSigningBoundary(tokenAddress, txHash, 'BUY EXECUTED');

        // Simulate successful trade execution and save to DB
        const estimatedEntryPrice = Number(sizeInWeth) / Number(amountOutMinimum);
        await this.registerPosition(tokenAddress, estimatedEntryPrice, Number(sizeInWeth) / 1e18);
      } catch (error) {
        console.error(`[Trader] ❌ BUY TX Failed:`, error);
        this.emitToSigningBoundary(tokenAddress, "FAILED", 'BUY REJECTED');
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

        console.log(`[Trader] ✅ SELL TX Broadcasted: ${txHash}`);
        this.emitToSigningBoundary(tokenAddress, txHash, `SELL EXECUTED [${reason}]`);

        // Simulate successful sell execution and update DB
        const estimatedExitPrice = Number(amountOutMinimum) / Number(amountInToken);
        await this.updatePositionStatus(tokenAddress, estimatedExitPrice);
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
      // 1. Fetch real quote from Quoter
      const { result } = await publicClient.simulateContract({
        address: QUOTER_ADDRESS as `0x${string}`,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [WETH_ADDRESS as `0x${string}`, tokenOut as `0x${string}`, 3000, amountIn, 0n]
      });

      console.log(`[Trader] Real quote received: ${result} wei out`);

      // 2. Apply 1% Slippage tolerance
      amountOutMinimum = (result * 99n) / 100n;
      console.log(`[Trader] Setting amountOutMinimum (1% slippage): ${amountOutMinimum}`);

      // 3. Encode actual tx
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
      // 1. Fetch real quote for exit
      const { result } = await publicClient.simulateContract({
        address: QUOTER_ADDRESS as `0x${string}`,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn as `0x${string}`, WETH_ADDRESS as `0x${string}`, 3000, amountIn, 0n]
      });

      console.log(`[Trader] Real SELL quote received: ${result} WETH out`);

      // 2. Apply 1% Slippage tolerance
      amountOutMinimum = (result * 99n) / 100n;
      console.log(`[Trader] Setting SELL amountOutMinimum (1% slippage): ${amountOutMinimum}`);

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
