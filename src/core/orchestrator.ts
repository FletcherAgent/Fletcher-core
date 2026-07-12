import { Bot } from 'grammy';
import { parseAbi } from 'viem';
import { publicClient } from '../services/viem.js';
import { ScoutAgent } from '../agents/scout.js';
import { TraderAgent } from '../agents/trader.js';
import { LpManagerAgent } from '../agents/lp.js';
import { RiskWardenAgent } from '../agents/risk.js';
import { GuardianAgent } from '../agents/guardian.js';

export class Orchestrator {
  private scout: ScoutAgent;
  private trader: TraderAgent;
  private lpManager: LpManagerAgent;
  private riskWarden: RiskWardenAgent;
  private guardian: GuardianAgent;

  constructor(bot: Bot) {
    this.scout = new ScoutAgent(bot);
    this.trader = new TraderAgent(bot);
    this.lpManager = new LpManagerAgent();
    this.riskWarden = new RiskWardenAgent();
    this.guardian = new GuardianAgent();

    // Wire up events
    this.guardian.onExitSignal = async (tokenAddress, reason) => {
      console.log(`[Orchestrator] Guardian requested exit for ${tokenAddress} (${reason}), forwarding to Trader...`);
      
      const walletAddress = process.env.USER_WALLET_ADDRESS;
      let tokenAmountToSell = 0n;

      if (walletAddress && walletAddress.startsWith('0x')) {
        try {
          const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
          tokenAmountToSell = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`]
          });
          console.log(`[Orchestrator] Fetched real token balance: ${tokenAmountToSell}`);
        } catch (e) {
          console.error(`[Orchestrator] Failed to fetch token balance for ${tokenAddress}`, e);
        }
      }

      if (tokenAmountToSell > 0n) {
        this.trader.processExitSignal(tokenAddress, tokenAmountToSell, reason);
      } else {
        console.warn(`[Orchestrator] Aborting exit signal: Wallet has 0 balance for ${tokenAddress}`);
      }
    };

    this.scout.onSignal = async (tokenAddress) => {
      console.log(`[Orchestrator] Received signal for ${tokenAddress}, consulting Risk Warden...`);
      
      const riskEvaluation = await this.riskWarden.evaluateSignal(tokenAddress);
      
      if (riskEvaluation.approved) {
        console.log(`[Orchestrator] Risk Warden approved. Forwarding to Trader with size ${riskEvaluation.recommendedSize}...`);
        this.trader.processSignal(tokenAddress, riskEvaluation.recommendedSize);
        
        // Simulating the post-fill workflow: Start Guardian monitoring immediately
        this.guardian.startMonitoring(tokenAddress, riskEvaluation.recommendedSize);
      } else {
        console.warn(`[Orchestrator] Risk Warden rejected signal for ${tokenAddress}. Reason: ${riskEvaluation.reason}`);
      }
    };
  }

  /**
   * Manually injects a token into the pipeline (Useful for Dry Run / Telegram commands)
   */
  public injectManualSignal(tokenAddress: string) {
    console.log(`[Orchestrator] 🧪 Manual Dry Run injected for ${tokenAddress}`);
    // We bypass Scout's listener and force it to score this token
    (this.scout as any).scoreLaunch(tokenAddress);
  }

  public setTraderMode(mode: 'AUTO' | 'CONFIRM') {
    this.trader.executionMode = mode;
    console.log(`[Orchestrator] Trader execution mode set to ${mode}`);
  }

  public async startAll() {
    console.log("🚀 Orchestrator: Starting all Fletcher agents (Minimum Viable Swarm)...");
    
    // Start monitoring for new token launches
    await this.scout.startListening();
  }
}
