import 'dotenv/config';
import { Bot } from 'grammy';
import { prisma, connectDb } from '../src/core/db.js';
import { TraderAgent } from '../src/agents/trader.js';
import { getSessionKeyClient } from '../src/services/sessionKey.js';
import { erc20Abi } from 'viem';
import { publicClient } from '../src/services/viem.js';

async function main() {
  await connectDb();
  // Using the same agent as auto-trade.ts
  const agentId = 'd545991c-1b8c-4d38-a3c7-3a5ab7e78cc0'; 
  
  console.log(`🔍 Checking agent ${agentId}...`);
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { user: true } });
  
  if (!agent) {
    console.error('❌ Agent for @MaxCashGuy not found in database.');
    return;
  }
  
  if (agent.mode !== 'FULL') {
    console.log(`⚠️ Agent is not in FULL mode. Updating to FULL...`);
    await prisma.agent.update({ where: { id: agent.id }, data: { mode: 'FULL' } });
    console.log(`✅ Agent mode updated to FULL.`);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || 'dummy_token';
  const bot = new Bot(botToken);
  const trader = new TraderAgent(bot);

  const args = process.argv.slice(2);
  const targetToken = args[0];

  if (!targetToken || !targetToken.startsWith('0x') || targetToken.length !== 42) {
    console.error('❌ Please provide a valid token address as an argument.');
    console.error('Usage: npx tsx scripts/auto-spot-alpha.ts <token_address>');
    process.exit(1);
  }
  console.log(`\n⏳ Running SPOT Strategy Engine for Agent: ${agent.name}...`);
  console.log(`🚀 Target Token: ${targetToken}`);
  
  try {
    // 1. Get Agent Session Key Client
    console.log(`\n🔑 Initializing Agent Smart Wallet Session...`);
    const agentClient = await getSessionKeyClient('FULL', 3, true, agent.user.walletAddress);
    const agentAccount = agentClient.account;
    console.log(`✅ Agent Smart Wallet: ${agentAccount.address}`);

    // 2. Fetch Size from SystemConfig and Construct Swap Calldata
    let sizeInWeth = BigInt("10000000000000"); // Default 0.00001 WETH
    const configSize = await prisma.systemConfig.findUnique({ where: { key: 'ALPHA_BUY_SIZE' } });
    if (configSize && configSize.value) {
      const parsedSize = parseFloat(configSize.value);
      if (!isNaN(parsedSize) && parsedSize > 0) {
        sizeInWeth = BigInt(Math.floor(parsedSize * 1e18));
      }
    }

    console.log(`\n⚙️ Constructing Swap Transaction for ${Number(sizeInWeth)/1e18} WETH...`);
    const swapData = await trader.constructUnsignedSwapTx(targetToken, sizeInWeth, undefined, agentAccount.address);
    
    if (!swapData) {
      console.error(`❌ Failed to construct swap calldata.`);
      return;
    }
    
    // 3. Prepare Calls for UserOperation
    // The swap flow sends native ETH as msg.value (UR wraps it → swaps → refunds leftover as ETH)
    // No WETH approvals or Permit2 needed.
    const swapValue = swapData.value ?? BigInt(0);
    
    // Check agent has enough native ETH for the swap
    const agentEthBalance = await publicClient.getBalance({ address: agentAccount.address });
    console.log(`💰 Agent ETH Balance: ${Number(agentEthBalance)/1e18} ETH`);
    console.log(`💸 Swap requires: ${Number(swapValue)/1e18} ETH (as msg.value)`);
    if (agentEthBalance < swapValue) {
      console.error(`❌ Agent does not have enough ETH. Needed: ${Number(swapValue)/1e18} ETH`);
      return;
    }

    // We must dynamically import buildAndSendLPUserOperation from sessionKey.js
    const { buildAndSendLPUserOperation } = await import('../src/services/sessionKey.js');

    console.log(`📦 Adding Swap Call to batch (Recipient: ${agentAccount.address})`);
    const calls: any[] = [{
      target: swapData.toAddress,
      data: swapData.calldata as `0x${string}`,
      value: swapValue
    }];

    // 4. Execute Swap Batch via Alchemy Bundler
    console.log(`\n⚡ Broadcasting SPOT BUY batch transaction from Agent Wallet...`);

    console.log(`   - Sender Wallet (Gas Payer): ${agentAccount.address}`);
    console.log(`   - Destination Token: ${targetToken}`);
    console.log(`   - Target Router: ${swapData.toAddress}`);
    
    let txHash;
    try {
      txHash = await buildAndSendLPUserOperation(agentClient, calls);
      console.log(`✅ Transaction Mined! Hash: ${txHash}`);
    } catch (error: any) {
      console.error(`❌ Transaction failed during UserOperation broadcast!`);
      console.error(`   - Agent Wallet: ${agentAccount.address}`);
      console.error(`   - Error Details:`, error.message || error);
      process.exit(1);
    }

    // 5. Register in DB
    console.log(`\n💾 Registering position in DB...`);
    let tokenName = 'Unknown', tokenSymbol = 'UNK';
    try {
      tokenName = await publicClient.readContract({ address: targetToken as `0x${string}`, abi: erc20Abi, functionName: 'name' }) as string;
      tokenSymbol = await publicClient.readContract({ address: targetToken as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }) as string;
    } catch(e) {}

    const entryPrice = Number(sizeInWeth) / Number(swapData.expectedOut);

    const modeConfig = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const currentMode = modeConfig ? modeConfig.value : 'LIVE';

    const position = await prisma.position.create({
      data: {
        userId: agent.userId,
        agentId: agent.id,
        tokenAddress: targetToken,
        tokenName,
        tokenSymbol,
        type: 'TRENCH',
        status: 'OPEN',
        entryPrice: entryPrice,
        size: Number(sizeInWeth)/1e18,
        txHash: txHash,
        source: 'ALPHA',
        tradingMode: currentMode
      }
    });
    console.log(`✅ DB Record Created! Position ID: ${position.id}`);
    
  } catch (err) {
    console.error(`❌ Error during auto spot trade test:`, err);
  }
  
  console.log(`\n(You can now safely press Ctrl+C to exit)`);
}

main().catch(console.error);
