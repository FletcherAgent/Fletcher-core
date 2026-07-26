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

  const pKey = (process.env.LP_PRIVATE_KEY || process.env.USER_PRIVATE_KEY) as Hex;
  const account = privateKeyToAccount(pKey);
  const rpc = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(rpc) });

  console.log(`[Deploy] Using EOA Wallet Address: ${account.address}`);
  console.log(`[Deploy] Reading Pool Data from blockchain for ${poolAddress}...`);

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
  } catch (err: any) {
    console.error(`❌ Error: Failed to read pool data from blockchain. Is this a valid Pool address?`);
    console.error(err.message);
    process.exit(1);
  }

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

  console.log(`[Deploy] Pool is for ${memeTokenAddress} and ${quoteAddress}`);
  console.log(`[Deploy] Fetching token info for ${memeTokenAddress} from GMGN...`);

  const info = await getTokenInfo(memeTokenAddress as Address);
  if (!info) {
    console.error("❌ Error: Failed to fetch token info from GMGN API for address " + memeTokenAddress);
    process.exit(1);
  }

  // Force LIVE trading mode
  const originalFindUnique = prisma.systemConfig.findUnique;
  prisma.systemConfig.findUnique = (async (args: any) => {
    if (args.where.key === 'TRADING_MODE') {
      return { id: 1, key: 'TRADING_MODE', value: 'LIVE', description: null, updatedAt: new Date() };
    }
    return originalFindUnique(args);
  }) as any;

  const engine = new LPEngineAgent();
  engine.onNotification = async (msg) => { console.log(`[LPEngine Notify] ${msg}`); };

  // Bypass resolvePool to forcefully use the provided pool
  const dexV4 = await getDexConfig('V4');
  const npmAddress = dexV4?.positionManager || '0x58daec3116aae6d93017baaea7749052e8a04fa7'; // fallback to ALPS NPM
  
  engine.resolvePool = async () => {
    return {
      poolAddress: poolAddress.toLowerCase(),
      feeTier: feeTier,
      factoryAddress: dexV4?.poolManager || '',
      managerAddress: npmAddress,
      version: 'V4', // Provide 'V4' so LPEngine knows to use ALPS router
      quoteAddress: quoteAddress.toLowerCase()
    };
  };

  const token = {
    address: info.address,
    symbol: info.symbol || 'MEME',
    name: info.name || 'Meme Token',
    decimals: 18,
    priceUsd: info.priceUsd || 0.05, 
    volume24h: info.volume24h || 100000,
    liquidity: info.liquidity || 3000000, 
    chain: "robinhood",
    isToken0: false // Will be determined properly inside LPEngine based on weth addr
  };

  console.log(`\n[Deploy] Proposing OPEN position for ${token.symbol} on Pool ${poolAddress}...`);
  console.log(`[Deploy] Sending transaction via Alchemy Session Key Bundler...`);
  try {
    await engine.proposeOpenPosition(
      { token: token as any, score: 90, sentimentStatus: 'BULLISH' },
      { dayMode: true, nightMode: false, source: 'manual-test' }
    );
    console.log(`\n✅ Production execution finished successfully!`);
  } catch (e: any) {
    console.error("❌ Execution Error:", e);
  }

  process.exit(0);
}

main();
