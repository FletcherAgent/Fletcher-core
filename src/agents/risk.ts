export class RiskWardenAgent {
  private activeTradesCount: number = 0;
  private readonly MAX_HEAT = 5; // Max 5 active trades at once
  private readonly BASE_CAPITAL_WETH = BigInt(10 * 10**18); // 10 ETH
  private readonly RISK_FRACTION = 0.005; // 0.5% risk per trade

  constructor() {}

  /**
   * Evaluates if a signal passes the hard risk gates.
   */
  public evaluateSignal(tokenAddress: string): { approved: boolean; recommendedSize: bigint; reason: string } {
    console.log(`[Risk Warden] Evaluating signal for ${tokenAddress}`);

    // 1. Check Portfolio Heat (Circuit Breaker)
    if (this.activeTradesCount >= this.MAX_HEAT) {
      console.warn(`[Risk Warden] 🚨 REJECTED: Portfolio Heat Cap Reached (${this.activeTradesCount}/${this.MAX_HEAT}).`);
      return { approved: false, recommendedSize: 0n, reason: 'PORTFOLIO_HEAT_CAP_EXCEEDED' };
    }

    // 2. Fixed-fractional sizing (0.5% of 10 ETH = 0.05 ETH)
    // We convert fraction to a safe integer multiplier for BigInt math
    const fractionBps = BigInt(Math.floor(this.RISK_FRACTION * 10000)); // 50
    const recommendedSize = (this.BASE_CAPITAL_WETH * fractionBps) / 10000n; // 0.05 ETH

    console.log(`[Risk Warden] ✅ APPROVED: Risk gates passed. Assigned size: ${recommendedSize} wei`);
    
    // Increment heat temporarily (in a real system, this is decremented on exit)
    this.activeTradesCount++;

    return {
      approved: true,
      recommendedSize,
      reason: 'RISK_GATES_PASSED'
    };
  }
}
