import { prisma } from '../core/db.js';
import { fetchOHLCV, calculateIndicators } from '../services/ohlcv.js';
import { LPEngineAgent as LPEngine } from './lpengine.js';
import { getTokenInfo } from '../services/gmgn/index.js';
import { logEvent } from '../utils/logger.js';
import { checkLiveness } from './liveness.js';

export class WatchlistAgent {
  private lpEngine: LPEngine;

  constructor(lpEngine: LPEngine) {
    this.lpEngine = lpEngine;
  }

  async runWatchlistLoop() {
    console.log('[Watchlist] 🔍 Checking Watchlist candidates for Entry Signals...');
    
    const items = await prisma.watchlist.findMany({
      where: {
        status: 'WATCHING',
        tradingMode: (await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }))?.value === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE'
      }
    });

    if (items.length === 0) {
      console.log('[Watchlist] Watchlist is empty.');
      return;
    }

    const tModeConfig = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const currentMode = (tModeConfig?.value ?? 'LIVE') === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';

    const config = await prisma.systemConfig.findMany({
      where: { key: { in: ['lp.maxPositions'] } }
    });
    const map = Object.fromEntries(config.map(c => [c.key, c.value]));
    const maxPositions = parseInt(map['lp.maxPositions'] ?? '3');

    const openCount = await prisma.lPPosition.count({
      where: { 
        status: { in: ['OPEN', 'PENDING'] },
        tradingMode: currentMode 
      },
    });

    if (openCount >= maxPositions) {
      console.log('[Watchlist] ⛔ Max positions reached, skipping entry checks.');
      return;
    }

    for (const item of items) {
      try {
        if (!item.poolAddress) {
          console.log(`[Watchlist] 🔍 Resolving pool address for ${item.symbol}...`);
          const { wethAddress } = await this.lpEngine.getAddresses();
          const resolved = await this.lpEngine.resolvePool(item.tokenAddress, wethAddress);
          if (resolved) {
            item.poolAddress = resolved.poolAddress.toLowerCase();
            await prisma.watchlist.update({
              where: { id: item.id },
              data: { poolAddress: item.poolAddress }
            });
            console.log(`[Watchlist] ✅ Resolved pool for ${item.symbol}: ${item.poolAddress}`);
          } else {
            console.log(`[Watchlist] ⚠️ Still no pool address for ${item.symbol}, skipping.`);
            continue;
          }
        }

        console.log(`[Watchlist] 📊 Fetching TA for ${item.symbol} (${item.poolAddress})`);
        
        let tf = item.timeframe || 15;
        let candles = await fetchOHLCV(item.poolAddress, 100, tf);
        
        if (!candles || candles.length === 0) {
          console.log(`[Watchlist] ⚠️ No candle data available for ${item.symbol}, skipping.`);
          continue;
        }

        let c1 = candles[candles.length - 1];
        let isForming = (Date.now() - c1.timestamp < tf * 60 * 1000);
        let closedCandles = isForming ? candles.slice(0, -1) : candles;
        
        let ta = calculateIndicators(closedCandles);

        // Fallback 1: 5m
        if (!ta && tf === 15) {
          tf = 5;
          candles = await fetchOHLCV(item.poolAddress, 100, tf);
          if (candles && candles.length > 0) {
            c1 = candles[candles.length - 1];
            isForming = (Date.now() - c1.timestamp < tf * 60 * 1000);
            closedCandles = isForming ? candles.slice(0, -1) : candles;
            ta = calculateIndicators(closedCandles);
          }
        }
        
        // Fallback 2: 1m
        if (!ta && tf === 5) {
          tf = 1;
          candles = await fetchOHLCV(item.poolAddress, 100, tf);
          if (candles && candles.length > 0) {
            c1 = candles[candles.length - 1];
            isForming = (Date.now() - c1.timestamp < tf * 60 * 1000);
            closedCandles = isForming ? candles.slice(0, -1) : candles;
            ta = calculateIndicators(closedCandles);
          }
        }

        if (tf !== item.timeframe) {
          await prisma.watchlist.update({ where: { id: item.id }, data: { timeframe: tf } });
          item.timeframe = tf;
        }

        if (!ta) {
          console.log(`[Watchlist] Not enough closed candle data for ${item.symbol} even at ${tf}m TF.`);
          continue;
        }

        // Check Blacklist (Re-entry Rule) using persistent ATH
        const blacklisted = await prisma.tokenBlacklist.findUnique({
          where: { tokenAddress: item.tokenAddress }
        });

        if (blacklisted) {
          if (blacklisted.athPriceAtExit && (item.athClose || 0) > blacklisted.athPriceAtExit) {
            console.log(`[Watchlist] 🔓 ${item.symbol} broke ATH since exit! Removing from blacklist.`);
            await prisma.tokenBlacklist.delete({ where: { tokenAddress: item.tokenAddress } });
          } else {
            console.log(`[Watchlist] ⛔ ${item.symbol} is blacklisted until it breaks ATH > ${blacklisted.athPriceAtExit}. Skipping.`);
            continue;
          }
        }

        // Check Entry Condition: Supertrend Breakout OR New ATH
        let priorCandlesMax = 0;
        if (closedCandles.length > 1) {
          priorCandlesMax = Math.max(...closedCandles.slice(0, -1).map(c => c.close));
        }
        const priorAth = Math.max(item.athClose || 0, priorCandlesMax);
        const isSupertrendBullish = ta.supertrend.isGreen;
        const isNewAth = ta.currentClose > priorAth; 

        console.log(`[Watchlist] AGENT | TF ${tf}m | closed candles: ${closedCandles.length} | close: ${ta.currentClose.toFixed(5)} | ATR(10): ${ta.atr.toFixed(5)} | ST lower: ${ta.supertrend.lower.toFixed(5)} | ST upper: ${ta.supertrend.upper.toFixed(5)} | isGreen: ${isSupertrendBullish} | priorATH: ${priorAth.toFixed(5)} | isNewAth: ${isNewAth} | RSI(2): ${ta.rsi.toFixed(1)} | MACD hist: ${ta.macd.histogram.toFixed(5)}${isSupertrendBullish || isNewAth ? ' → ENTRY SIGNAL' : ''}`);

        let triggered = false;
        if (isSupertrendBullish || isNewAth) {
          const token = await getTokenInfo(item.tokenAddress);
          if (!token) {
            console.warn(`[Watchlist] Failed to fetch GMGN data for ${item.symbol}, skipping.`);
            continue;
          }
          
          const liveness = await checkLiveness(item.tokenAddress, token, item.poolAddress || '');
          if (!liveness.alive) {
            console.log(`[Watchlist] ❌ [Liveness] REJECT Entry for $${item.symbol} — ${liveness.failedCheck}: ${liveness.failReason}`);
            await prisma.watchlist.update({ where: { id: item.id }, data: { status: 'DROPPED', lastCheckedAt: new Date() } });
            continue;
          }
          
          await prisma.watchlist.update({ 
            where: { id: item.id }, 
            data: { 
              status: 'EXECUTED', 
              lastCheckedAt: new Date(),
              athClose: Math.max(item.athClose || 0, ta.windowHighClose) 
            } 
          });
          
          await this.lpEngine.proposeOpenPosition(
            { token, score: 100 },
            { dayMode: false, nightMode: false, strategyMode: true, lowerPct: 0.91, upperPct: 1.05, source: 'WATCHLIST' }
          );
          
          triggered = true;
          break; // Only open 1 position per loop
        }
        
        if (!triggered) {
          await prisma.watchlist.update({ 
            where: { id: item.id }, 
            data: { 
              lastCheckedAt: new Date(),
              athClose: Math.max(item.athClose || 0, ta.windowHighClose)
            } 
          });
        }
      } catch (err: any) {
        console.error(`[Watchlist] ❌ Failed to process ${item.symbol}: ${err.message}`);
      }
    }
  }
}
