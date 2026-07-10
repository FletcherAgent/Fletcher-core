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
  }

  public async startAll() {
    console.log("🚀 Orchestrator: Starting all Fletcher agents (Minimum Viable Swarm)...");
    
    // Start monitoring for new token launches
    await this.scout.startListening();
  }
}
