import { encodeFunctionData, encodeAbiParameters, decodeAbiParameters, parseAbiParameters, parseAbi, concat, erc20Abi } from 'viem';
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
    async processSignal(tokenAddress, sizeInWeth, source = 'SCOUT', copiedFrom, txHash) {
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
                    await this.bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚨 **PENDING BUY**\nToken: \`${tokenAddress}\`\nSize: \`${Number(sizeInWeth) / 1e18} WETH\`\n\nDo you want to execute this trade?`, { parse_mode: 'Markdown', reply_markup: keyboard });
                    return;
                }
                if (!walletClient || !account)
                    throw new Error("WalletClient is null");
                console.log(`[Trader] ⚡ Broadcasting BUY transaction for ${tokenAddress}...`);
                const txHash = await walletClient.sendTransaction({
                    account,
                    to: toAddress,
                    data: calldata,
                    value: value
                });
                console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
                const estimatedEntryPrice = Number(sizeInWeth) / Number(expectedOut || 1n);
                await this.registerPendingPosition(tokenAddress, estimatedEntryPrice, Number(sizeInWeth) / 1e18, txHash, source, copiedFrom);
                const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
                if (receipt.status === 'success') {
                    console.log(`[Trader] 🎯 BUY TX Confirmed in block ${receipt.blockNumber}`);
                    dbLogger.info(`BUY TX Confirmed`, { txHash, token: tokenAddress, block: receipt.blockNumber.toString(), sizeEth: (Number(sizeInWeth) / 1e18).toFixed(6) });
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
            console.log(`[Trader] ⚡ Broadcasting CONFIRMED BUY transaction for ${trade.tokenAddress}...`);
            const txHash = await walletClient.sendTransaction({
                account: account,
                to: trade.toAddress,
                data: trade.calldata,
                value: trade.value
            });
            console.log(`[Trader] ✅ BUY TX Broadcasted: ${txHash}. Waiting for confirmation...`);
            if (chatId)
                await this.bot.api.sendMessage(chatId, `🚀 **TX Broadcasted!**\nHash: \`${txHash}\`\nWaiting for block confirmation...`, { parse_mode: 'Markdown' });
            const estimatedEntryPrice = Number(trade.sizeInWeth) / Number(trade.expectedOut || 1n);
            await this.registerPendingPosition(trade.tokenAddress, estimatedEntryPrice, Number(trade.sizeInWeth) / 1e18, txHash, trade.source, trade.copiedFrom);
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            if (receipt.status === 'success') {
                console.log(`[Trader] 🎯 BUY TX Confirmed in block ${receipt.blockNumber}`);
                this.emitToSigningBoundary(trade.tokenAddress, txHash, 'BUY EXECUTED');
                await this.confirmPosition(txHash);
                if (chatId)
                    await this.bot.api.sendMessage(chatId, `✅ **Trade Confirmed!**\nBlock: ${receipt.blockNumber}`);
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
    async processExitSignal(posId, tokenAddress, amountInToken, reason) {
        if (!walletClient || !account) {
            console.error("[Trader] Auto-trading disabled (no PRIVATE_KEY). Aborting trade.");
            await prisma.position.update({ where: { id: posId }, data: { status: 'EXIT_FAILED' } }).catch(console.error);
            return;
        }
        const calldataResult = await this.constructUnsignedSellTx(tokenAddress, amountInToken);
        if (calldataResult) {
            const { calldata, amountOutMinimum, expectedOut, toAddress } = calldataResult;
            try {
                const estimatedExitPrice = Number(expectedOut || 1n) / Number(amountInToken || 1n);
                console.log(`[Trader] ⚡ Broadcasting SELL transaction for ${tokenAddress}...`);
                const txHash = await walletClient.sendTransaction({
                    account: account,
                    to: toAddress,
                    data: calldata
                });
                console.log(`[Trader] ✅ SELL TX Broadcasted: ${txHash}. Waiting for confirmation...`);
                const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
                if (receipt.status === 'success') {
                    console.log(`[Trader] 🎯 SELL TX Confirmed in block ${receipt.blockNumber}`);
                    dbLogger.info(`SELL TX Confirmed`, { txHash, token: tokenAddress, block: receipt.blockNumber.toString(), reason });
                    this.emitToSigningBoundary(tokenAddress, txHash, `SELL EXECUTED [${reason}]`);
                    await this.updatePositionStatus(posId, tokenAddress, estimatedExitPrice);
                }
                else {
                    throw new Error('Transaction reverted by network');
                }
            }
            catch (error) {
                console.error(`[Trader] ❌ SELL TX Failed:`, error);
                dbLogger.error(`SELL TX Failed`, { token: tokenAddress, error: String(error) });
                this.emitToSigningBoundary(tokenAddress, "FAILED", 'SELL REJECTED');
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
        // --- NOXA DYNAMIC DUPLICATION (Fallback) ---
        if (txHash) {
            try {
                console.log(`[Trader] Attempting NOXA Dynamic Duplication from ${txHash}...`);
                const originalTx = await publicClient.getTransaction({ hash: txHash });
                if (originalTx && originalTx.input.startsWith('0xc1120e3d') && originalTx.to?.toLowerCase() === '0xf193ede778a92dc37cb450a1ef1565ed1e8b7964') {
                    console.log(`[Trader] 🎯 NOXA Transaction Detected! Slicing calldata...`);
                    // The calldata is: 0xc1120e3d + 10 words (320 bytes = 640 hex chars)
                    // Word 4 (index 4) is minOut. Word 5 is recipient.
                    // Let's decode it fully using ABI
                    const noxaAbiParams = parseAbiParameters('address, address, address, uint256, uint256, address, uint256, uint256, uint256, uint256');
                    const decodedParams = decodeAbiParameters(noxaAbiParams, `0x${originalTx.input.slice(10)}`);
                    // Calculate proportional minOut
                    const originalAmountIn = originalTx.value;
                    let calculatedMinOut = 0n;
                    if (originalAmountIn > 0n) {
                        calculatedMinOut = (BigInt(decodedParams[4]) * amountIn) / originalAmountIn;
                    }
                    const slippageMinOut = (calculatedMinOut * 99n) / 100n; // 1% extra slippage
                    // Replace Recipient (Word 5) and minOut (Word 4)
                    decodedParams[4] = slippageMinOut;
                    decodedParams[5] = USER_WALLET;
                    decodedParams[6] = deadline;
                    const newCalldata = concat(['0xc1120e3d', encodeAbiParameters(noxaAbiParams, decodedParams)]);
                    console.log(`[Trader] ✅ NOXA Calldata Cloned! Expected MinOut: ${slippageMinOut}`);
                    return {
                        calldata: newCalldata,
                        amountOutMinimum: slippageMinOut,
                        expectedOut: calculatedMinOut,
                        toAddress: originalTx.to,
                        value: amountIn
                    };
                }
            }
            catch (err) {
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
                    address: tokenOut,
                    abi: erc20Abi,
                    functionName: 'totalSupply'
                });
            }
            catch {
                console.warn(`[Trader] Could not fetch totalSupply for ${tokenOut}`);
            }
            // 2. Detect best pool fee tier dynamically
            const { fee: POOL_FEE, expectedOut: rawExpectedOut } = await detectBestFee(WETH_ADDRESS, tokenOut, amountIn);
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
    async constructUnsignedSellTx(tokenIn, amountIn) {
        console.log(`[Trader] Constructing Universal Router SELL calldata for ${tokenIn} -> WETH...`);
        const WETH_ADDRESS = process.env.WETH_ADDRESS;
        const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
        const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
        const USER_WALLET = process.env.USER_WALLET_ADDRESS;
        if (!WETH_ADDRESS || !QUOTER_ADDRESS || !ROUTER_ADDRESS || !USER_WALLET) {
            throw new Error('❌ CRITICAL: Missing env variables for SELL tx construction.');
        }
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 5);
        try {
            // 1. Detect best pool fee tier dynamically
            const { fee: POOL_FEE, expectedOut } = await detectBestFee(tokenIn, WETH_ADDRESS, amountIn);
            // 2. Slippage Protection (1%)
            if (expectedOut === 0n) {
                throw new Error('No active pool found (expectedOut = 0). Aborting to prevent TX revert.');
            }
            const amountOutMinimum = (expectedOut * 99n) / 100n;
            console.log(`[Trader] 🛡️ SELL amountOutMinimum: ${amountOutMinimum}`);
            // 3. Encode Universal Router execute() payload for Uniswap V4
            // Command 0x10 = V4_SWAP
            const commands = '0x10';
            const isZeroForOne = BigInt(tokenIn) < BigInt(WETH_ADDRESS);
            const currency0 = isZeroForOne ? tokenIn : WETH_ADDRESS;
            const currency1 = isZeroForOne ? WETH_ADDRESS : tokenIn;
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
                    copiedFrom
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
    async updatePositionStatus(posId, tokenAddress, exitPrice) {
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
            let msg = `🤖 *AUTO-TRADE EXECUTED*\n\nAction: **${action}**\nToken: \`${tokenAddress}\``;
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
}
