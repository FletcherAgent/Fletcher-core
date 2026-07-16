import { parseAbi, parseEther } from 'viem';
import { prisma } from '../core/db.js';
import { detectBestFee } from '../services/poolFeeDetector.js';
export class GuardianAgent {
    onExitSignal;
    activeIntervals = new Map();
    constructor() { }
    isMonitoring(tokenAddress) {
        return this.activeIntervals.has(tokenAddress);
    }
    /**
     * Initializes autonomous polling of database for OPEN positions.
     * This ensures resilience across bot restarts.
     */
    async init() {
        console.log(`[Guardian] 🛡️ Initializing autonomous DB polling for OPEN positions...`);
        // Poll every 15 seconds for unmonitored open positions
        setInterval(async () => {
            try {
                const openPositions = await prisma.position.findMany({ where: { status: 'OPEN' } });
                for (const pos of openPositions) {
                    if (!this.activeIntervals.has(pos.tokenAddress)) {
                        console.log(`[Guardian] 📡 Detected unmonitored OPEN position for ${pos.tokenAddress}. Starting monitoring...`);
                        this.startMonitoring(pos);
                    }
                }
            }
            catch (e) {
                console.error(`[Guardian] Error polling for open positions`, e);
            }
        }, 15000);
    }
    /**
     * Starts an interval loop to continuously monitor an open position using real Quoter data.
     */
    async startMonitoring(pos) {
        const tokenAddress = pos.tokenAddress;
        console.log(`[Guardian] Starting active monitoring for token ${tokenAddress} (Entry Price: ${pos.entryPrice} WETH/Token)...`);
        const quoterAbi = parseAbi([
            'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
        ]);
        const WETH_ADDRESS = process.env.WETH_ADDRESS;
        const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
        // Instead of passing the total wei we hold (which breaks Quoter on altcoins vs WETH), 
        // we query "How many altcoins do I get for 0.01 WETH?"
        const wethTestAmount = parseEther('0.01');
        const initialQuote = pos.entryPrice;
        let highestQuote = initialQuote;
        let failCount = 0;
        const startedAt = Date.now(); // We can also use pos.createdAt.getTime(), but let's stick to start of monitoring for time limits
        // Polling every 10 seconds
        const intervalId = setInterval(async () => {
            // console.log(`[Guardian] 🔍 Polling current price for ${tokenAddress}...`);
            try {
                // Query best active pool
                const { expectedOut: tokensOut } = await detectBestFee(WETH_ADDRESS, tokenAddress, wethTestAmount);
                // Calculate current exchange rate (WETH per 1 wei of Token)
                const currentQuote = Number(wethTestAmount) / Number(tokensOut);
                // Update High Watermark
                if (currentQuote > highestQuote) {
                    highestQuote = currentQuote;
                    console.log(`[Guardian] 🚀 New High Watermark for ${tokenAddress}: ${highestQuote} WETH`);
                }
                // 1. Fixed Take Profit (+50% -> 1.5x)
                const tpTarget = initialQuote * 1.5;
                if (currentQuote >= tpTarget) {
                    console.log(`[Guardian] 📈 TARGET REACHED: +50% TP hit for ${tokenAddress}!`);
                    this.triggerExit(pos, "FIXED_TAKE_PROFIT_50");
                    return;
                }
                // 2. Fixed Stop-Loss (-30% from entry)
                const slTarget = initialQuote * 0.7;
                if (currentQuote <= slTarget) {
                    console.log(`[Guardian] 📉 STOP-LOSS HIT: -30% from entry for ${tokenAddress}!`);
                    this.triggerExit(pos, "FIXED_STOP_LOSS_30");
                    return;
                }
                // 3. Trailing Take-Profit (-30% from peak)
                if (highestQuote > initialQuote) {
                    const trailingSlTarget = highestQuote * 0.7;
                    if (currentQuote <= trailingSlTarget) {
                        console.log(`[Guardian] 📉 TRAILING TAKE-PROFIT HIT: -30% from peak for ${tokenAddress}!`);
                        this.triggerExit(pos, "TRAILING_TAKE_PROFIT_30");
                        return;
                    }
                }
                // 4. Emergency Rug Failsafe (-90% from peak)
                const emergencyTarget = highestQuote * 0.1;
                if (currentQuote <= emergencyTarget) {
                    console.log(`[Guardian] 🚨 EMERGENCY: Massive liquidity drop detected for ${tokenAddress}!`);
                    this.triggerExit(pos, "EMERGENCY_RUG");
                    return;
                }
                // 5. Max Holding Time (Time Limit)
                const maxHoldMinutes = parseInt(process.env.MAX_HOLD_TIME_MINUTES || '30', 10);
                const MAX_HOLD_TIME_MS = maxHoldMinutes * 60 * 1000;
                if (Date.now() - pos.createdAt.getTime() > MAX_HOLD_TIME_MS) { // Using true creation time
                    console.log(`[Guardian] ⏳ MAX HOLD TIME EXCEEDED (${maxHoldMinutes} Minutes) for ${tokenAddress}!`);
                    this.triggerExit(pos, "TIME_LIMIT_EXCEEDED");
                    return;
                }
            }
            catch (err) {
                failCount++;
                console.warn(`[Guardian] ⚠️ Failed to fetch current quote for ${tokenAddress} - pool might be temporarily unavailable. (Fail count: ${failCount}/3)`);
                if (failCount >= 3) {
                    console.log(`[Guardian] ❌ Token ${tokenAddress} failed quoting 3 times. Marking as unsupported/rug.`);
                    this.triggerExit(pos, "UNSUPPORTED_OR_RUG_NO_QUOTES");
                }
            }
        }, 10000); // 10 seconds
        this.activeIntervals.set(tokenAddress, { intervalId, initialQuote, highestQuote, startedAt });
    }
    /**
     * Triggers an exit and stops monitoring.
     */
    triggerExit(pos, reason) {
        console.log(`[Guardian] Triggering exit sequence for ${pos.tokenAddress}. Reason: ${reason}`);
        // Stop the interval loop
        const record = this.activeIntervals.get(pos.tokenAddress);
        if (record) {
            clearInterval(record.intervalId);
            this.activeIntervals.delete(pos.tokenAddress);
        }
        // Fire the event back to the orchestrator
        if (this.onExitSignal) {
            this.onExitSignal(pos, reason);
        }
    }
}
