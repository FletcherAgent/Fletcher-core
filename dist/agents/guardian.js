export class GuardianAgent {
    onExitSignal;
    activeIntervals = new Map();
    constructor() { }
    /**
     * Starts an interval loop to continuously monitor an open position.
     */
    startMonitoring(tokenAddress, size) {
        console.log(`[Guardian] Starting active monitoring for token ${tokenAddress} (Size: ${size} wei)...`);
        // Simulate checking every 10 seconds
        const intervalId = setInterval(async () => {
            console.log(`[Guardian] 🔍 Polling current price for ${tokenAddress}...`);
            // Simulating a random price movement
            const randomOutcome = Math.random();
            if (randomOutcome > 0.9) {
                // 10% chance to simulate hitting +50% Take Profit
                console.log(`[Guardian] 📈 TARGET REACHED: +50% TP hit for ${tokenAddress}!`);
                this.triggerExit(tokenAddress, "TAKE_PROFIT_50");
            }
            else if (randomOutcome < 0.05) {
                // 5% chance to simulate a rug/emergency
                console.log(`[Guardian] 🚨 EMERGENCY: Liquidity pull detected for ${tokenAddress}!`);
                this.triggerExit(tokenAddress, "EMERGENCY_RUG");
            }
        }, 10000); // 10 seconds
        this.activeIntervals.set(tokenAddress, intervalId);
    }
    /**
     * Triggers an exit and stops monitoring.
     */
    triggerExit(tokenAddress, reason) {
        console.log(`[Guardian] Triggering exit sequence for ${tokenAddress}. Reason: ${reason}`);
        // Stop the interval loop
        const intervalId = this.activeIntervals.get(tokenAddress);
        if (intervalId) {
            clearInterval(intervalId);
            this.activeIntervals.delete(tokenAddress);
        }
        // Fire the event back to the orchestrator
        if (this.onExitSignal) {
            this.onExitSignal(tokenAddress, reason);
        }
    }
}
