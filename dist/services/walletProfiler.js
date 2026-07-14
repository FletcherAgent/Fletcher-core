import { publicClient } from './viem.js';
import { prisma } from '../core/db.js';
import { dbLogger } from './logger.js';
import { parseAbiItem, decodeEventLog } from 'viem';
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const WETH_ADDRESS = (process.env.WETH_ADDRESS || '').toLowerCase();
// Helper to delay execution
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class WalletProfiler {
    /**
     * Processes a BUY signal from a tracked wallet by fetching the TX receipt,
     * parsing the Transfer logs, and recording the acquired position.
     */
    static async processBuy(walletAddress, tokenAddress, txHash) {
        try {
            // Wait for RPC to have the receipt
            await sleep(3000);
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt.status !== 'success')
                return;
            let wethSpent = 0n;
            let tokensAcquired = 0n;
            const wethAddr = WETH_ADDRESS.toLowerCase();
            const tokenAddr = tokenAddress.toLowerCase();
            const walletLower = walletAddress.toLowerCase();
            for (const log of receipt.logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: [TRANSFER_EVENT],
                        data: log.data,
                        topics: log.topics
                    });
                    if (decoded.eventName === 'Transfer') {
                        const { from, to, value } = decoded.args;
                        const logAddr = log.address.toLowerCase();
                        const fromAddr = from.toLowerCase();
                        const toAddr = to.toLowerCase();
                        // Detect WETH spent by the wallet
                        if (logAddr === wethAddr && fromAddr === walletLower) {
                            wethSpent += value;
                        }
                        // Detect Token acquired by the wallet
                        if (logAddr === tokenAddr && toAddr === walletLower) {
                            tokensAcquired += value;
                        }
                    }
                }
                catch (e) {
                    // Ignore logs that don't match Transfer event
                }
            }
            if (wethSpent > 0n && tokensAcquired > 0n) {
                const spentEth = Number(wethSpent) / 1e18;
                // Approximation: tokens often have 18 decimals, but could have 9 or 6. 
                // For avgEntryPrice logic, keeping token decimals raw or string is better, 
                // but we'll use generic float for profiling purposes.
                const tokenAmount = Number(tokensAcquired);
                // Find or create OPEN position
                const existingPos = await prisma.walletPosition.findFirst({
                    where: { walletAddress, tokenAddress, status: 'OPEN' }
                });
                if (existingPos) {
                    const newSpent = existingPos.totalWethSpent + spentEth;
                    const newTokens = existingPos.totalTokens + tokenAmount;
                    await prisma.walletPosition.update({
                        where: { id: existingPos.id },
                        data: {
                            totalWethSpent: newSpent,
                            totalTokens: newTokens,
                            avgEntryPrice: newSpent / newTokens
                        }
                    });
                }
                else {
                    await prisma.walletPosition.create({
                        data: {
                            walletAddress,
                            tokenAddress,
                            status: 'OPEN',
                            totalWethSpent: spentEth,
                            totalTokens: tokenAmount,
                            avgEntryPrice: spentEth / tokenAmount
                        }
                    });
                }
                console.log(`[WalletProfiler] 📈 BUY recorded for ${walletAddress}: Spent ${spentEth.toFixed(4)} WETH`);
            }
        }
        catch (error) {
            console.error(`[WalletProfiler] Failed to process BUY for ${txHash}`, error);
        }
    }
    /**
     * Processes a SELL signal, calculates actual PnL, updates the wallet's track record,
     * and handles automatic Tier promotions/demotions.
     */
    static async processSell(walletAddress, tokenAddress, txHash) {
        try {
            await sleep(3000);
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt.status !== 'success')
                return;
            let wethReceived = 0n;
            let tokensSold = 0n;
            const wethAddr = WETH_ADDRESS.toLowerCase();
            const tokenAddr = tokenAddress.toLowerCase();
            const walletLower = walletAddress.toLowerCase();
            for (const log of receipt.logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: [TRANSFER_EVENT],
                        data: log.data,
                        topics: log.topics
                    });
                    if (decoded.eventName === 'Transfer') {
                        const { from, to, value } = decoded.args;
                        const logAddr = log.address.toLowerCase();
                        const fromAddr = from.toLowerCase();
                        const toAddr = to.toLowerCase();
                        // Detect WETH received by the wallet
                        if (logAddr === wethAddr && toAddr === walletLower) {
                            wethReceived += value;
                        }
                        // Detect Token sold by the wallet
                        if (logAddr === tokenAddr && fromAddr === walletLower) {
                            tokensSold += value;
                        }
                    }
                }
                catch (e) { }
            }
            if (wethReceived > 0n && tokensSold > 0n) {
                const receivedEth = Number(wethReceived) / 1e18;
                const soldAmount = Number(tokensSold);
                const position = await prisma.walletPosition.findFirst({
                    where: { walletAddress, tokenAddress, status: 'OPEN' }
                });
                if (position) {
                    // Calculate PnL for the portion sold
                    // Cost basis for the sold amount:
                    const costBasis = soldAmount * position.avgEntryPrice;
                    let pnlRatio = 0;
                    if (costBasis > 0) {
                        pnlRatio = (receivedEth - costBasis) / costBasis;
                    }
                    // Check if wallet sold almost everything (e.g. > 90% of holdings)
                    const isFullExit = soldAmount >= (position.totalTokens * 0.9);
                    if (isFullExit) {
                        await prisma.walletPosition.update({
                            where: { id: position.id },
                            data: { status: 'CLOSED', realizedPnl: pnlRatio }
                        });
                        console.log(`[WalletProfiler] 📉 FULL EXIT for ${walletAddress}. PnL: ${(pnlRatio * 100).toFixed(2)}%`);
                        // Update TrackedWallet Metrics
                        await this.updateWalletMetrics(walletAddress, pnlRatio);
                    }
                    else {
                        // Partial exit
                        const newTokens = position.totalTokens - soldAmount;
                        const newSpent = newTokens * position.avgEntryPrice;
                        await prisma.walletPosition.update({
                            where: { id: position.id },
                            data: { totalTokens: newTokens, totalWethSpent: newSpent }
                        });
                        console.log(`[WalletProfiler] 📉 PARTIAL EXIT for ${walletAddress}. PnL for this tranche: ${(pnlRatio * 100).toFixed(2)}%`);
                    }
                }
                else {
                    console.log(`[WalletProfiler] Sell detected for ${walletAddress}, but no OPEN position found in DB.`);
                }
            }
        }
        catch (error) {
            console.error(`[WalletProfiler] Failed to process SELL for ${txHash}`, error);
        }
    }
    static async updateWalletMetrics(walletAddress, pnlRatio) {
        const wallet = await prisma.trackedWallet.findUnique({ where: { address: walletAddress } });
        if (!wallet)
            return;
        const isWin = pnlRatio > 0;
        const newTotal = wallet.totalSignals + 1;
        const currentWins = ((wallet.winRate || 0) / 100) * wallet.totalSignals;
        const newWinRate = ((currentWins + (isWin ? 1 : 0)) / newTotal) * 100;
        const currentAvgPnl = wallet.avgPnlR || 0;
        const newAvgPnl = ((currentAvgPnl * wallet.totalSignals) + pnlRatio) / newTotal;
        let newTier = wallet.tier;
        let newConsecutiveLosses = isWin ? 0 : wallet.consecutiveLosses + 1;
        let newStatus = wallet.status;
        // Automatic Tiering Logic
        if (newTotal >= 5) {
            // Promote to Tier 1 if win rate is excellent (>55%)
            if (newWinRate >= 55 && wallet.tier > 1) {
                newTier = 1;
                dbLogger.info(`🏆 WALLET PROMOTED: ${wallet.label || wallet.address} promoted to TIER 1! WinRate: ${newWinRate.toFixed(1)}%`, { wallet: wallet.address });
            }
            // Demote to Tier 3 if win rate is terrible (<35%)
            if (newWinRate < 35 && wallet.tier < 3) {
                newTier = 3;
                dbLogger.warn(`⚠️ WALLET DEMOTED: ${wallet.label || wallet.address} dropped to TIER 3 due to low WinRate (${newWinRate.toFixed(1)}%)`, { wallet: wallet.address });
            }
        }
        // Circuit Breaker: 3 Consecutive Losses
        if (newConsecutiveLosses >= 3 && newStatus === 'ACTIVE') {
            newStatus = 'PAUSED';
            dbLogger.error(`🚨 EMERGENCY PAUSE: ${wallet.label || wallet.address} hit 3 consecutive losses ON-CHAIN. Status set to PAUSED.`, { wallet: wallet.address });
        }
        await prisma.trackedWallet.update({
            where: { id: wallet.id },
            data: {
                totalSignals: newTotal,
                winRate: newWinRate,
                avgPnlR: newAvgPnl,
                consecutiveLosses: newConsecutiveLosses,
                tier: newTier,
                status: newStatus
            }
        });
    }
}
