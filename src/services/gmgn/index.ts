import { getTrendingPairs, getTokenInfo, fetchTopTraders } from './endpoints.js';
import type { GMGNToken, GMGNPool } from './endpoints.js';
import { publicClient } from '../viem.js';
import { getDexConfig } from '../../core/dexConfig.js';
import { parseAbi } from 'viem';

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
]);
export interface PoolCandidate {
  pool:       GMGNPool;
  token:      GMGNToken;
  score:      number; // This is actually the GMGN Estimated Fee APR score
  grokScore?: number;
  grokLabel?: string;
}

export interface LPScreeningCriteria {
  minMcap:    number;
  minVol24h:  number;
  minAgeHours: number;
  categories: string[];
  blacklist:  string[];
}

export async function loadScreeningCriteria(): Promise<LPScreeningCriteria> {
  const { prisma } = await import('../../core/db.js');
  const keys = ['lp.minMcap', 'lp.minVol', 'lp.minAgeHours', 'lp.categories', 'lp.blacklist'];
  const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(configs.map(c => [c.key, c.value]));
  
  return {
    minMcap:    parseFloat(map['lp.minMcap']    ?? '400000'),
    minVol24h:  parseFloat(map['lp.minVol']     ?? '1000000'),
    minAgeHours: parseFloat(map['lp.minAgeHours'] ?? '5'),
    categories: JSON.parse(map['lp.categories'] ?? '["tech","RWA","launchpad","ai","meme","defi"]'),
    blacklist:  JSON.parse(map['lp.blacklist']  ?? '["nsfw","scam"]')
  };
}

// Export them so other modules can use them
export type { GMGNToken, GMGNPool };
export { getTrendingPairs, getTokenInfo, fetchTopTraders };

export async function screenPairs(criteria?: LPScreeningCriteria): Promise<PoolCandidate[]> {
  const config = criteria ?? (await loadScreeningCriteria());
  console.log('[MarketData] 🔍 Screening pairs via GMGN v2 (Anti-Detect)...');
  
  // 1. Get initial broad list from GMGN Trending
  const gtTokens = await getTrendingPairs(150);
  
  // Get factory address
  const dexConfigObj = await getDexConfig('V3');
  const factoryAddress = dexConfigObj.factoryAddress;
  if (!factoryAddress) {
    console.warn('[MarketData] ⚠️ No V3 factory address found in config');
  }

  const passed: PoolCandidate[] = [];
  
  for (const t of gtTokens) {
    // 2. Hydrate with full token info
    const token = await getTokenInfo(t.address);
    if (!token) continue;
    
    const reasons: string[] = [];
    if (token.marketCap < config.minMcap) reasons.push(`mcap ${token.marketCap.toFixed(0)} < ${config.minMcap}`);
    if (token.volume24h < config.minVol24h) reasons.push(`vol24h ${token.volume24h.toFixed(0)} < ${config.minVol24h}`);
    
    if (token.pairCreatedAt) {
      const ageHours = (Date.now() - token.pairCreatedAt) / (1000 * 60 * 60);
      if (ageHours < config.minAgeHours) reasons.push(`age ${ageHours.toFixed(1)}h < ${config.minAgeHours}h`);
    }

    // 3. Category filter
    if (!config.categories.some(c => token.category?.toLowerCase().includes(c.toLowerCase()))) {
      reasons.push(`category "${token.category}" not in whitelist`);
    }

    if (config.blacklist.some(b => token.launchPad?.toLowerCase().includes(b.toLowerCase()))) reasons.push(`launchpad blacklisted`);
    
    // Strict Anti-Scam (GoPlus)
    if (token.isHoneypot) reasons.push('honeypot detected');
    if (token.buyTax > 5 || token.sellTax > 5) reasons.push(`high tax: buy=${token.buyTax}% sell=${token.sellTax}%`);
    // if (!token.isVerified) reasons.push('contract not verified');
    
    if (reasons.length > 0) {
      console.log(`[MarketData] ❌ ${token.symbol} REJECTED: ${reasons.join('; ')}`);
      continue;
    }
    
    // Fetch real pool address and fee tier from Factory
    const quoteTokenAddress = token.quoteToken || process.env.WETH_ADDRESS || '';
    let realPoolAddress = '';
    let bestFeeTier = 3000;

    if (factoryAddress) {
      // Try standard fee tiers
      const tiers = [10000, 3000, 500, 100];
      for (const tier of tiers) {
        try {
          const pAddr = await publicClient.readContract({
            address: factoryAddress as `0x${string}`,
            abi: FACTORY_ABI,
            functionName: 'getPool',
            args: [token.address as `0x${string}`, quoteTokenAddress as `0x${string}`, tier],
          }) as string;
          
          if (pAddr && pAddr.toLowerCase() !== '0x0000000000000000000000000000000000000000') {
            realPoolAddress = pAddr;
            bestFeeTier = tier;
            // Stop at first valid pool (or we could fetch liquidity for all and pick highest, but this is simpler)
            break; 
          }
        } catch (err) {
          // Ignore call errors
        }
      }
    }

    if (!realPoolAddress) {
      console.log(`[MarketData] ❌ ${token.symbol} REJECTED: No on-chain pool found`);
      continue;
    }

    const feeTierPct = bestFeeTier / 1000000; // e.g. 3000 = 0.003
    const activeLiquidity = token.liquidity || 1;
    const estimatedFeeAPR = ((token.volume24h * feeTierPct) / activeLiquidity) * 365;
    
    // Safety score constraint (max 100 on safety, but we now rank by APR)
    // We will use estimatedFeeAPR as the primary score.
    const score = Math.round(estimatedFeeAPR * 100) / 100; // Store as raw APR percentage
    
    console.log(`[MarketData] ✅ ${token.symbol} PASSED — estAPR: ${score}%, mcap: $${(token.marketCap/1000).toFixed(0)}K, vol: $${(token.volume24h/1000).toFixed(0)}K`);
    
    const pool: GMGNPool = {
      address: realPoolAddress,
      token0: token.address,
      token1: quoteTokenAddress,
      feeTier: bestFeeTier,
      tvlUsd: token.liquidity,
      volume24h: token.volume24h,
      volTvlRatio: token.liquidity > 0 ? token.volume24h / token.liquidity : 0,
    };
    
    passed.push({ pool, token, score });
    
    // Delay to respect rate limit (GMGN client handles this if needed, but a small delay is good)
    await new Promise(r => setTimeout(r, 250));
  }
  
  // Quote Asset Priority
  const getQuotePriority = (address?: string) => {
    if (!address) return 0;
    const addr = address.toLowerCase();
    if (addr === process.env.USDG_ADDRESS?.toLowerCase()) return 3;
    if (addr === process.env.WETH_ADDRESS?.toLowerCase()) return 2;
    if (addr === process.env.USDC_ADDRESS?.toLowerCase()) return 1;
    return 0; // Other quote assets
  };

  passed.sort((a, b) => {
    const priorityA = getQuotePriority(a.token.quoteToken);
    const priorityB = getQuotePriority(b.token.quoteToken);
    if (priorityA !== priorityB) {
      return priorityB - priorityA; // Higher priority first
    }
    return b.score - a.score; // Then by estimatedFeeAPR
  });
  console.log(`[MarketData] 📊 Screening done: ${passed.length}/${gtTokens.length} pairs passed`);
  return passed;
}
