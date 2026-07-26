import { getTrendingPairs } from '../services/gmgn.js';
import { parseAbi, encodeFunctionData, type Address, parseUnits } from 'viem';
import { getDexConfig } from '../core/dexConfig.js';

// V3 NPM ABI
const NPM_ABI = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
]);

export async function recommendTopPools() {
  console.log('[MCP] Recommending top pools...');
  try {
    const trending = await getTrendingPairs(5);
    const pools = trending.map(t => ({
      pair: `WETH/${t.symbol}`,
      tokenAddress: t.address,
      liquidity: t.liquidity,
      volume24h: t.volume24h,
      priceUsd: t.priceUsd,
      recommendation: `High volume token with strong 24h trading activity. Suggested Fee Tier: 1% or 0.3%`
    }));
    return JSON.stringify({ pools }, null, 2);
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}

export async function buildLpTransaction(args: {
  token0: Address,
  token1: Address,
  feeTier: number,
  tickLower: number,
  tickUpper: number,
  amount0Desired: string, // in standard units (e.g. 0.01)
  amount1Desired: string,
  userAddress: Address
}) {
  console.log('[MCP] Building LP transaction for', args);
  try {
    const config = await getDexConfig('V3');
    
    // Convert to Wei (assuming 18 decimals for simplicity here, can be enhanced)
    const amount0Wei = parseUnits(args.amount0Desired, 18);
    const amount1Wei = parseUnits(args.amount1Desired, 18);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20); // 20 mins

    const calldata = encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'mint',
      args: [{
        token0: args.token0,
        token1: args.token1,
        fee: args.feeTier,
        tickLower: args.tickLower,
        tickUpper: args.tickUpper,
        amount0Desired: amount0Wei,
        amount1Desired: amount1Wei,
        amount0Min: 0n, // simplified slippage for MCP demo
        amount1Min: 0n,
        recipient: args.userAddress,
        deadline: deadline
      }]
    });

    const txPayload = {
      to: config.positionManager,
      data: calldata,
      value: "0",
      executeUrl: `https://fletcheragent.pro/sign-tx?to=${config.positionManager}&data=${calldata}&value=0`
    };

    return JSON.stringify(txPayload, null, 2);
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}
