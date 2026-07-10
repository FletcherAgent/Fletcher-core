import { Bot } from 'grammy';
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
    this.scout = new ScoutAgent();
    this.trader = new TraderAgent(bot);
    this.lpManager = new LpManagerAgent();
    this.riskWarden = new RiskWardenAgent();
    this.guardian = new GuardianAgent();

    // Wire up events
    this.guardian.onExitSignal = (tokenAddress, reason) => {
      console.log(`[Orchestrator] Guardian requested exit for ${tokenAddress} (${reason}), forwarding to Trader...`);
      // Simulating a dummy token amount for exit
      const tokenAmountToSell = BigInt(1000 * 10**18); 
      this.trader.processExitSignal(tokenAddress, tokenAmountToSell, reason);
    };

    this.scout.onSignal = (tokenAddress) => {
      console.log(`[Orchestrator] Received signal for ${tokenAddress}, consulting Risk Warden...`);
      
      const riskEvaluation = this.riskWarden.evaluateSignal(tokenAddress);
      
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

  public async startAll() {
    console.log("🚀 Orchestrator: Starting all Fletcher agents (Minimum Viable Swarm)...");
    
    // Start monitoring for new token launches
    await this.scout.startListening();
  }
}
