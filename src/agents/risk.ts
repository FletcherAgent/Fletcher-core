import { publicClient } from '../services/viem.js';

export class RiskWardenAgent {
  private activeTradesCount: number = 0;
  private readonly MAX_HEAT = 5; // Max 5 active trades at once
  private readonly RISK_FRACTION = 0.005; // 0.5% risk per trade

  constructor() {}

  /**
   * Evaluates if a signal passes the hard risk gates.
   */
  public async evaluateSignal(tokenAddress: string): Promise<{ approved: boolean; recommendedSize: bigint; reason: string }> {
    console.log(`[Risk Warden] Evaluating signal for ${tokenAddress}`);

    // 1. Check Portfolio Heat (Circuit Breaker)
    if (this.activeTradesCount >= this.MAX_HEAT) {
      console.warn(`[Risk Warden] 🚨 REJECTED: Portfolio Heat Cap Reached (${this.activeTradesCount}/${this.MAX_HEAT}).`);
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
      currentBalance = await publicClient.getBalance({ address: walletAddress as `0x${string}` });
    } catch (e) {
      console.error(`[Risk Warden] Failed to fetch balance for ${walletAddress}`, e);
      return { approved: false, recommendedSize: 0n, reason: 'RPC_ERROR_FETCHING_BALANCE' };
    }

    if (currentBalance === 0n) {
      console.warn(`[Risk Warden] 🚨 REJECTED: Wallet balance is zero.`);
      return { approved: false, recommendedSize: 0n, reason: 'INSUFFICIENT_FUNDS' };
    }

    // 3. Fixed-fractional sizing (0.5% of real balance)
    const fractionBps = BigInt(Math.floor(this.RISK_FRACTION * 10000)); // 50
    const recommendedSize = (currentBalance * fractionBps) / 10000n;

    console.log(`[Risk Warden] ✅ APPROVED: Risk gates passed. Assigned size: ${recommendedSize} wei (from total balance ${currentBalance})`);
    
    // Increment heat temporarily (in a real system, this is decremented on exit)
    this.activeTradesCount++;

    return {
      approved: true,
      recommendedSize,
      reason: 'RISK_GATES_PASSED'
    };
  }
}
