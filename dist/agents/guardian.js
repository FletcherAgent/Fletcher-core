import { publicClient } from '../services/viem.js';
import { parseAbi } from 'viem';
export class GuardianAgent {
    onExitSignal;
    activeIntervals = new Map();
    constructor() { }
    isMonitoring(tokenAddress) {
        return this.activeIntervals.has(tokenAddress);
    }
    /**
     * Starts an interval loop to continuously monitor an open position using real Quoter data.
     */
    async startMonitoring(tokenAddress, size) {
        console.log(`[Guardian] Starting active monitoring for token ${tokenAddress} (Size: ${size} wei)...`);
        const quoterAbi = parseAbi([
            'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
        ]);
        const WETH_ADDRESS = process.env.WETH_ADDRESS;
        const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
        let initialQuote = 0n;
        try {
            const result = await publicClient.readContract({
                address: QUOTER_ADDRESS,
                abi: quoterAbi,
                functionName: 'quoteExactInputSingle',
                args: [tokenAddress, WETH_ADDRESS, 3000, size, 0n] // Reading price quote
            });
            initialQuote = result;
            console.log(`[Guardian] 📌 Baseline Entry Quote for ${tokenAddress}: ${initialQuote} WETH`);
        }
        catch (e) {
            console.error(`[Guardian] Failed to fetch initial baseline for ${tokenAddress}`, e);
            return;
        }
        let highestQuote = initialQuote;
        // Polling every 10 seconds
        const intervalId = setInterval(async () => {
            console.log(`[Guardian] 🔍 Polling current price for ${tokenAddress}...`);
            try {
                const currentQuote = await publicClient.readContract({
                    address: QUOTER_ADDRESS,
                    abi: quoterAbi,
                    functionName: 'quoteExactInputSingle',
                    args: [tokenAddress, WETH_ADDRESS, 3000, size, 0n]
                });
                // Update High Watermark
                if (currentQuote > highestQuote) {
                    highestQuote = currentQuote;
                    console.log(`[Guardian] 🚀 New High Watermark for ${tokenAddress}: ${highestQuote} WETH`);
                }
                else {
                    console.log(`[Guardian] Current Quote: ${currentQuote} WETH (Highest: ${highestQuote}, Entry: ${initialQuote})`);
                }
                // 1. Fixed Take Profit (+50% -> 1.5x)
                const tpTarget = (initialQuote * 150n) / 100n;
                if (currentQuote >= tpTarget) {
                    console.log(`[Guardian] 📈 TARGET REACHED: +50% TP hit for ${tokenAddress}!`);
                    this.triggerExit(tokenAddress, "FIXED_TAKE_PROFIT_50");
                    return;
                }
                // 2. Fixed Stop-Loss (-30% from entry)
                const slTarget = (initialQuote * 70n) / 100n;
                if (currentQuote <= slTarget) {
                    console.log(`[Guardian] 📉 STOP-LOSS HIT: -30% from entry for ${tokenAddress}!`);
                    this.triggerExit(tokenAddress, "FIXED_STOP_LOSS_30");
                    return;
                }
                // 3. Trailing Take-Profit (-30% from peak)
                // Only activates if we are actually trailing a peak that is higher than entry
                if (highestQuote > initialQuote) {
                    const trailingSlTarget = (highestQuote * 70n) / 100n;
                    if (currentQuote <= trailingSlTarget) {
                        console.log(`[Guardian] 📉 TRAILING TAKE-PROFIT HIT: -30% from peak for ${tokenAddress}!`);
                        this.triggerExit(tokenAddress, "TRAILING_TAKE_PROFIT_30");
                        return;
                    }
                }
                // 4. Emergency Rug Failsafe (-90% from peak)
                const emergencyTarget = (highestQuote * 10n) / 100n;
                if (currentQuote <= emergencyTarget) {
                    console.log(`[Guardian] 🚨 EMERGENCY: Massive liquidity drop detected for ${tokenAddress}!`);
                    this.triggerExit(tokenAddress, "EMERGENCY_RUG");
                    return;
                }
            }
            catch (err) {
                console.warn(`[Guardian] ⚠️ Failed to fetch current quote for ${tokenAddress} - pool might be rugged!`);
                this.triggerExit(tokenAddress, "EMERGENCY_RUG_NO_QUOTES");
            }
        }, 10000); // 10 seconds
        this.activeIntervals.set(tokenAddress, { intervalId, initialQuote, highestQuote });
    }
    /**
     * Triggers an exit and stops monitoring.
     */
    triggerExit(tokenAddress, reason) {
        console.log(`[Guardian] Triggering exit sequence for ${tokenAddress}. Reason: ${reason}`);
        // Stop the interval loop
        const record = this.activeIntervals.get(tokenAddress);
        if (record) {
            clearInterval(record.intervalId);
            this.activeIntervals.delete(tokenAddress);
        }
        // Fire the event back to the orchestrator
        if (this.onExitSignal) {
            this.onExitSignal(tokenAddress, reason);
        }
    }
}
