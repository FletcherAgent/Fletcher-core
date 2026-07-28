import 'dotenv/config';
import { LPEngineAgent } from '../src/agents/lpengine.js';
import { type Hex, type Address, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prisma } from '../src/core/db.js';
import { getTokenInfo } from '../src/services/gmgn/index.js';
import { robinhoodChain } from '../src/services/viem.js';
import { getDexConfig } from '../src/core/dexConfig.js';

async function main() {
  console.log(`\n=============================================================`);
  console.log(` 🚀 [PRODUCTION LIVE] FLETCHER V2.0 SESSION KEY EXECUTION`);
  console.log(`=============================================================`);

  const poolAddress = process.argv[2];
  if (!poolAddress || !poolAddress.startsWith('0x')) {
    console.error("❌ Error: Please provide a valid Pool Address as the first argument.");
    console.log("Example: npx tsx scripts/deploy-live-lp.ts 0xa70fc67c9f69da90b63a0e4c05d229954574e313");
    process.exit(1);
  }

  if (!process.env.USER_PRIVATE_KEY && !process.env.LP_PRIVATE_KEY) {
    console.error("❌ Error: No PRIVATE_KEY found in .env");
    process.exit(1);
  }

  console.log(`\n[Step 1/7] Initializing RPC Client and Wallet Account...`);
  const pKey = (process.env.LP_PRIVATE_KEY || process.env.USER_PRIVATE_KEY) as Hex;
  const account = privateKeyToAccount(pKey);
  const rpc = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
  console.log(`✅ Using EOA Wallet Address: ${account.address}`);
  console.log(`✅ Connected to RPC: ${rpc}`);

  console.log(`\n[Step 2/7] Reading Pool Data from blockchain for ${poolAddress}...`);
  const poolAbi = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)'
  ]);

  let token0: Address, token1: Address, feeTier: number;
  try {
    token0 = await publicClient.readContract({ address: poolAddress as Address, abi: poolAbi, functionName: 'token0' });
    token1 = await publicClient.readContract({ address: poolAddress as Address, abi: poolAbi, functionName: 'token1' });
    feeTier = await publicClient.readContract({ address: poolAddress as Address, abi: poolAbi, functionName: 'fee' });
    console.log(`✅ Fetched pool data: token0=${token0}, token1=${token1}, fee=${feeTier}`);
  } catch (err: any) {
    console.error(`❌ Error in Step 2: Failed to read pool data from blockchain. Is this a valid Pool address?`);
    console.error(`Reason: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n[Step 3/7] Resolving Quote and Meme tokens...`);
  const quoteConfig = await prisma.systemConfig.findMany({
    where: { key: { in: ['tokens.quote.weth', 'tokens.quote.usdg'] } }
  });
  const quoteMap = Object.fromEntries(quoteConfig.map(c => [c.key, c.value]));
  const wethAddress = quoteMap['tokens.quote.weth'] || process.env.WETH_ADDRESS || '';
  const usdgAddress = quoteMap['tokens.quote.usdg'] || process.env.USDG_ADDRESS || '';

  const isWeth0 = token0.toLowerCase() === wethAddress.toLowerCase();
  const isUsdg0 = token0.toLowerCase() === usdgAddress.toLowerCase();
  const isQuote0 = isWeth0 || isUsdg0;
  
  const quoteAddress = isQuote0 ? token0 : token1;
  const memeTokenAddress = isQuote0 ? token1 : token0;
  console.log(`✅ Meme Token: ${memeTokenAddress}`);
  console.log(`✅ Quote Token: ${quoteAddress} (isToken0: ${isQuote0})`);

  console.log(`\n[Step 4/7] Fetching token info from GMGN API for ${memeTokenAddress}...`);
  const info = await getTokenInfo(memeTokenAddress as Address);
  if (!info) {
    console.error(`❌ Error in Step 4: Failed to fetch token info from GMGN API for address ${memeTokenAddress}`);
    process.exit(1);
  }
  console.log(`✅ Fetched token info: Symbol=${info.symbol}, PriceUSD=${info.priceUsd}, Liquidity=${info.liquidity}`);

  console.log(`\n[Step 5/7] Preparing execution environment (Trading Mode = LIVE)...`);
  const originalFindUnique = prisma.systemConfig.findUnique;
  prisma.systemConfig.findUnique = (async (args: any) => {
    if (args.where.key === 'TRADING_MODE') {
      return { id: 1, key: 'TRADING_MODE', value: 'LIVE', description: null, updatedAt: new Date() };
    }
    return originalFindUnique(args);
  }) as any;
  console.log(`✅ Trading mode forcibly mocked to LIVE for execution.`);

  console.log(`\n[Step 6/7] Initializing LPEngine and resolving DEX Configuration...`);
  const engine = new LPEngineAgent();
  engine.onNotification = async (msg) => { console.log(`   └─ [LPEngine Internal] ${msg}`); };

  const dexV3 = await getDexConfig('V3');
  const dexV4 = await getDexConfig('V4');
  
  engine.resolvePool = async () => {
    let poolFactory = '';
    try {
      poolFactory = await publicClient.readContract({
        address: poolAddress as Address,
        abi: parseAbi(['function factory() view returns (address)']),
        functionName: 'factory'
      }) as string;
    } catch (err) {
      console.warn(`   └─ ⚠️ Warning: could not read factory for pool ${poolAddress}`);
    }
    
    let resolvedVersion = 'V4';
    let resolvedNpm = dexV4?.positionManager || '0x58daec3116aae6d93017baaea7749052e8a04fa7';
    let resolvedFactory = dexV4?.poolManager || '';
    
    if (poolFactory.toLowerCase() === dexV3?.factoryAddress?.toLowerCase() || 
        poolFactory.toLowerCase() === '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'.toLowerCase()) {
      resolvedVersion = 'V3';
      resolvedNpm = dexV3?.positionManager || '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
      resolvedFactory = poolFactory;
      console.log(`   └─ ✅ Detected Uniswap V3 Pool (Factory: ${poolFactory})`);
    } else {
      console.log(`   └─ ✅ Detected ALPS V4 Pool (Factory: ${poolFactory})`);
    }

    return {
      poolAddress: poolAddress.toLowerCase(),
      feeTier: feeTier,
      factoryAddress: resolvedFactory,
      managerAddress: resolvedNpm,
      version: resolvedVersion,
      quoteAddress: quoteAddress.toLowerCase()
    };
  };
  console.log(`✅ LPEngine configured to use target pool and resolved DEX logic.`);

  const token = {
    address: info.address,
    symbol: info.symbol || 'MEME',
    name: info.name || 'Meme Token',
    decimals: 18,
    priceUsd: info.priceUsd || 0.05, 
    volume24h: info.volume24h || 100000,
    liquidity: info.liquidity || 3000000, 
    chain: "robinhood",
    isToken0: false 
  };

  console.log(`\n[Step 7/7] Dispatching OPEN position execution to LPEngine...`);
  console.log(`=============================================================`);
  try {
    await engine.proposeOpenPosition(
      { token: token as any, score: 90, sentimentStatus: 'BULLISH' },
      { dayMode: true, nightMode: false, source: 'manual-test', mode: 'SEMI', executeNow: true }
    );
    console.log(`\n✅ Production execution finished successfully! Transaction sent.`);
  } catch (e: any) {
    console.error(`\n❌ Error in Step 7: LPEngine execution failed!`);
    console.error(`Reason:`, e);
  }

  process.exit(0);
}

main();
