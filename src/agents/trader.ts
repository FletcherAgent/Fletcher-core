import { encodeFunctionData, parseAbi } from 'viem';
import { Bot } from 'grammy';
import { prisma } from '../core/db.js';

export class TraderAgent {
  private routerAddress = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // Uniswap V3 SwapRouter02
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Constructs an unsigned transaction payload for the user/vault to sign.
   * Fletcher operates on a zero-custody basis.
   */
  public async prepareEntryTransaction(tokenAddress: string, sizeInWeth: bigint) {
    console.log(`[Trader] Preparing entry for token: ${tokenAddress} with size: ${sizeInWeth.toString()}`);

    // Standard Uniswap V3 SwapRouter ABI snippet for exactInputSingle
    const swapAbi = parseAbi([
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
    ]);

    // Construct Calldata
    // TODO: Determine correct slippage, WETH address, and deadline dynamically
    const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; 
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins

    try {
      const calldata = encodeFunctionData({
        abi: swapAbi,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: WETH_ADDRESS,
          tokenOut: tokenAddress as `0x${string}`,
          fee: 3000, // standard 0.3% pool fee, should be dynamic
          recipient: '0x0000000000000000000000000000000000000000', // Replaced with user's vault at signing boundary
          deadline,
          amountIn: sizeInWeth,
          amountOutMinimum: 0n, // Slippage protection to be calculated
          sqrtPriceLimitX96: 0n
        }]
      });

      console.log(`[Trader] Unsigned Calldata generated: ${calldata}`);
      
      // Step 4: Emit to signing boundary (e.g. notify Telegram Bot for approval)
      this.emitToSigningBoundary(tokenAddress, calldata);

    } catch (error) {
      console.error("[Trader] Failed to build calldata", error);
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
      console.log(`[Trader] Position registered in DB: ${position.id}`);
    } catch (error) {
      console.error("[Trader] Failed to register position", error);
    }
  }

  private emitToSigningBoundary(tokenAddress: string, calldata: string) {
    // Integration point for the Telegram bot
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    console.log(`[Signing Boundary] Awaiting approval for ${tokenAddress}...`);
    
    if (chatId) {
      this.bot.api.sendMessage(
        chatId,
        `🚨 *New Signal Detected!*\n\nToken: \`${tokenAddress}\`\n\nApprove execution?`,
        { parse_mode: "Markdown" }
      ).catch(err => console.error("[Trader] Failed to send Telegram message", err));
    } else {
      console.warn("[Trader] TELEGRAM_CHAT_ID is not set in .env! Cannot send approval message.");
    }
  }
}
