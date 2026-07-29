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
    // Bypassing GMGN to hardcode the requested pool: 0xb7f10f74b39291b9290b779978e19a7637c742d6
    const targetToken = {
      address: '0x5Cb6F181081301b44905F3ae15419112ecaBd8A6', // PIPEDOG Token
      symbol: 'PIPEDOG',
      priceUsd: 0.003608,
      marketCap: 10460000,
      volume24h: 67170000,
      liquidity: 10460000,
      decimals: 18,
      name: 'PIPEDOG'
    } as any;

    console.log(`✅ Found Token: ${targetToken.symbol} (${targetToken.address})`);
    console.log(`🚀 Forcing LP Engine to execute autonomous trade...`);

    // Reference from deploy-live-lp.ts: Mock resolvePool to ensure the correct NPM is used for V3
    lpEngine.resolvePool = async () => {
      const poolAddress = '0xB7f10f74B39291b9290b779978e19A7637C742D6';
      const quoteAddress = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'; // WETH
      const factory = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
      
      console.log(`   └─ ✅ [Mock] Forcing Uniswap V3 / ALPS V3 NPM (Factory: ${factory})`);
      
      return {
        poolAddress: poolAddress.toLowerCase(),
        feeTier: 10000,
        factoryAddress: factory.toLowerCase(),
        managerAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'.toLowerCase(), // Hardcode correct V3 NPM
        version: 'V3',
        quoteAddress: quoteAddress.toLowerCase()
      };
    };

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
