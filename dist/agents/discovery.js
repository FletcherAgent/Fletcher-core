import { IntelligenceLayer } from '../services/intelligence.js';
import { prisma } from '../core/db.js';
import { logEvent } from '../utils/logger.js';
import { getTrendingPairs, fetchTopTraders } from '../services/gmgn.js';
export class DiscoveryAgent {
    static async runDiscoveryCycle() {
        console.log('[DiscoveryAgent] 🔍 Starting Autonomous Wallet Discovery Cycle...');
        try {
            const trendingTokens = await getTrendingPairs(5); // Fetch top 5 trending pairs
            let discoveredCount = 0;
            for (const token of trendingTokens) {
                console.log(`[DiscoveryAgent] Analyzing top traders for trending token $${token.symbol}...`);
                const topTraders = await fetchTopTraders(token.address);
                for (const trader of topTraders) {
                    // Pre-filter: only process if win rate > 55%
                    if (trader.winRate < 55)
                        continue;
                    // Check if wallet already tracked
                    const existing = await prisma.trackedWallet.findUnique({
                        where: { address: trader.address }
                    });
                    if (existing)
                        continue;
                    // Evaluate with Grok Intelligence Layer
                    console.log(`[DiscoveryAgent] 🧠 Sending ${trader.address} metrics to Grok for evaluation...`);
                    const evaluation = await IntelligenceLayer.evaluateWallet(trader);
                    if (evaluation.approved) {
                        console.log(`[DiscoveryAgent] ✅ Grok APPROVED ${trader.address}: ${evaluation.reasoning}`);
                        // Add to registry
                        await prisma.trackedWallet.create({
                            data: {
                                address: trader.address,
                                label: `Auto-Discovered ($${token.symbol})`,
                                tier: 2, // Assign Tier 2 by default for AI-discovered wallets
                                entrySource: 'AUTONOMOUS',
                                winRate: trader.winRate,
                                avgPnlR: trader.realizedPnlUsd > 0 ? 0.5 : 0 // Rough estimation
                            }
                        });
                        await logEvent('INFO', `[Intelligence] Wallet Discovered & Approved`, {
                            wallet: trader.address,
                            reason: evaluation.reasoning
                        });
                        discoveredCount++;
                    }
                    else {
                        console.log(`[DiscoveryAgent] ❌ Grok REJECTED ${trader.address}: ${evaluation.reasoning}`);
                    }
                }
            }
            console.log(`[DiscoveryAgent] 🏁 Cycle complete. Discovered ${discoveredCount} new profitable wallets.`);
            return discoveredCount;
        }
        catch (error) {
            console.error(`[DiscoveryAgent] Error during discovery cycle:`, error);
            throw error;
        }
    }
}
