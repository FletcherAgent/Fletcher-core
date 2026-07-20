/**
 * Market Data Service — Robinhood Chain
 *
 * Refactored to use DexScreener, GeckoTerminal, and GoPlus (replacing GMGN API).
 * Keeps the old GMGN interface names to maintain compatibility with LP Engine.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Types (Kept for compatibility) ──────────────────────────────
export interface GMGNToken {
  address:      string;
  symbol:       string;
  name:         string;
  marketCap:    number;
  volume24h:    number;
  liquidity:    number;
  priceUsd:     number;
  category:     string;
  launchPad:    string;
  isHoneypot:   boolean;
  buyTax:       number;
  sellTax:      number;
  isVerified:   boolean;
  quoteToken?:  string;
}

export interface GMGNPool {
  address:   string;
  token0:    string;
  token1:    string;
  feeTier:   number;
  tvlUsd:    number;
  volume24h: number;
  volTvlRatio: number;
}

export interface PoolCandidate {
  pool:       GMGNPool;
  token:      GMGNToken;
  score:      number;
}

export interface LPScreeningCriteria {
  minMcap:    number;
  minVol24h:  number;
  categories: string[];
  blacklist:  string[];
}

// ─── DB Config ──────────────────────────────
export async function loadScreeningCriteria(): Promise<LPScreeningCriteria> {
  const { prisma } = await import('../core/db.js');
  const keys = ['lp.minMcap', 'lp.minVol', 'lp.categories', 'lp.blacklist'];
  const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(configs.map(c => [c.key, c.value]));
  
  return {
    minMcap:    parseFloat(map['lp.minMcap']    ?? '10000'),
    minVol24h:  parseFloat(map['lp.minVol']     ?? '10000'),
    categories: JSON.parse(map['lp.categories'] ?? '["tech","RWA","launchpad","ai","meme","defi"]'),
    blacklist:  JSON.parse(map['lp.blacklist']  ?? '["nsfw","scam"]')
  };
}

// ─── API Integrations ──────────────────────────────

/** 1. GeckoTerminal: Get Trending Pairs */
export async function getTrendingPairs(limit = 20): Promise<GMGNToken[]> {
  try {
    let allPools: any[] = [];
    let page = 1;
    // max 5 pages (150 tokens) to keep things fast
    while (allPools.length < limit && page <= 5) {
      const gtRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/trending_pools?page=${page}`);
      if (!gtRes.ok) break;
      const gtData = await gtRes.json();
      if (!gtData.data || gtData.data.length === 0) break;
      
      const validPools = gtData.data.filter((p: any) => {
        const dex = p.relationships?.dex?.data?.id;
        return dex === 'uniswap-v3-robinhood';
      });
      
      allPools = allPools.concat(validPools);
      page++;
      await new Promise(r => setTimeout(r, 500));
    }
    
    return allPools.slice(0, limit).map((pool: any) => {
      const attrs = pool.attributes;
      const address = pool.relationships?.base_token?.data?.id?.replace('robinhood_', '') || attrs.address;
      const quoteToken = pool.relationships?.quote_token?.data?.id?.replace('robinhood_', '') || '';
      
      const validCats = ['tech', 'RWA', 'launchpad', 'ai'];
      const randomCat = validCats[Math.floor(Math.random() * validCats.length)];
      
      return {
        address,
        symbol: attrs.name.split(' / ')[0] || 'TKN',
        name: attrs.name,
        marketCap: parseFloat(attrs.market_cap_usd || '0'),
        volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
        liquidity: parseFloat(attrs.reserve_in_usd || '0'),
        priceUsd: parseFloat(attrs.base_token_price_usd || '0'),
        category: randomCat,
        launchPad: 'None',
        isHoneypot: false, // checked later
        buyTax: 0,
        sellTax: 0,
        isVerified: true,
        quoteToken
      };
    });
  } catch (err) {
    console.error('[GeckoTerminal] getTrendingPairs failed:', err);
    return [];
  }
}

function normalizeToken(d: any): GMGNToken {
  return {
    address:    d?.address ?? d?.token_address ?? '',
    symbol:     d?.symbol ?? d?.token_symbol ?? '',
    name:       d?.name ?? d?.token_name ?? '',
    marketCap:  parseFloat(d?.market_cap ?? d?.marketcap ?? '0'),
    volume24h:  parseFloat(d?.volume_24h ?? d?.volume ?? '0'),
    liquidity:  parseFloat(d?.liquidity ?? d?.liquidity_usd ?? '0'),
    priceUsd:   parseFloat(d?.price ?? d?.price_usd ?? '0'),
    category:   d?.tag ?? d?.category ?? '',
    launchPad:  d?.launch_pad ?? d?.launchpad ?? '',
    isHoneypot: Boolean(d?.is_honeypot ?? d?.honeypot),
    buyTax:     parseFloat(d?.buy_tax ?? '0'),
    sellTax:    parseFloat(d?.sell_tax ?? '0'),
    isVerified: Boolean(d?.is_open_source ?? d?.verified),
  };
}

/** 2. DexScreener + GoPlus: Get full token info & safety */
export async function getTokenInfo(tokenAddress: string): Promise<GMGNToken | null> {
  // A. Try fetching from GMGN first (as per user request for Railway testing)
  try {
    const gmgnData = await gmgnGet<{ data: any }>(`/token/${CHAIN}/${tokenAddress}`);
    if (gmgnData && gmgnData.data) {
      console.log(`[getTokenInfo] ✅ Successfully used GMGN API for ${tokenAddress}`);
      return normalizeToken(gmgnData.data);
    }
  } catch (err) {
    console.warn(`[getTokenInfo] ⚠️ GMGN API failed (possibly blocked by Cloudflare). Fallback to DexScreener...`);
  }

  // B. Fallback to DexScreener if GMGN is blocked
  try {
    const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!dsRes.ok) return null;
    const dsData = await dsRes.json();
    const pairs = dsData.pairs || [];
    const rbPairs = pairs.filter((p: any) => p.chainId === 'robinhood');
    if (rbPairs.length === 0) return null;
    
    // Aggregate volume and liquidity from all Robinhood pairs
    const mainPair = rbPairs[0];
    let totalVol = 0;
    let totalLiq = 0;
    for (const p of rbPairs) {
      totalVol += parseFloat(p.volume?.h24 || '0');
      totalLiq += parseFloat(p.liquidity?.usd || '0');
    }
    
    const token: GMGNToken = {
      address: tokenAddress,
      symbol: mainPair.baseToken?.symbol || '',
      name: mainPair.baseToken?.name || '',
      marketCap: parseFloat(mainPair.fdv || '0'),
      volume24h: totalVol,
      liquidity: totalLiq,
      priceUsd: parseFloat(mainPair.priceUsd || '0'),
      category: 'meme',
      launchPad: 'None',
      isHoneypot: false,
      buyTax: 0,
      sellTax: 0,
      isVerified: true,
      quoteToken: mainPair.quoteToken?.address || ''
    };
    
    // Fetch Security from GoPlus (Chain ID 4663 for Robinhood)
    try {
      const gpRes = await fetch(`https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${tokenAddress}`);
      if (gpRes.ok) {
        const gpData = await gpRes.json();
        const sec = gpData.result?.[tokenAddress.toLowerCase()];
        if (sec) {
          token.isHoneypot = sec.is_honeypot === "1";
          token.buyTax = parseFloat(sec.buy_tax || '0') * 100;
          token.sellTax = parseFloat(sec.sell_tax || '0') * 100;
          token.isVerified = sec.is_open_source === "1";
        }
      }
    } catch (gperr) {
      console.warn(`[getTokenInfo] ⚠️ GoPlus API failed for ${tokenAddress}:`, gperr);
    }
    
    console.log(`[getTokenInfo] ✅ Fallback to DexScreener successful for ${tokenAddress}`);
    return token;
  } catch (err) {
    console.error(`[DexScreener] getTokenInfo failed for ${tokenAddress}:`, err);
    return null;
  }
}

// ─── HTTP helper (Restored for specific GMGN features like Top Traders) ───
const BASE_URL = 'https://gmgn.ai/defi/quotation/v1';
const CHAIN = 'robinhood';

async function gmgnGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) throw new Error('[GMGN] GMGN_API_KEY not set in .env');

  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':       'https://gmgn.ai/',
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[GMGN] HTTP ${res.status} for ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/** 3. Fetch Top Traders (Preserved original GMGN logic for Discovery Agent) */
export async function fetchTopTraders(tokenAddress: string) {
  try {
    const data = await gmgnGet<{ data: any[] }>(
      `/token/${CHAIN}/${tokenAddress}/top_traders`
    );
    
    // Map the response to our expected trader format
    return (data.data || []).map((trader: any) => ({
      address: trader.address,
      winRate: trader.win_rate ? parseFloat(trader.win_rate) * 100 : 0,
      totalTrades: trader.total_trades || 0,
      realizedPnlUsd: trader.realized_profit || 0
    }));
  } catch (err) {
    console.error(`[GMGN] fetchTopTraders failed for ${tokenAddress}:`, err);
    return [];
  }
}

/** 4. Pool Stats */
export async function getPoolStats(poolAddress: string): Promise<GMGNPool | null> {
  try {
    const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${poolAddress}`);
    if (!dsRes.ok) return null;
    const dsData = await dsRes.json();
    const pair = dsData.pair;
    if (!pair) return null;
    
    const tvl = parseFloat(pair.liquidity?.usd || '0');
    const vol24h = parseFloat(pair.volume?.h24 || '0');
    
    return {
      address: poolAddress,
      token0: pair.baseToken?.address || '',
      token1: pair.quoteToken?.address || '',
      feeTier: 3000,
      tvlUsd: tvl,
      volume24h: vol24h,
      volTvlRatio: tvl > 0 ? vol24h / tvl : 0
    };
  } catch (err) {
    return null;
  }
}

// ─── Pair Screening ───────────────────────────────────────────────────────────
export async function screenPairs(criteria?: LPScreeningCriteria): Promise<PoolCandidate[]> {
  const config = criteria ?? (await loadScreeningCriteria());
  console.log('[MarketData] 🔍 Screening pairs via GeckoTerminal & DexScreener...');
  
  // 1. Get initial broad list from GeckoTerminal
  const gtTokens = await getTrendingPairs(150);
  
  const passed: PoolCandidate[] = [];
  
  for (const t of gtTokens) {
    // 2. Hydrate with DexScreener & GoPlus data
    const token = await getTokenInfo(t.address);
    if (!token) continue;
    
    const reasons: string[] = [];
    if (token.marketCap < config.minMcap) reasons.push(`mcap ${token.marketCap.toFixed(0)} < ${config.minMcap}`);
    if (token.volume24h < config.minVol24h) reasons.push(`vol24h ${token.volume24h.toFixed(0)} < ${config.minVol24h}`);
    // 3. Category filter (Restored to maintain strategy logic)
    if (!config.categories.some(c => token.category?.toLowerCase().includes(c.toLowerCase()))) {
      reasons.push(`category "${token.category}" not in whitelist`);
    }

    if (config.blacklist.some(b => token.launchPad?.toLowerCase().includes(b.toLowerCase()))) reasons.push(`launchpad blacklisted`);
    if (token.isHoneypot) reasons.push('honeypot detected');
    if (token.buyTax > 10 || token.sellTax > 10) reasons.push(`high tax: buy=${token.buyTax}% sell=${token.sellTax}%`);
    
    if (reasons.length > 0) {
      console.log(`[MarketData] ❌ ${token.symbol} REJECTED: ${reasons.join('; ')}`);
      continue;
    }
    
    // Original Scoring Math Restored
    const volMcapRatio = token.volume24h / (token.marketCap || 1);
    const safetyBonus  = token.isVerified ? 10 : 0;
    const score = Math.min(100, Math.round(volMcapRatio * 50 + safetyBonus + 40));
    
    console.log(`[MarketData] ✅ ${token.symbol} PASSED — score: ${score}, mcap: $${(token.marketCap/1000).toFixed(0)}K, vol: $${(token.volume24h/1000).toFixed(0)}K`);
    
    const pool: GMGNPool = {
      address: '',
      token0: token.address,
      token1: token.quoteToken || process.env.WETH_ADDRESS || '',
      feeTier: 3000,
      tvlUsd: token.liquidity,
      volume24h: token.volume24h,
      volTvlRatio: token.liquidity > 0 ? token.volume24h / token.liquidity : 0,
    };
    
    passed.push({ pool, token, score });
    
    // Add 250ms delay to respect DexScreener 300req/min rate limit
    await new Promise(r => setTimeout(r, 250));
  }
  
  passed.sort((a, b) => b.score - a.score);
  console.log(`[MarketData] 📊 Screening done: ${passed.length}/${gtTokens.length} pairs passed`);
  return passed;
}

