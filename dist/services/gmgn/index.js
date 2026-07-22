import { getTrendingPairs, getTokenInfo, fetchTopTraders } from './endpoints.js';
export async function loadScreeningCriteria() {
    const { prisma } = await import('../../core/db.js');
    const keys = ['lp.minMcap', 'lp.minVol', 'lp.categories', 'lp.blacklist'];
    const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
    const map = Object.fromEntries(configs.map(c => [c.key, c.value]));
    return {
        minMcap: parseFloat(map['lp.minMcap'] ?? '10000'),
        minVol24h: parseFloat(map['lp.minVol'] ?? '10000'),
        categories: JSON.parse(map['lp.categories'] ?? '["tech","RWA","launchpad","ai","meme","defi"]'),
        blacklist: JSON.parse(map['lp.blacklist'] ?? '["nsfw","scam"]')
    };
}
export { getTrendingPairs, getTokenInfo, fetchTopTraders };
export async function screenPairs(criteria) {
    const config = criteria ?? (await loadScreeningCriteria());
    console.log('[MarketData] 🔍 Screening pairs via GMGN v2 (Anti-Detect)...');
    // 1. Get initial broad list from GMGN Trending
    const gtTokens = await getTrendingPairs(150);
    const passed = [];
    for (const t of gtTokens) {
        // 2. Hydrate with full token info
        const token = await getTokenInfo(t.address);
        if (!token)
            continue;
        const reasons = [];
        if (token.marketCap < config.minMcap)
            reasons.push(`mcap ${token.marketCap.toFixed(0)} < ${config.minMcap}`);
        if (token.volume24h < config.minVol24h)
            reasons.push(`vol24h ${token.volume24h.toFixed(0)} < ${config.minVol24h}`);
        // 3. Category filter
        if (!config.categories.some(c => token.category?.toLowerCase().includes(c.toLowerCase()))) {
            reasons.push(`category "${token.category}" not in whitelist`);
        }
        if (config.blacklist.some(b => token.launchPad?.toLowerCase().includes(b.toLowerCase())))
            reasons.push(`launchpad blacklisted`);
        if (token.isHoneypot)
            reasons.push('honeypot detected');
        if (token.buyTax > 10 || token.sellTax > 10)
            reasons.push(`high tax: buy=${token.buyTax}% sell=${token.sellTax}%`);
        if (reasons.length > 0) {
            console.log(`[MarketData] ❌ ${token.symbol} REJECTED: ${reasons.join('; ')}`);
            continue;
        }
        // Original Scoring Math Restored
        const volMcapRatio = token.volume24h / (token.marketCap || 1);
        const safetyBonus = token.isVerified ? 10 : 0;
        const score = Math.min(100, Math.round(volMcapRatio * 50 + safetyBonus + 40));
        console.log(`[MarketData] ✅ ${token.symbol} PASSED — score: ${score}, mcap: $${(token.marketCap / 1000).toFixed(0)}K, vol: $${(token.volume24h / 1000).toFixed(0)}K`);
        const pool = {
            address: '',
            token0: token.address,
            token1: token.quoteToken || process.env.WETH_ADDRESS || '',
            feeTier: 3000,
            tvlUsd: token.liquidity,
            volume24h: token.volume24h,
            volTvlRatio: token.liquidity > 0 ? token.volume24h / token.liquidity : 0,
        };
        passed.push({ pool, token, score });
        // Delay to respect rate limit (GMGN client handles this if needed, but a small delay is good)
        await new Promise(r => setTimeout(r, 250));
    }
    passed.sort((a, b) => b.score - a.score);
    console.log(`[MarketData] 📊 Screening done: ${passed.length}/${gtTokens.length} pairs passed`);
    return passed;
}
