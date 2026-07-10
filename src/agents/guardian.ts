import { publicClient } from '../services/viem.js';
import { parseAbi } from 'viem';

export class GuardianAgent {
  public onExitSignal?: (tokenAddress: string, reason: string) => void;
  
  private activeIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor() {}

  /**
   * Starts an interval loop to continuously monitor an open position using real Quoter data.
   */
  public async startMonitoring(tokenAddress: string, size: bigint) {
    console.log(`[Guardian] Starting active monitoring for token ${tokenAddress} (Size: ${size} wei)...`);
    
    const quoterAbi = parseAbi([
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ]);
    const WETH_ADDRESS = process.env.WETH_ADDRESS!; 
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS!;

    // Fetch initial quote as the entry baseline
    let initialQuote = 0n;
    try {
      const { result } = await publicClient.simulateContract({
        address: QUOTER_ADDRESS as `0x${string}`,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [tokenAddress as `0x${string}`, WETH_ADDRESS as `0x${string}`, 3000, size, 0n] // Simulating selling the whole size
      });
      initialQuote = result;
      console.log(`[Guardian] 📌 Baseline Entry Quote for ${tokenAddress}: ${initialQuote} WETH`);
    } catch (e) {
      console.error(`[Guardian] Failed to fetch initial baseline for ${tokenAddress}`, e);
      return;
    }

    // Polling every 10 seconds
    const intervalId = setInterval(async () => {
      console.log(`[Guardian] 🔍 Polling current price for ${tokenAddress}...`);
      
      try {
        const { result: currentQuote } = await publicClient.simulateContract({
          address: QUOTER_ADDRESS as `0x${string}`,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [tokenAddress as `0x${string}`, WETH_ADDRESS as `0x${string}`, 3000, size, 0n]
        });

        console.log(`[Guardian] Current Quote: ${currentQuote} WETH (Baseline: ${initialQuote})`);
        
        // 1. Check Take Profit (+50% -> 1.5x)
        const tpTarget = (initialQuote * 150n) / 100n;
        if (currentQuote >= tpTarget) {
          console.log(`[Guardian] 📈 TARGET REACHED: +50% TP hit for ${tokenAddress}!`);
          this.triggerExit(tokenAddress, "TAKE_PROFIT_50");
        } 
        // 2. Check Rug/Emergency (Dropped by 90%)
        else if (currentQuote <= (initialQuote * 10n) / 100n) {
          console.log(`[Guardian] 🚨 EMERGENCY: Massive liquidity drop detected for ${tokenAddress}!`);
          this.triggerExit(tokenAddress, "EMERGENCY_RUG");
        }

      } catch (err) {
        console.warn(`[Guardian] ⚠️ Failed to fetch current quote for ${tokenAddress} - pool might be rugged!`);
        this.triggerExit(tokenAddress, "EMERGENCY_RUG_NO_QUOTES");
      }
      
    }, 10000); // 10 seconds

    this.activeIntervals.set(tokenAddress, intervalId);
  }

  /**
   * Triggers an exit and stops monitoring.
   */
  private triggerExit(tokenAddress: string, reason: string) {
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
