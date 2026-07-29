import { Bot } from 'grammy';
import * as dotenv from 'dotenv';
dotenv.config();
import { Orchestrator } from '../src/core/orchestrator.js';
import { prisma, connectDb } from '../src/core/db.js';

async function main() {
  await connectDb();
  const agentId = 'd545991c-1b8c-4d38-a3c7-3a5ab7e78cc0';
  
  console.log(`🔍 Checking agent ${agentId}...`);
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  
  if (!agent) {
    console.error('❌ Agent not found in database.');
    return;
  }
  
  if (agent.mode !== 'FULL') {
    console.log(`⚠️ Agent is not in FULL mode. Updating to FULL...`);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { mode: 'FULL' }
    });
    console.log(`✅ Agent mode updated to FULL.`);
  } else {
    console.log(`✅ Agent is already in FULL mode.`);
  }

  console.log(`🚀 Starting Orchestrator to trigger a REAL autonomous scan & trade...`);
  const botToken = process.env.TELEGRAM_BOT_TOKEN || 'dummy_token';
  const bot = new Bot(botToken);
  const orchestrator = new Orchestrator(bot);
  const lpEngine = orchestrator.getLPEngine();
  
  // Wait a moment for orchestrator to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`\n⏳ Running Strategy Engine (Live Scan)...`);
  console.log(`This will fetch real data from GMGN and FORCE open a real LP transaction on-chain for your agent!`);
  
  try {
    const { screenPairs } = await import('../src/services/gmgn.js');
    const candidates = await screenPairs();
    
    if (candidates.length === 0) {
      console.log(`❌ No tokens passed screening on GMGN right now. Try again later.`);
      return;
    }

    const targetToken = candidates[0].token;
    console.log(`✅ Found Token: ${targetToken.symbol} (${targetToken.address})`);
    console.log(`🚀 Forcing LP Engine to execute autonomous trade...`);

    await lpEngine.proposeOpenPosition(
      { token: targetToken, score: 100 },
      { 
        dayMode: false, nightMode: true, strategyMode: false, 
        lowerPct: 0.91, upperPct: 1.05, source: 'AUTONOMOUS',
        agentId: agent.id,
        wallet: agent.smartAccountAddress || undefined,
        mode: 'FULL'
      }
    );

    console.log(`\n✅ Autonomous trade successfully initiated! Check the dashboard!`);
  } catch (err) {
    console.error(`❌ Error during auto trade test:`, err);
  }
  
  console.log(`(You can now safely press Ctrl+C to exit)`);
}

main().catch(console.error);
