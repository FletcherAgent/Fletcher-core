import { publicClient } from '../services/viem.js';
import { prisma } from '../core/db.js';
import { dbLogger } from '../services/logger.js';
export class RiskWardenAgent {
    MAX_HEAT = 5; // Max 5 active trades at once
    RISK_FRACTION = 0.005; // 0.5% risk per trade
    MAX_DAILY_DRAWDOWN = 0.15; // 15% max daily drawdown
    constructor() { }
    /**
     * Evaluates if a signal passes the hard risk gates.
     */
    async evaluateSignal(tokenAddress) {
        console.log(`[Risk Warden] Evaluating signal for ${tokenAddress}`);
        const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
        const currentMode = config ? config.value : 'LIVE';
        // 1. Check Portfolio Heat (Circuit Breaker) per mode
        const activePositionsCount = await prisma.position.count({
            where: { status: { in: ['OPEN', 'PENDING', 'EXITING'] }, tradingMode: currentMode }
        });
        // Include LP Engine positions in global heat per mode
        const activeLPCount = await prisma.lPPosition.count({
            where: { status: { in: ['OPEN', 'PENDING'] }, tradingMode: currentMode }
        });
        const totalHeat = activePositionsCount + activeLPCount;
        if (totalHeat >= this.MAX_HEAT) {
            const msg = `Signal rejected: Portfolio Heat Cap Reached (Trench: ${activePositionsCount} + LP: ${activeLPCount} >= ${this.MAX_HEAT})`;
            console.warn(`[Risk Warden] 🚨 ` + msg);
            dbLogger.warn(msg, { token: tokenAddress, reason: 'PORTFOLIO_HEAT_CAP_EXCEEDED' });
            return { approved: false, recommendedSize: 0n, reason: 'PORTFOLIO_HEAT_CAP_EXCEEDED' };
        }
        // 2. Fetch real balance
        const walletAddress = process.env.USER_WALLET_ADDRESS;
        if (!walletAddress || !walletAddress.startsWith('0x')) {
            console.warn(`[Risk Warden] 🚨 REJECTED: USER_WALLET_ADDRESS is missing or invalid in .env`);
            return { approved: false, recommendedSize: 0n, reason: 'MISSING_WALLET_ADDRESS' };
        }
        let currentBalance = 0n;
        try {
            currentBalance = await publicClient.getBalance({ address: walletAddress });
        }
        catch (e) {
            console.error(`[Risk Warden] Failed to fetch balance for ${walletAddress}`, e);
            dbLogger.error(`Risk: RPC error fetching wallet balance`, { wallet: walletAddress, error: String(e) });
            return { approved: false, recommendedSize: 0n, reason: 'RPC_ERROR_FETCHING_BALANCE' };
        }
        if (currentBalance === 0n) {
            const msg = `Signal rejected: Wallet balance is zero`;
            console.warn(`[Risk Warden] 🚨 ` + msg);
            dbLogger.warn(msg, { token: tokenAddress, wallet: walletAddress });
            return { approved: false, recommendedSize: 0n, reason: 'INSUFFICIENT_FUNDS' };
        }
        // 3. Check Daily Drawdown (15%)
        try {
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            const closedPositionsToday = await prisma.position.findMany({
                where: {
                    status: 'CLOSED',
                    updatedAt: { gte: today }
                }
            });
            let totalPnL = 0;
            for (const pos of closedPositionsToday) {
                if (pos.exitPrice && pos.entryPrice) {
                    const profit = (pos.exitPrice - pos.entryPrice) * pos.size;
                    totalPnL += profit;
                }
            }
            // Approximate starting balance = currentBalance - totalPnL (in wei)
            const totalPnLWei = BigInt(Math.floor(totalPnL * 1e18));
            const startOfDayBalance = currentBalance - totalPnLWei;
            if (startOfDayBalance > 0n && totalPnLWei < 0n) {
                // Drawdown is positive (since totalPnLWei is negative)
                const drawdownFraction = Number(-totalPnLWei) / Number(startOfDayBalance);
                if (drawdownFraction > this.MAX_DAILY_DRAWDOWN) {
                    console.warn(`[Risk Warden] 🚨 REJECTED: Daily Drawdown of ${(drawdownFraction * 100).toFixed(2)}% exceeds limit of ${this.MAX_DAILY_DRAWDOWN * 100}%.`);
                    return { approved: false, recommendedSize: 0n, reason: 'MAX_DAILY_DRAWDOWN_EXCEEDED' };
                }
            }
        }
        catch (e) {
            console.error(`[Risk Warden] Failed to calculate daily drawdown`, e);
            // We don't reject here to avoid DB issues blocking trades, but log error
        }
        // 4. Base size 0.014 ETH + Full Compound (All historical PnL)
        const baseSize = 14000000000000000n; // 0.014 ETH
        const allClosedPositions = await prisma.position.findMany({
            where: { status: 'CLOSED' }
        });
        let totalHistoricalPnL = 0;
        for (const pos of allClosedPositions) {
            if (pos.exitPrice && pos.entryPrice) {
                const profit = (pos.exitPrice - pos.entryPrice) * pos.size;
                totalHistoricalPnL += profit;
            }
        }
        const totalHistoricalPnLWei = BigInt(Math.floor(totalHistoricalPnL * 1e18));
        let recommendedSize = baseSize;
        // Full compound: Add historical profits to the base size
        if (totalHistoricalPnLWei > 0n) {
            recommendedSize += totalHistoricalPnLWei;
        }
        // Safety check: Don't exceed current balance, leave 0.002 ETH for gas buffer
        const gasBuffer = 2000000000000000n; // 0.002 ETH
        const maxAffordable = currentBalance > gasBuffer ? currentBalance - gasBuffer : 0n;
        if (recommendedSize > maxAffordable) {
            recommendedSize = maxAffordable;
        }
        console.log(`[Risk Warden] ✅ APPROVED: Risk gates passed. Assigned size: ${recommendedSize} wei (from total balance ${currentBalance})`);
        return {
            approved: true,
            recommendedSize,
            reason: 'RISK_GATES_PASSED'
        };
    }
}
