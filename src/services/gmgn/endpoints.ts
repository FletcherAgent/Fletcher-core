import { gmgnClientGet } from './client.js';
import { GMGNCache } from './cache.js';

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
  pairCreatedAt?: number;
  vol1h:        number;
  vol6h:        number;
  swaps1h:      number;
  swaps5m:      number;
  athPrice?:    number;
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

const CHAIN = 'robinhood';

/**
 * Normalizes API response to GMGNToken interface
 */
function normalizeToken(d: any): GMGNToken {
  // Fix for Robinhood chain missing root fields
  let mcap = parseFloat(d?.market_cap ?? d?.marketcap ?? '0');
  if (mcap === 0 && d?.price?.price && d?.circulating_supply) {
    mcap = parseFloat(d.price.price) * parseFloat(d.circulating_supply);
  }

  let vol = parseFloat(d?.volume_24h ?? d?.volume ?? d?.price?.volume_24h ?? '0');
  let price = parseFloat(d?.price?.price ?? d?.price ?? d?.price_usd ?? '0');
  let cat = d?.tag ?? d?.category ?? '';
  if (!cat) cat = 'meme'; // Default if none exists

  return {
    address:    d?.address ?? d?.token_address ?? '',
    symbol:     d?.symbol ?? d?.token_symbol ?? '',
    name:       d?.name ?? d?.token_name ?? '',
    marketCap:  mcap,
    volume24h:  vol,
    liquidity:  parseFloat(d?.pool?.liquidity ?? d?.liquidity ?? d?.liquidity_usd ?? '0'),
    priceUsd:   price,
    category:   cat,
    launchPad:  d?.launch_pad ?? d?.launchpad ?? '',
    isHoneypot: Boolean(d?.is_honeypot ?? d?.honeypot),
    buyTax:     parseFloat(d?.buy_tax ?? '0') * 100, // normalize to percentage if decimal
    sellTax:    parseFloat(d?.sell_tax ?? '0') * 100,
    isVerified: Boolean(d?.is_open_source ?? d?.verified ?? true),
    pairCreatedAt: d?.pool?.created_at ? parseInt(d.pool.created_at) * 1000 : undefined,
    vol1h:      parseFloat(d?.price?.volume_1h || '0'),
    vol6h:      parseFloat(d?.price?.volume_6h || '0'),
    swaps1h:    parseInt(d?.price?.swaps_1h || '0', 10),
    swaps5m:    parseInt(d?.price?.swaps_5m || '0', 10),
    athPrice:   parseFloat(d?.ath_price || '0') || undefined,
  };
}

// ─── FALLBACKS (GeckoTerminal & DexScreener) ─────────────────────────────────

async function getTrendingPairsFallback(limit = 20): Promise<GMGNToken[]> {
  console.log('[Fallback] Using GeckoTerminal for trending...');
  try {
    let allPools: any[] = [];
    let page = 1;
    while (allPools.length < limit && page <= 5) {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/trending_pools?page=${page}`);
      if (!res.ok) break;
      const data = await res.json();
      if (!data.data || data.data.length === 0) break;
      const validPools = data.data.filter((p: any) => p.relationships?.dex?.data?.id === 'uniswap-v3-robinhood');
      allPools = allPools.concat(validPools);
      page++;
      await new Promise(r => setTimeout(r, 500));
    }
    
    return allPools.slice(0, limit).map((pool: any) => {
      const attrs = pool.attributes;
      return {
        address: pool.relationships?.base_token?.data?.id?.replace('robinhood_', '') || attrs.address,
        symbol: attrs.name.split(' / ')[0] || 'TKN',
        name: attrs.name,
        marketCap: parseFloat(attrs.market_cap_usd || '0'),
        volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
        liquidity: parseFloat(attrs.reserve_in_usd || '0'),
        priceUsd: parseFloat(attrs.base_token_price_usd || '0'),
        category: ['tech', 'RWA', 'launchpad', 'ai'][Math.floor(Math.random() * 4)],
        launchPad: 'None',
        isHoneypot: false,
        buyTax: 0,
        sellTax: 0,
        isVerified: true,
        quoteToken: pool.relationships?.quote_token?.data?.id?.replace('robinhood_', '') || '',
        pairCreatedAt: pool.attributes?.pool_created_at ? new Date(pool.attributes.pool_created_at).getTime() : undefined,
        vol1h: 0,
        vol6h: 0,
        swaps1h: 0,
        swaps5m: 0,
      };
    });
  } catch (err) {
    console.error('[Fallback] GeckoTerminal failed:', err);
    return [];
  }
}

async function getTokenInfoFallback(tokenAddress: string): Promise<GMGNToken | null> {
  console.log(`[Fallback] Using DexScreener for ${tokenAddress}...`);
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    const rbPairs = pairs.filter((p: any) => p.chainId === 'robinhood');
    if (rbPairs.length === 0) return null;
    
    const mainPair = rbPairs[0];
    const token: GMGNToken = {
      address: tokenAddress,
      symbol: mainPair.baseToken?.symbol || '',
      name: mainPair.baseToken?.name || '',
      marketCap: parseFloat(mainPair.fdv || '0'),
      volume24h: rbPairs.reduce((acc: number, p: any) => acc + parseFloat(p.volume?.h24 || '0'), 0),
      liquidity: rbPairs.reduce((acc: number, p: any) => acc + parseFloat(p.liquidity?.usd || '0'), 0),
      priceUsd: parseFloat(mainPair.priceUsd || '0'),
      category: 'meme',
      launchPad: 'None',
      isHoneypot: false,
      buyTax: 0, sellTax: 0, isVerified: true,
      quoteToken: mainPair.quoteToken?.address || '',
      pairCreatedAt: mainPair.pairCreatedAt ? mainPair.pairCreatedAt : undefined,
      vol1h: rbPairs.reduce((acc: number, p: any) => acc + parseFloat(p.volume?.h1 || '0'), 0),
      vol6h: rbPairs.reduce((acc: number, p: any) => acc + parseFloat(p.volume?.h6 || '0'), 0),
      swaps1h: rbPairs.reduce((acc: number, p: any) => acc + (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0), 0),
      swaps5m: rbPairs.reduce((acc: number, p: any) => acc + (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0), 0),
    };
    
    // GoPlus Security
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
    } catch (gperr) { /* ignore */ }
    
    return token;
  } catch (err) {
    return null;
  }
}

// ─── MAIN EXPORTS (WITH FALLBACKS) ──────────────────────────────────────────

/**
 * Fetches Trending Pairs from GMGN with 60s cache. Fallback to GT.
 */
export async function getTrendingPairs(limit = 20): Promise<GMGNToken[]> {
  const cacheKey = `gmgn:trending:${limit}`;
  const cached = GMGNCache.get<GMGNToken[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await gmgnClientGet<{ data: { rank: any[] } }>('/market/rank', { chain: CHAIN, interval: '1h', orderby: 'swaps', direction: 'desc' });
    const tokens = (response?.data?.rank || []).slice(0, limit).map(normalizeToken);
    GMGNCache.set(cacheKey, tokens, 60);
    return tokens;
  } catch (e: any) {
    if (e.message.includes('DEGRADATION MODE')) {
      console.warn('[GMGN Endpoints] 📉 Degradation Mode is active, switching to GeckoTerminal');
    } else {
      console.warn('[GMGN Endpoints] ⚠️ GMGN Fetch failed, falling back to GeckoTerminal:', e.message);
    }
    return getTrendingPairsFallback(limit);
  }
}

/**
 * Fetches Token Info from GMGN with 30s cache. Fallback to DexScreener.
 */
export async function getTokenInfo(tokenAddress: string): Promise<GMGNToken | null> {
  const cacheKey = `gmgn:token:${tokenAddress}`;
  const cached = GMGNCache.get<GMGNToken>(cacheKey);
  if (cached) return cached;

  try {
    const response = await gmgnClientGet<any>('/token/info', { chain: CHAIN, address: tokenAddress });
    if (!response || !response.address) throw new Error('No data');
    const token = normalizeToken(response);
    token.quoteToken = response.quote_address || process.env.WETH_ADDRESS || '';
    GMGNCache.set(cacheKey, token, 30);
    return token;
  } catch (e: any) {
    if (e.message.includes('DEGRADATION MODE')) {
      return getTokenInfoFallback(tokenAddress);
    }
    console.error(`[GMGN Endpoints] ❌ Failed to fetch info for ${tokenAddress}:`, e.message);
    return getTokenInfoFallback(tokenAddress); // Also fallback on individual failure
  }
}

/**
 * Fetches Top Traders for a token with 5 min cache
 */
export async function fetchTopTraders(tokenAddress: string) {
  const cacheKey = `gmgn:traders:${tokenAddress}`;
  const cached = GMGNCache.get<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await gmgnClientGet<{ list: any[] }>('/market/token_top_traders', { chain: CHAIN, address: tokenAddress });
    const traders = (response?.list || []).map((trader: any) => ({
      address: trader.address,
      winRate: trader.win_rate ? parseFloat(trader.win_rate) * 100 : 0,
      totalTrades: trader.total_trades || 0,
      realizedPnlUsd: trader.realized_profit || 0
    }));
    GMGNCache.set(cacheKey, traders, 300);
    return traders;
  } catch (e) {
    console.error(`[GMGN Endpoints] ❌ fetchTopTraders failed for ${tokenAddress}`);
    return []; // No fallback for Top Traders since DS/GT don't provide it
  }
}
