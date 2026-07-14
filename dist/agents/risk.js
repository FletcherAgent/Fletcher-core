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
        // 1. Check Portfolio Heat (Circuit Breaker)
        const activePositionsCount = await prisma.position.count({
            where: { status: 'OPEN' }
        });
        if (activePositionsCount >= this.MAX_HEAT) {
            const msg = `Signal rejected: Portfolio Heat Cap Reached (${activePositionsCount}/${this.MAX_HEAT})`;
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
        // 4. Fixed-fractional sizing (0.5% of real balance)
        const fractionBps = BigInt(Math.floor(this.RISK_FRACTION * 10000)); // 50
        const recommendedSize = (currentBalance * fractionBps) / 10000n;
        console.log(`[Risk Warden] ✅ APPROVED: Risk gates passed. Assigned size: ${recommendedSize} wei (from total balance ${currentBalance})`);
        return {
            approved: true,
            recommendedSize,
            reason: 'RISK_GATES_PASSED'
        };
    }
}
