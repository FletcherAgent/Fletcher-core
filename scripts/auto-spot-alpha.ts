import 'dotenv/config';
import { Bot } from 'grammy';
import { prisma, connectDb } from '../src/core/db.js';
import { TraderAgent } from '../src/agents/trader.js';
import { getSessionKeyClient } from '../src/services/sessionKey.js';
import { parseAbi, encodeFunctionData, erc20Abi } from 'viem';
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
  console.log(`\n⏳ Running ALPHA SPOT Strategy Engine for Agent: ${agent.name}...`);
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
    
    // 3. Prepare Batch Calls for UserOperation
    const wethAddress = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'; // Robinhood Chain WETH
    const permit2Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // Canonical Permit2 (deployed on Robinhood)
    const PERMIT2_AMOUNT_MAX = BigInt('0xffffffffffffffffffffffffffffffffffffffff'); // uint160 max
    const PERMIT2_EXPIRY_MAX = 281474976710655; // uint48 max

    // Ensure the agent has enough WETH
    const agentWethBalance = await publicClient.readContract({
      address: wethAddress as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [agentAccount.address]
    });
    console.log(`💰 Agent WETH Balance: ${Number(agentWethBalance)/1e18}`);
    if (agentWethBalance < sizeInWeth) {
      console.error(`❌ Agent does not have enough WETH. Needed: ${Number(sizeInWeth)/1e18}`);
      return;
    }

    // We must dynamically import buildAndSendLPUserOperation from sessionKey.js
    const { buildAndSendLPUserOperation } = await import('../src/services/sessionKey.js');

    const calls: any[] = [];

    // Step A: ERC20 approve WETH -> Permit2 (if needed, for Permit2 to pull WETH)
    const wethToPermit2Allowance = await publicClient.readContract({
      address: wethAddress as `0x${string}`, abi: erc20Abi, functionName: 'allowance', args: [agentAccount.address, permit2Address as `0x${string}`]
    });
    if (wethToPermit2Allowance < sizeInWeth) {
      console.log(`🔓 Adding WETH→Permit2 ERC20 Approval to batch`);
      calls.push({
        target: wethAddress,
        data: encodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [permit2Address as `0x${string}`, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")] })
      });
    } else {
      console.log(`✅ WETH→Permit2 ERC20 Approval already sufficient.`);
    }

    // Step B: Permit2.approve(WETH, UniversalRouter, amount, expiry) — grant UR to spend WETH via Permit2
    const permit2Abi = parseAbi(['function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)', 'function approve(address token, address spender, uint160 amount, uint48 expiration) external']);
    const [p2Amount, p2Expiry] = await publicClient.readContract({
      address: permit2Address as `0x${string}`, abi: permit2Abi, functionName: 'allowance', args: [agentAccount.address, wethAddress as `0x${string}`, swapData.toAddress]
    }) as [bigint, number, number];
    
    if (p2Amount < sizeInWeth || p2Expiry < Math.floor(Date.now() / 1000) + 300) {
      console.log(`🔓 Adding Permit2→UniversalRouter approval to batch (router: ${swapData.toAddress})`);
      calls.push({
        target: permit2Address,
        data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [wethAddress as `0x${string}`, swapData.toAddress, PERMIT2_AMOUNT_MAX, PERMIT2_EXPIRY_MAX] })
      });
    } else {
      console.log(`✅ Permit2 approval for UniversalRouter already sufficient.`);
    }

    console.log(`📦 Adding Swap Call to batch (Recipient: ${agentAccount.address})`);
    calls.push({
      target: swapData.toAddress,
      data: swapData.calldata as `0x${string}`,
      value: swapData.value ?? BigInt(0)
    });

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
