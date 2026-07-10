import { encodeFunctionData, parseAbi } from 'viem';
import { prisma } from '../core/db.js';
export class TraderAgent {
    routerAddress = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // Uniswap V3 SwapRouter02
    bot;
    constructor(bot) {
        this.bot = bot;
    }
    async processSignal(tokenAddress, sizeInWeth) {
        const calldata = await this.constructUnsignedSwapTx(tokenAddress, sizeInWeth);
        if (calldata) {
            this.emitToSigningBoundary(tokenAddress, calldata, 'BUY');
        }
    }
    async processExitSignal(tokenAddress, amountInToken, reason) {
        const calldata = await this.constructUnsignedSellTx(tokenAddress, amountInToken);
        if (calldata) {
            this.emitToSigningBoundary(tokenAddress, calldata, `SELL [${reason}]`);
        }
    }
    /**
     * Constructs an unsigned transaction payload for the user/vault to sign.
     * using Uniswap V3 SwapRouter exactInputSingle
     */
    async constructUnsignedSwapTx(tokenOut, amountIn) {
        console.log(`[Trader] Constructing exactInputSingle calldata for WETH -> ${tokenOut}...`);
        // Uniswap V3 exactInputSingle signature
        const exactInputSingleAbi = parseAbi([
            'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
            'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)'
        ]);
        // WETH address on Robinhood Chain (Placeholder, assume standard WETH for now)
        const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins
        try {
            const calldata = encodeFunctionData({
                abi: exactInputSingleAbi,
                functionName: 'exactInputSingle',
                args: [{
                        tokenIn: WETH_ADDRESS,
                        tokenOut: tokenOut,
                        fee: 3000, // standard 0.3% pool fee, should be dynamic
                        recipient: '0x0000000000000000000000000000000000000000', // Replaced with user's vault at signing boundary
                        deadline,
                        amountIn: amountIn,
                        amountOutMinimum: 0n, // Slippage protection to be calculated
                        sqrtPriceLimitX96: 0n
                    }]
            });
            console.log(`[Trader] Unsigned BUY Calldata generated: ${calldata}`);
            return calldata;
        }
        catch (error) {
            console.error("[Trader] Failed to build calldata", error);
            return null;
        }
    }
    /**
     * Constructs an unsigned transaction payload to sell the token back to WETH.
     */
    async constructUnsignedSellTx(tokenIn, amountIn) {
        console.log(`[Trader] Constructing exactInputSingle calldata for ${tokenIn} -> WETH...`);
        const exactInputSingleAbi = parseAbi([
            'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
            'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)'
        ]);
        const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins
        try {
            const calldata = encodeFunctionData({
                abi: exactInputSingleAbi,
                functionName: 'exactInputSingle',
                args: [{
                        tokenIn: tokenIn,
                        tokenOut: WETH_ADDRESS,
                        fee: 3000,
                        recipient: '0x0000000000000000000000000000000000000000',
                        deadline,
                        amountIn: amountIn,
                        amountOutMinimum: 0n, // Slippage protection
                        sqrtPriceLimitX96: 0n
                    }]
            });
            console.log(`[Trader] Unsigned SELL Calldata generated: ${calldata}`);
            return calldata;
        }
        catch (error) {
            console.error("[Trader] Failed to build sell calldata", error);
            return null;
        }
    }
    /**
     * Registers the position in the database after successful execution.
     */
    async registerPosition(tokenAddress, entryPrice, size) {
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
        }
        catch (error) {
            console.error("[Trader] Failed to register position", error);
        }
    }
    emitToSigningBoundary(tokenAddress, calldata, action) {
        // Integration point for the Telegram bot
        const chatId = process.env.TELEGRAM_CHAT_ID;
        console.log(`[Signing Boundary] Awaiting ${action} approval for ${tokenAddress}...`);
        if (chatId) {
            this.bot.api.sendMessage(chatId, `🚨 *New Signal Detected!*\n\nAction: **${action}**\nToken: \`${tokenAddress}\`\n\nApprove execution?`, { parse_mode: "Markdown" }).catch(err => console.error("[Trader] Failed to send Telegram message", err));
        }
        else {
            console.warn("[Trader] TELEGRAM_CHAT_ID is not set in .env! Cannot send approval message.");
        }
    }
}
