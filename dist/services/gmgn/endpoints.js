import { gmgnClientGet } from './client.js';
import { GMGNCache } from './cache.js';
const CHAIN = 'robinhood';
/**
 * Normalizes API response to GMGNToken interface
 */
function normalizeToken(d) {
    return {
        address: d?.address ?? d?.token_address ?? '',
        symbol: d?.symbol ?? d?.token_symbol ?? '',
        name: d?.name ?? d?.token_name ?? '',
        marketCap: parseFloat(d?.market_cap ?? d?.marketcap ?? '0'),
        volume24h: parseFloat(d?.volume_24h ?? d?.volume ?? '0'),
        liquidity: parseFloat(d?.liquidity ?? d?.liquidity_usd ?? '0'),
        priceUsd: parseFloat(d?.price ?? d?.price_usd ?? '0'),
        category: d?.tag ?? d?.category ?? '',
        launchPad: d?.launch_pad ?? d?.launchpad ?? '',
        isHoneypot: Boolean(d?.is_honeypot ?? d?.honeypot),
        buyTax: parseFloat(d?.buy_tax ?? '0') * 100, // normalize to percentage if decimal
        sellTax: parseFloat(d?.sell_tax ?? '0') * 100,
        isVerified: Boolean(d?.is_open_source ?? d?.verified ?? true),
    };
}
/**
 * Fetches Trending Pairs from GMGN with 60s cache
 */
export async function getTrendingPairs(limit = 20) {
    const cacheKey = `gmgn:trending:${limit}`;
    const cached = GMGNCache.get(cacheKey);
    if (cached) {
        console.log('[GMGN Endpoints] ⚡ Returning cached Trending Pairs');
        return cached;
    }
    console.log('[GMGN Endpoints] 🌐 Fetching Trending Pairs from GMGN...');
    try {
        // We request the rank/trending endpoint from GMGN
        const response = await gmgnClientGet(`/rank/${CHAIN}/swaps/1h`, {
            orderby: 'swaps',
            direction: 'desc'
        });
        const tokens = (response?.data?.rank || []).slice(0, limit).map(normalizeToken);
        // Cache for 60 seconds
        GMGNCache.set(cacheKey, tokens, 60);
        return tokens;
    }
    catch (e) {
        console.error('[GMGN Endpoints] ❌ Failed to fetch trending pairs:', e);
        return [];
    }
}
/**
 * Fetches Token Info from GMGN with 30s cache
 */
export async function getTokenInfo(tokenAddress) {
    const cacheKey = `gmgn:token:${tokenAddress}`;
    const cached = GMGNCache.get(cacheKey);
    if (cached)
        return cached;
    try {
        const response = await gmgnClientGet(`/token/${CHAIN}/${tokenAddress}`);
        if (!response || !response.data)
            return null;
        const token = normalizeToken(response.data);
        // Fallbacks if data is missing or specific GMGN quirks
        token.quoteToken = response.data.quote_address || process.env.WETH_ADDRESS || '';
        // Cache for 30 seconds
        GMGNCache.set(cacheKey, token, 30);
        return token;
    }
    catch (e) {
        console.error(`[GMGN Endpoints] ❌ Failed to fetch info for ${tokenAddress}:`, e);
        return null;
    }
}
/**
 * Fetches Top Traders for a token with 5 min cache
 */
export async function fetchTopTraders(tokenAddress) {
    const cacheKey = `gmgn:traders:${tokenAddress}`;
    const cached = GMGNCache.get(cacheKey);
    if (cached)
        return cached;
    try {
        const response = await gmgnClientGet(`/token/${CHAIN}/${tokenAddress}/top_traders`);
        const traders = (response?.data || []).map((trader) => ({
            address: trader.address,
            winRate: trader.win_rate ? parseFloat(trader.win_rate) * 100 : 0,
            totalTrades: trader.total_trades || 0,
            realizedPnlUsd: trader.realized_profit || 0
        }));
        // Cache for 300 seconds (5 mins)
        GMGNCache.set(cacheKey, traders, 300);
        return traders;
    }
    catch (e) {
        console.error(`[GMGN Endpoints] ❌ fetchTopTraders failed for ${tokenAddress}:`, e);
        return [];
    }
}
