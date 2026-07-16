import { encodeFunctionData, encodeAbiParameters, parseAbi, erc20Abi, decodeEventLog, decodeFunctionData } from 'viem';
import { detectBestFee } from '../services/poolFeeDetector.js';
import { dbLogger } from '../services/logger.js';
import { InlineKeyboard } from 'grammy';
import { prisma } from '../core/db.js';
import { publicClient, walletClient, account } from '../services/viem.js';
export class TraderAgent {
    bot;
    executionMode = 'AUTO';
    pendingTrades = new Map();
    constructor(bot) {
        this.bot = bot;
        this.bot.on("callback_query:data", async (ctx) => {
            const data = ctx.callbackQuery.data;
            if (data.startsWith('confirm_')) {
                const tradeId = data.replace('confirm_', '');
                await ctx.answerCallbackQuery({ text: "Executing Trade..." });
                await this.executePendingTrade(tradeId, ctx.chat?.id);
            }
            else if (data.startsWith('reject_')) {
                const tradeId = data.replace('reject_', '');
                await ctx.answerCallbackQuery({ text: "Trade Rejected" });
                this.cancelPendingTrade(tradeId, ctx.chat?.id, "Manually rejected by user.");
            }
        });
    }
    async getTradingMode() {
        const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
        return config ? config.value : 'LIVE';
    }
    async processSignal(tokenAddress, sizeInWeth, source = 'SCOUT', copiedFrom, txHash) {
        const tradeId = Math.random().toString(36).substring(7);
        console.log(`[Trader] Processing Signal for ${tokenAddress} - Size: ${sizeInWeth}`);
        if (!walletClient || !account) {
            console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
            return;
        }
        const calldataResult = await this.constructUnsignedSwapTx(tokenAddress, sizeInWeth, txHash);
        if (!calldataResult) {
            console.error(`[Trader] ❌ Failed to construct BUY calldata for ${tokenAddress}.`);
            this.emitToSigningBoundary(tokenAddress, "FAILED", 'BUY REJECTED (NO ROUTE/POOL OR CALLDATA FAIL)');
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId)
                this.bot.api.sendMessage(chatId, `❌ **BUY Failed**\nToken: \`${tokenAddress}\`\nReason: Failed to construct transaction (Pool not found or Universal Router parsing failed).`, { parse_mode: 'Markdown' }).catch(console.error);
            return;
        }
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
                    await this.bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚨 **PENDING BUY**\nToken: \`${tokenAddress}\`\nSize: \`${Number(sizeInWeth) / 1e18} WETH\`\n\nDo you want to execute this trade?`, { parse_mode: 'Markdown', reply_markup: keyboard });
                    return;
                }
                if (!walletClient || !account)
                    throw new Error("WalletClient is null");
                const mode = await this.getTradingMode();
                let txHash;
                let receiptStatus = 'success';
                let blockNumber = 0n;
                if (mode === 'DRY_RUN') {
                    console.log(`[Trader] 🛡️ DRY RUN: Simulating BUY transaction for ${tokenAddress}...`);
                    txHash = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}`;
                    blockNumber = await publicClient.getBlockNumber();
                }
                else {
                    console.log(`[Trader] ⚡ Broadcasting BUY transaction for ${tokenAddress}...`);
                    txHash = await walletClient.sendTransaction({
                        account,
                        to: toAddress,
                        data: calldata,
                        value: value
                    });
                    console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
                }
                const estimatedEntryPrice = Number(sizeInWeth) / Number(expectedOut || 1n);
                await this.registerPendingPosition(tokenAddress, estimatedEntryPrice, Number(sizeInWeth) / 1e18, txHash, source, copiedFrom);
                if (mode === 'DRY_RUN') {
                    receiptStatus = 'success';
                }
                else {
                    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
                    receiptStatus = receipt.status;
                    blockNumber = receipt.blockNumber;
                }
                if (receiptStatus === 'success') {
                    console.log(`[Trader] 🎯 BUY TX Confirmed in block ${blockNumber}`);
                    dbLogger.info(`BUY TX Confirmed`, { txHash, token: tokenAddress, block: blockNumber.toString(), sizeEth: (Number(sizeInWeth) / 1e18).toFixed(6), mode });
                    this.emitToSigningBoundary(tokenAddress, txHash, 'BUY EXECUTED');
                    await this.confirmPosition(txHash);
                }
                else {
                    await this.failPendingPosition(txHash);
                    throw new Error('Transaction reverted by network');
                }
            }
            catch (error) {
                console.error(`[Trader] ❌ BUY TX Failed:`, error);
                dbLogger.error(`BUY TX Failed`, { token: tokenAddress, error: String(error) });
                this.emitToSigningBoundary(tokenAddress, "FAILED", 'BUY REJECTED');
            }
        }
    }
    async executePendingTrade(tradeId, chatId) {
        const trade = this.pendingTrades.get(tradeId);
        if (!trade) {
            if (chatId)
                await this.bot.api.sendMessage(chatId, `❌ Trade ${tradeId} not found or expired.`);
            return;
        }
        clearTimeout(trade.timeoutId);
        this.pendingTrades.delete(tradeId);
        try {
            const mode = await this.getTradingMode();
            let txHash;
            let receiptStatus = 'success';
            let blockNumber = 0n;
            if (mode === 'DRY_RUN') {
                console.log(`[Trader] 🛡️ DRY RUN: Simulating CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
                txHash = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}`;
                blockNumber = await publicClient.getBlockNumber();
                if (chatId)
                    await this.bot.api.sendMessage(chatId, `🚀 **DRY RUN TX Simulated!**\nHash: \`${txHash}\``, { parse_mode: 'Markdown' });
            }
            else {
                console.log(`[Trader] ⚡ Broadcasting CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
                txHash = await walletClient.sendTransaction({
                    account: account,
                    to: trade.toAddress,
                    data: trade.calldata,
                    value: trade.value
                });
                console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
                if (chatId)
                    await this.bot.api.sendMessage(chatId, `🚀 **TX Broadcasted!**\nHash: \`${txHash}\`\nWaiting for block confirmation...`, { parse_mode: 'Markdown' });
            }
            const estimatedEntryPrice = Number(trade.sizeInWeth) / Number(trade.expectedOut || 1n);
            await this.registerPendingPosition(trade.tokenAddress, estimatedEntryPrice, Number(trade.sizeInWeth) / 1e18, txHash, trade.source, trade.copiedFrom);
            if (mode === 'DRY_RUN') {
                receiptStatus = 'success';
            }
            else {
                const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
                receiptStatus = receipt.status;
                blockNumber = receipt.blockNumber;
            }
            if (receiptStatus === 'success') {
                console.log(`[Trader] 🎯 BUY TX Confirmed in block ${blockNumber}`);
                this.emitToSigningBoundary(trade.tokenAddress, txHash, 'BUY EXECUTED');
                await this.confirmPosition(txHash);
                if (chatId)
                    await this.bot.api.sendMessage(chatId, `✅ **Trade Confirmed!**\nBlock: ${blockNumber}`);
            }
            else {
                await this.failPendingPosition(txHash);
                throw new Error('Transaction reverted by network');
            }
        }
        catch (error) {
            console.error(`[Trader] ❌ BUY TX Failed:`, error);
            this.emitToSigningBoundary(trade.tokenAddress, "FAILED", 'BUY REJECTED');
            if (chatId)
                await this.bot.api.sendMessage(chatId, `❌ **Trade Failed!**\nReason: ${error.message}`);
        }
    }
    cancelPendingTrade(tradeId, chatId, reason) {
        const trade = this.pendingTrades.get(tradeId);
        if (trade) {
            clearTimeout(trade.timeoutId);
            this.pendingTrades.delete(tradeId);
            if (chatId) {
                this.bot.api.sendMessage(chatId, `🗑️ Trade Cancelled.\nReason: ${reason || 'Unknown'}`).catch(console.error);
            }
        }
    }
    async processExitSignal(posId, tokenAddress, amountInToken, reason, txHash) {
        if (!walletClient || !account) {
            console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
            await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
            return;
        }
        const calldataResult = await this.constructUnsignedSellTx(tokenAddress, amountInToken, txHash);
        if (!calldataResult) {
            console.error(`[Trader] ❌ Failed to construct SELL calldata for ${tokenAddress}.`);
            this.emitToSigningBoundary(tokenAddress, "FAILED", 'SELL REJECTED (NO ROUTE/POOL OR CALLDATA FAIL)');
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId)
                this.bot.api.sendMessage(chatId, `❌ **SELL Failed**\nToken: \`${tokenAddress}\`\nReason: Failed to construct transaction (Pool not found or Universal Router parsing failed).`, { parse_mode: 'Markdown' }).catch(console.error);
            return;
        }
        if (calldataResult) {
            const { calldata, amountOutMinimum, expectedOut, toAddress } = calldataResult;
            try {
                const estimatedExitPrice = Number(expectedOut || 1n) / Number(amountInToken || 1n);
                const mode = await this.getTradingMode();
                let txHashFinal;
                let receiptStatus = 'success';
                let blockNumber = 0n;
                if (mode === 'DRY_RUN') {
                    console.log(`[Trader] 🛡️ DRY RUN: Simulating SELL transaction for ${tokenAddress}...`);
                    txHashFinal = `0xdddddddddddddddddddddddddddddddd${Date.now().toString(16).padStart(32, '0')}`;
                    blockNumber = await publicClient.getBlockNumber();
                }
                else {
                    // --- 0. Check and Approve Allowance ---
                    const currentAllowance = await publicClient.readContract({
                        address: tokenAddress,
                        abi: erc20Abi,
                        functionName: 'allowance',
                        args: [account.address, toAddress]
                    });
                    if (currentAllowance < amountInToken) {
                        console.log(`[Trader] 🔓 Approving Router to spend ${tokenAddress}...`);
                        const approveData = encodeFunctionData({
                            abi: erc20Abi,
                            functionName: 'approve',
                            args: [toAddress, 2n ** 256n - 1n] // MaxUint256
                        });
                        const approveTxHash = await walletClient.sendTransaction({
                            account: account,
                            to: tokenAddress,
                            data: approveData
                        });
                        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
                        console.log(`[Trader] ✅ Approve confirmed!`);
                    }
                    console.log(`[Trader] ⚡ Broadcasting SELL transaction for ${tokenAddress}...`);
                    txHashFinal = await walletClient.sendTransaction({
                        account: account,
                        to: toAddress,
                        data: calldata
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
                    await this.updatePositionStatus(posId, tokenAddress, estimatedExitPrice, reason);
                }
                else {
                    throw new Error('Transaction reverted by network');
                }
            }
            catch (error) {
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
                }
                else {
                    await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
                }
            }
        }
        else {
            console.error(`[Trader] ❌ Failed to construct SELL calldata for ${tokenAddress}.`);
            if (reason === 'UNSUPPORTED_OR_RUG_NO_QUOTES') {
                console.log(`[Trader] 🚮 Token is a rug/unsupported. Marking position as CLOSED (100% loss).`);
                await this.updatePositionStatus(posId, tokenAddress, 0, reason);
            }
            else {
                console.log(`[Trader] Marking as EXIT_FAILED.`);
                await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
            }
        }
    }
    /**
     * Constructs a BUY transaction payload using Universal Router v4 execute().
     * Uses NOXA dynamic duplication if txHash points to a NOXA swap.
     */
    async constructUnsignedSwapTx(tokenOut, amountIn, txHash) {
        console.log(`[Trader] Constructing BUY calldata for WETH -> ${tokenOut}...`);
        const WETH_ADDRESS = process.env.WETH_ADDRESS;
        const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
        const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
        const USER_WALLET = process.env.USER_WALLET_ADDRESS;
        if (!WETH_ADDRESS || !QUOTER_ADDRESS || !ROUTER_ADDRESS || !USER_WALLET) {
            throw new Error('❌ CRITICAL: WETH_ADDRESS, QUOTER_ADDRESS, ROUTER_ADDRESS, or USER_WALLET_ADDRESS missing in .env');
        }
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5); // 5 mins
        // --- UNIVERSAL DYNAMIC DUPLICATION ---
        if (txHash) {
            try {
                console.log(`[Trader] Attempting Universal Dynamic Duplication for BUY from ${txHash}...`);
                const originalTx = await publicClient.getTransaction({ hash: txHash });
                if (originalTx && originalTx.to) {
                    let originalAmountIn = originalTx.value;
                    // If value is 0, check for WETH transfer
                    if (originalAmountIn === 0n) {
                        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
                        const erc20AbiForLog = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
                        for (const log of receipt.logs) {
                            if (log.address.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                                try {
                                    const decoded = decodeEventLog({ abi: erc20AbiForLog, data: log.data, topics: log.topics });
                                    if (decoded.args.from.toLowerCase() === originalTx.from.toLowerCase()) {
                                        originalAmountIn = decoded.args.value;
                                        break;
                                    }
                                }
                                catch (e) { }
                            }
                        }
                    }
                    if (originalAmountIn > 0n || originalAmountIn === 0n) {
                        let modifiedInput = this.modifyUniversalRouterCalldata(originalTx.input, amountIn, originalAmountIn);
                        if (modifiedInput !== "") {
                            // Extract proportional expectedOut for accurate PnL tracking
                            let estimatedExpectedOut = 1n;
                            try {
                                const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
                                const erc20AbiForLog = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
                                for (const log of receipt.logs) {
                                    if (log.address.toLowerCase() === tokenOut.toLowerCase()) {
                                        try {
                                            const decoded = decodeEventLog({ abi: erc20AbiForLog, data: log.data, topics: log.topics });
                                            const toAddr = decoded.args.to.toLowerCase();
                                            if (toAddr === originalTx.from.toLowerCase() || toAddr === originalTx.to?.toLowerCase()) {
                                                const originalAmountOut = decoded.args.value;
                                                if (originalAmountOut > 0n) {
                                                    estimatedExpectedOut = (originalAmountOut * amountIn) / originalAmountIn;
                                                    console.log(`[Trader] 📊 Extracted proportional expectedOut: ${estimatedExpectedOut}`);
                                                    break;
                                                }
                                            }
                                        }
                                        catch (e) { }
                                    }
                                }
                            }
                            catch (e) { }
                            console.log(`[Trader] ✅ Universal Dynamic Duplication SUCCESS. Replaced amountIn & bypassed amountOutMinimum.`);
                            return {
                                calldata: modifiedInput,
                                amountOutMinimum: 0n,
                                expectedOut: estimatedExpectedOut,
                                toAddress: originalTx.to,
                                value: originalTx.value > 0n ? amountIn : 0n
                            };
                        }
                        else {
                            console.log(`[Trader] ⚠️ Dynamic Duplication failed to modify input. Falling back to PoolFeeDetector...`);
                        }
                    }
                }
            }
            catch (err) {
                console.warn(`[Trader] Universal Dynamic Duplication failed, falling back to PoolFeeDetector...`, err);
            }
        }
        // -------------------------------------------
        try {
            // 1. Fetch Total Supply for 2% Cap check
            const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)']);
            let totalSupply = 0n;
            try {
                totalSupply = await publicClient.readContract({
                    address: tokenOut,
                    abi: erc20Abi,
                    functionName: 'totalSupply'
                });
            }
            catch {
                console.warn(`[Trader] Could not fetch totalSupply for ${tokenOut}`);
            }
            // 2. Detect best pool fee tier dynamically
            let targetRouter = undefined;
            if (txHash) {
                try {
                    const otx = await publicClient.getTransaction({ hash: txHash });
                    if (otx && otx.to)
                        targetRouter = otx.to;
                }
                catch (e) { }
            }
            const { fee: POOL_FEE, expectedOut: rawExpectedOut } = await detectBestFee(WETH_ADDRESS, tokenOut, amountIn, targetRouter);
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
            const commands = '0x10';
            // In Universal Router, V4_SWAP input is abi.encode(IV4Router.ExactInputSingleParams)
            // ExactInputSingleParams = (PoolKey key, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)
            // PoolKey = (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
            const isZeroForOne = BigInt(WETH_ADDRESS) < BigInt(tokenOut);
            const currency0 = isZeroForOne ? WETH_ADDRESS : tokenOut;
            const currency1 = isZeroForOne ? tokenOut : WETH_ADDRESS;
            let tickSpacing = 60;
            if (POOL_FEE === 500)
                tickSpacing = 10;
            else if (POOL_FEE === 10000)
                tickSpacing = 200;
            const exactInputSingleParamsAbi = [{
                    type: 'tuple',
                    components: [
                        { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
                        { name: 'zeroForOne', type: 'bool' },
                        { name: 'amountIn', type: 'uint128' },
                        { name: 'amountOutMinimum', type: 'uint128' },
                        { name: 'hookData', type: 'bytes' }
                    ]
                }];
            const swapInput = encodeAbiParameters(exactInputSingleParamsAbi, [
                {
                    poolKey: {
                        currency0: currency0,
                        currency1: currency1,
                        fee: POOL_FEE,
                        tickSpacing,
                        hooks: '0x0000000000000000000000000000000000000000'
                    },
                    zeroForOne: isZeroForOne,
                    amountIn,
                    amountOutMinimum,
                    hookData: '0x'
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
            return { calldata, amountOutMinimum, expectedOut, toAddress: ROUTER_ADDRESS, value: amountIn };
        }
        catch (error) {
            console.error('[Trader] Failed to build BUY calldata:', error);
            return null;
        }
    }
    /**
     * Constructs a SELL transaction payload using Universal Router v4 execute().
     * Command 0x00 = V3_SWAP_EXACT_IN: tokenIn -> WETH
     */
    async constructUnsignedSellTx(tokenIn, amountIn, txHash) {
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
                const originalTx = await publicClient.getTransaction({ hash: txHash });
                if (originalTx && originalTx.to) {
                    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
                    const erc20AbiForLog = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
                    let originalAmountIn = 0n;
                    for (const log of receipt.logs) {
                        if (log.address.toLowerCase() === tokenIn.toLowerCase()) {
                            try {
                                const decoded = decodeEventLog({ abi: erc20AbiForLog, data: log.data, topics: log.topics });
                                if (decoded.args.from.toLowerCase() === originalTx.from.toLowerCase()) {
                                    originalAmountIn = decoded.args.value;
                                    break;
                                }
                            }
                            catch (e) { }
                        }
                    }
                    if (originalAmountIn > 0n || originalAmountIn === 0n) {
                        let modifiedInput = this.modifyUniversalRouterCalldata(originalTx.input, amountIn, originalAmountIn);
                        if (modifiedInput !== "") {
                            // Extract proportional expectedOut (WETH) for accurate PnL tracking
                            let estimatedExpectedOut = 1n;
                            try {
                                for (const log of receipt.logs) {
                                    if (log.address.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                                        try {
                                            const decoded = decodeEventLog({ abi: erc20AbiForLog, data: log.data, topics: log.topics });
                                            const toAddr = decoded.args.to.toLowerCase();
                                            if (toAddr === originalTx.from.toLowerCase() || toAddr === originalTx.to?.toLowerCase()) {
                                                const originalAmountOut = decoded.args.value;
                                                if (originalAmountOut > 0n) {
                                                    estimatedExpectedOut = (originalAmountOut * amountIn) / originalAmountIn;
                                                    console.log(`[Trader] 📊 Extracted proportional expectedOut (WETH): ${estimatedExpectedOut}`);
                                                    break;
                                                }
                                            }
                                        }
                                        catch (e) { }
                                    }
                                }
                            }
                            catch (e) { }
                            console.log(`[Trader] ✅ Dynamic Duplication SUCCESS. Replaced amountIn & amountOutMinimum.`);
                            return {
                                calldata: modifiedInput,
                                amountOutMinimum: 0n,
                                expectedOut: estimatedExpectedOut,
                                toAddress: originalTx.to
                            };
                        }
                    }
                }
            }
            catch (e) {
                console.error(`[Trader] Dynamic Duplication failed for SELL:`, e);
            }
        }
        try {
            // 1. Detect best pool fee tier dynamically
            let POOL_FEE = 10000;
            let expectedOut = 0n;
            let useNative = false;
            let targetRouter = undefined;
            if (txHash) {
                try {
                    const otx = await publicClient.getTransaction({ hash: txHash });
                    if (otx && otx.to)
                        targetRouter = otx.to;
                }
                catch (e) { }
            }
            try {
                const best = await detectBestFee(tokenIn, WETH_ADDRESS, amountIn, targetRouter);
                POOL_FEE = best.fee;
                expectedOut = best.expectedOut;
            }
            catch (e) {
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
            const commands = '0x10';
            const TARGET_OUT = useNative ? '0x0000000000000000000000000000000000000000' : WETH_ADDRESS;
            const isZeroForOne = BigInt(tokenIn) < BigInt(TARGET_OUT);
            const currency0 = isZeroForOne ? tokenIn : TARGET_OUT;
            const currency1 = isZeroForOne ? TARGET_OUT : tokenIn;
            let tickSpacing = 60;
            if (POOL_FEE === 500)
                tickSpacing = 10;
            else if (POOL_FEE === 10000)
                tickSpacing = 200;
            const exactInputSingleParamsAbi = [{
                    type: 'tuple',
                    components: [
                        { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
                        { name: 'zeroForOne', type: 'bool' },
                        { name: 'amountIn', type: 'uint128' },
                        { name: 'amountOutMinimum', type: 'uint128' },
                        { name: 'hookData', type: 'bytes' }
                    ]
                }];
            const swapInput = encodeAbiParameters(exactInputSingleParamsAbi, [
                {
                    poolKey: {
                        currency0: currency0,
                        currency1: currency1,
                        fee: POOL_FEE,
                        tickSpacing,
                        hooks: '0x0000000000000000000000000000000000000000'
                    },
                    zeroForOne: isZeroForOne,
                    amountIn,
                    amountOutMinimum,
                    hookData: '0x'
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
            return { calldata, amountOutMinimum, expectedOut, toAddress: ROUTER_ADDRESS };
        }
        catch (error) {
            console.error('[Trader] Failed to build SELL calldata:', error);
            return null;
        }
    }
    /**
     * Registers the position in the database after successful execution.
    /**
     * Registers a position in PENDING state before tx confirmation
     */
    async registerPendingPosition(tokenAddress, entryPrice, size, txHash, source = "SCOUT", copiedFrom) {
        try {
            let tokenName = null;
            let tokenSymbol = null;
            try {
                const [name, symbol] = await Promise.all([
                    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'name' }),
                    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' })
                ]);
                tokenName = name;
                tokenSymbol = symbol;
            }
            catch (e) {
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
        }
        catch (error) {
            console.error("[Trader] Failed to register pending position in DB", error);
        }
    }
    async confirmPosition(txHash) {
        try {
            await prisma.position.updateMany({
                where: { txHash, status: 'PENDING' },
                data: { status: 'OPEN' }
            });
            console.log(`[Trader] 💾 DB UPDATE: Position confirmed to OPEN for txHash: ${txHash}`);
        }
        catch (error) {
            console.error("[Trader] Failed to confirm position in DB", error);
        }
    }
    async failPendingPosition(txHash) {
        try {
            await prisma.position.updateMany({
                where: { txHash, status: 'PENDING' },
                data: { status: 'FAILED' }
            });
            console.log(`[Trader] 💾 DB UPDATE: Position marked as FAILED for txHash: ${txHash}`);
        }
        catch (error) {
            console.error("[Trader] Failed to fail position in DB", error);
        }
    }
    async recoverPendingTrades() {
        console.log(`[Trader] 🔄 Running recovery for PENDING trades...`);
        try {
            const pendingPositions = await prisma.position.findMany({ where: { status: 'PENDING' } });
            for (const pos of pendingPositions) {
                if (!pos.txHash)
                    continue;
                console.log(`[Trader] 🔍 Checking pending txHash ${pos.txHash} for ${pos.tokenAddress}...`);
                try {
                    const receipt = await publicClient.getTransactionReceipt({ hash: pos.txHash });
                    if (receipt.status === 'success') {
                        console.log(`[Trader] 🎯 Recovered BUY TX Confirmed for ${pos.tokenAddress}`);
                        await this.confirmPosition(pos.txHash);
                        dbLogger.info(`BUY TX Recovered & Confirmed`, { txHash: pos.txHash, token: pos.tokenAddress });
                    }
                    else {
                        console.log(`[Trader] ❌ Recovered BUY TX Reverted for ${pos.tokenAddress}`);
                        await this.failPendingPosition(pos.txHash);
                    }
                }
                catch (e) {
                    console.warn(`[Trader] ⏳ TX ${pos.txHash} still pending or not found.`);
                }
            }
        }
        catch (e) {
            console.error("[Trader] Failed to recover pending trades", e);
        }
    }
    /**
     * Updates a position's status to CLOSED in the database.
     */
    async updatePositionStatus(posId, tokenAddress, exitPrice, exitReason) {
        try {
            const position = await prisma.position.findUnique({
                where: { id: posId }
            });
            if (position) {
                const pnlRatio = (exitPrice - position.entryPrice) / position.entryPrice;
                await prisma.position.update({
                    where: { id: position.id },
                    data: { status: 'CLOSED', exitPrice, pnl: pnlRatio, exitReason } // IDE should pick up new types now
                });
                console.log(`[Trader] 💾 DB UPDATE: Position ${position.id} CLOSED in DB. PNL: ${(pnlRatio * 100).toFixed(2)}%`);
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
                            if (newWinRate < 35 && wallet.tier < 3)
                                newTier = 3;
                            else if (newWinRate >= 55 && wallet.tier > 1)
                                newTier = 1;
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
        }
        catch (e) {
            console.error("[Trader] Failed to update position in DB", e);
        }
    }
    emitToSigningBoundary(tokenAddress, txHash, action) {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        console.log(`[Notification] Auto-Trade executed: ${action} for ${tokenAddress}. Hash: ${txHash}`);
        if (chatId) {
            const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            let msg = `🤖 *AUTO-TRADE EXECUTED*\n\nAction: **${action}**\nToken: \`${tokenAddress}\`\n⏰ Time: ${timeStr}`;
            if (txHash !== "FAILED") {
                msg += `\n\n✅ Transaction Hash:\n\`${txHash}\``;
            }
            else {
                msg += `\n\n❌ Transaction Failed (Reverted/Error)`;
            }
            this.bot.api.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(err => console.error("[Trader] Failed to send Telegram message", err));
        }
        else {
            console.warn("[Trader] TELEGRAM_CHAT_ID is not set in .env! Cannot send execution message.");
        }
    }
    modifyUniversalRouterCalldata(originalInput, newAmountIn, originalAmountIn) {
        let finalCalldata = originalInput;
        try {
            const executeAbiV3 = { name: 'execute', type: 'function', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }] };
            const executeAbiV2 = { name: 'execute', type: 'function', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }] };
            let decoded = null;
            let executeAbi = executeAbiV3;
            try {
                decoded = decodeFunctionData({ abi: [executeAbiV3], data: originalInput });
            }
            catch (e) {
                try {
                    decoded = decodeFunctionData({ abi: [executeAbiV2], data: originalInput });
                    executeAbi = executeAbiV2;
                }
                catch (err) { }
            }
            const newHex = newAmountIn.toString(16).padStart(64, '0');
            const zeroHex = '0000000000000000000000000000000000000000000000000000000000000000';
            const maxHex = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
            if (decoded) {
                const commandsHex = decoded.args[0].slice(2);
                const commands = Buffer.from(commandsHex, 'hex');
                const inputs = [...decoded.args[1]];
                let modified = false;
                for (let i = 0; i < commands.length; i++) {
                    const cmd = commands[i] & 0x3f;
                    if (cmd === 0x00 || cmd === 0x08 || cmd === 0x09) {
                        const inputHex = inputs[i].slice(2);
                        if (inputHex.length >= 192) {
                            let word2 = inputHex.substring(64, 128); // amountIn
                            if (word2 !== zeroHex && word2 !== maxHex) {
                                word2 = newHex;
                            }
                            const prefix = inputHex.substring(0, 64);
                            const suffix = inputHex.substring(192); // skip amountOutMinimum
                            inputs[i] = `0x${prefix}${word2}${zeroHex}${suffix}`;
                            modified = true;
                        }
                    }
                    else if (cmd === 0x10) { // V4 Swap
                        const inputHex = inputs[i].slice(2);
                        if (inputHex.length >= 512) {
                            let wordAmountIn = inputHex.substring(384, 448);
                            if (wordAmountIn !== zeroHex && wordAmountIn !== maxHex) {
                                wordAmountIn = newHex;
                            }
                            const prefix = inputHex.substring(0, 384);
                            const suffix = inputHex.substring(512);
                            inputs[i] = `0x${prefix}${wordAmountIn}${zeroHex}${suffix}`;
                            modified = true;
                        }
                    }
                }
                if (modified) {
                    finalCalldata = encodeFunctionData({
                        abi: [executeAbi],
                        functionName: 'execute',
                        args: decoded.args.length === 3 ? [decoded.args[0], inputs, decoded.args[2]] : [decoded.args[0], inputs]
                    });
                    console.log(`[Trader] ✅ Universal Router ABI Decoding Duplication SUCCESS.`);
                    return finalCalldata;
                }
            }
            // Fallback to basic string hex replacement
            const origHex = originalAmountIn.toString(16).padStart(64, '0');
            const index = finalCalldata.indexOf(origHex);
            if (index !== -1) {
                finalCalldata = finalCalldata.substring(0, index) + newHex + finalCalldata.substring(index + 64);
                const nextIndex = index + 64;
                if (nextIndex + 64 <= finalCalldata.length) {
                    finalCalldata = finalCalldata.substring(0, nextIndex) + zeroHex + finalCalldata.substring(nextIndex + 64);
                }
                console.log(`[Trader] ✅ Basic Hex Duplication SUCCESS.`);
                return finalCalldata;
            }
            return "";
        }
        catch (e) {
            console.error(`[Trader] Error modifying UR calldata:`, e);
            return "";
        }
    }
}
