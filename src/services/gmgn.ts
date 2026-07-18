/**
 * GMGN API Service — Robinhood Chain
 *
 * Provides pair screening data for LP Engine:
 *   - Trending pairs (mcap, volume, categories)
 *   - Pool stats (vol/TVL ratio)
 *   - Safety Gate integration (honeypot, tax, contract)
 *
 * Docs: https://gmgn.ai/docs
 * Note: GMGN API only supports IPv4. Ensure the server does not use IPv6.
 */

const BASE_URL = 'https://gmgn.ai/defi/quotation/v1';
const CHAIN    = 'robinhood'; // GMGN chain slug for Robinhood Chain

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GMGNToken {
  address:      string;
  symbol:       string;
  name:         string;
  marketCap:    number;    // USD
  volume24h:    number;    // USD
  liquidity:    number;    // USD TVL
  priceUsd:     number;
  category:     string;    // "tech" | "RWA" | "launchpad" | "ai" | "meme" | ...
  launchPad:    string;    // platform launch: "flap.fun" | "hood.fun" | ...
  isHoneypot:   boolean;
  buyTax:       number;    // 0-100 (%)
  sellTax:      number;
  isVerified:   boolean;   // contract source verified
}

export interface GMGNPool {
  address:   string;
  token0:    string;
  token1:    string;
  feeTier:   number;       // 500 | 3000 | 10000
  tvlUsd:    number;
  volume24h: number;
  volTvlRatio: number;     // computed: volume24h / tvlUsd
}

export interface PoolCandidate {
  pool:       GMGNPool;
  token:      GMGNToken;
  score:      number;      // 0-100: composite screening score
}

// ─── MetaConfig loader ───────────────────────────────────────────────────────

export interface LPScreeningCriteria {
  minMcap:    number;
  minVol24h:  number;
  categories: string[];
  blacklist:  string[];    // launch platform blacklist
}

/** Load screening criteria from SystemConfig DB */
export async function loadScreeningCriteria(): Promise<LPScreeningCriteria> {
  // Lazy import to avoid circular deps
  const { prisma } = await import('../core/db.js');

  const keys = ['lp.minMcap', 'lp.minVol', 'lp.categories', 'lp.blacklist'];
  const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(configs.map(c => [c.key, c.value]));

  return {
    minMcap:    parseFloat(map['lp.minMcap']    ?? '500000'),
    minVol24h:  parseFloat(map['lp.minVol']     ?? '1000000'),
    categories: JSON.parse(map['lp.categories'] ?? '["tech","RWA","launchpad","ai"]'),
    blacklist:  JSON.parse(map['lp.blacklist']   ?? '["flap.fun","hood.fun"]'),
  };
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

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
    },
    // Force IPv4 via Node native fetch (no special config needed in Node 18+)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[GMGN] HTTP ${res.status} for ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── API Methods ──────────────────────────────────────────────────────────────

/**
 * Fetch trending pairs on Robinhood Chain (24h window).
 * Returns top 20 by volume.
 */
export async function getTrendingPairs(limit = 20): Promise<GMGNToken[]> {
  try {
    const data = await gmgnGet<{ data: { rank: any[] } }>(
      `/rank/${CHAIN}/swaps/24h`,
      { limit: String(limit), orderby: 'volume', direction: 'desc' }
    );

    return (data.data?.rank ?? []).map(normalizeToken);
  } catch (err) {
    console.error('[GMGN] getTrendingPairs failed:', err);
    return [];
  }
}

/**
 * Fetch specific token info: mcap, volume, safety data.
 */
export async function getTokenInfo(tokenAddress: string): Promise<GMGNToken | null> {
  try {
    const data = await gmgnGet<{ data: any }>(
      `/token/${CHAIN}/${tokenAddress}`
    );
    return normalizeToken(data.data);
  } catch (err) {
    console.error(`[GMGN] getTokenInfo failed for ${tokenAddress}:`, err);
    return null;
  }
}

/**
 * Fetch top traders for a specific token.
 * We use GMGN token/top_traders endpoint.
 */
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

/**
 * Fetch Uniswap V3 pool stats (TVL, volume, fee tier).
 */
export async function getPoolStats(poolAddress: string): Promise<GMGNPool | null> {
  try {
    const data = await gmgnGet<{ data: any }>(
      `/pool/${CHAIN}/${poolAddress}`
    );
    const d = data.data;
    const tvl    = parseFloat(d?.liquidity_usd ?? d?.tvl_usd ?? '0');
    const vol24h = parseFloat(d?.volume_24h ?? '0');
    return {
      address:     poolAddress,
      token0:      d?.token0?.address ?? '',
      token1:      d?.token1?.address ?? '',
      feeTier:     parseInt(d?.fee_tier ?? '3000'),
      tvlUsd:      tvl,
      volume24h:   vol24h,
      volTvlRatio: tvl > 0 ? vol24h / tvl : 0,
    };
  } catch (err) {
    console.error(`[GMGN] getPoolStats failed for ${poolAddress}:`, err);
    return null;
  }
}

// ─── Pair Screening ───────────────────────────────────────────────────────────

/**
 * Main screening function for LP Engine.
 * Fetches trending pairs → filters by all criteria → returns PoolCandidate[].
 *
 * Filters (ALL must pass):
 *   1. Mcap > minMcap
 *   2. Volume 24h > minVol24h
 *   3. Category must be in the whitelist
 *   4. Launch platform MUST NOT be in the blacklist
 *   5. Not a honeypot
 *   6. Buy/sell tax ≤ 10%
 */
export async function screenPairs(
  criteria?: LPScreeningCriteria
): Promise<PoolCandidate[]> {
  const config = criteria ?? (await loadScreeningCriteria());

  console.log('[GMGN] 🔍 Screening pairs on Robinhood Chain...');
  console.log(`[GMGN] Criteria: mcap>${config.minMcap} vol>${config.minVol24h} categories=${config.categories.join(',')} blacklist=${config.blacklist.join(',')}`);

  const tokens = await getTrendingPairs(50); // fetch more before filtering

  const passed: PoolCandidate[] = [];

  for (const token of tokens) {
    const reasons: string[] = [];

    // 1. Mcap filter
    if (token.marketCap < config.minMcap) {
      reasons.push(`mcap ${token.marketCap} < ${config.minMcap}`);
    }
    // 2. Volume filter
    if (token.volume24h < config.minVol24h) {
      reasons.push(`vol24h ${token.volume24h} < ${config.minVol24h}`);
    }
    // 3. Category filter
    if (!config.categories.some(c => token.category?.toLowerCase().includes(c.toLowerCase()))) {
      reasons.push(`category "${token.category}" not in whitelist`);
    }
    // 4. Launch platform blacklist
    if (config.blacklist.some(b => token.launchPad?.toLowerCase().includes(b.toLowerCase()))) {
      reasons.push(`launchpad "${token.launchPad}" is blacklisted`);
    }
    // 5. Honeypot check
    if (token.isHoneypot) {
      reasons.push('honeypot detected');
    }
    // 6. Tax check
    if (token.buyTax > 10 || token.sellTax > 10) {
      reasons.push(`high tax: buy=${token.buyTax}% sell=${token.sellTax}%`);
    }

    if (reasons.length > 0) {
      console.log(`[GMGN] ❌ ${token.symbol} (${token.address.slice(0, 8)}) REJECTED: ${reasons.join('; ')}`);
      continue;
    }

    // Compose score (simple: normalized vol/mcap ratio + safety bonus)
    const volMcapRatio = token.volume24h / (token.marketCap || 1);
    const safetyBonus  = token.isVerified ? 10 : 0;
    const score = Math.min(100, Math.round(volMcapRatio * 50 + safetyBonus + 40));

    console.log(`[GMGN] ✅ ${token.symbol} PASSED — score: ${score}, mcap: $${(token.marketCap/1000).toFixed(0)}K, vol: $${(token.volume24h/1000).toFixed(0)}K`);

    // Build placeholder pool (pool address will be resolved via Uniswap Factory later)
    const pool: GMGNPool = {
      address:     '', // resolved later from factory
      token0:      token.address,
      token1:      process.env.WETH_ADDRESS ?? '',
      feeTier:     3000,
      tvlUsd:      token.liquidity,
      volume24h:   token.volume24h,
      volTvlRatio: token.liquidity > 0 ? token.volume24h / token.liquidity : 0,
    };

    passed.push({ pool, token, score });
  }

  // Sort by score descending
  passed.sort((a, b) => b.score - a.score);

  console.log(`[GMGN] 📊 Screening done: ${passed.length}/${tokens.length} pairs passed`);
  return passed;
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

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
