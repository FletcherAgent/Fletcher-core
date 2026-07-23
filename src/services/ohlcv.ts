import { gotScraping as got } from 'got-scraping';
import { RSI, MACD, BollingerBands } from 'technicalindicators';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Indicators {
  supertrend: {
    upper: number;
    lower: number;
    isGreen: boolean;
  };
  rsi: number;
  macd: { macd: number; signal: number; histogram: number; previousHistogram: number };
  bb: {
    upper: number;
    middle: number;
    lower: number;
  };
  highestClose: number;
  currentClose: number;
  volumeHistory: number[];
}

export async function fetchOHLCV(poolAddress: string, limit: number = 100): Promise<Candle[]> {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${poolAddress}/ohlcv/minute?aggregate=15&limit=${limit}`;
    const res = await got.get(url, { responseType: 'json' }).json<any>();
    
    if (!res?.data?.attributes?.ohlcv_list) return [];
    
    // API returns [timestamp, open, high, low, close, volume]
    const list = res.data.attributes.ohlcv_list;
    // GeckoTerminal returns newest first. We need oldest first for indicators.
    const reversed = list.reverse();
    
    return reversed.map((c: any) => ({
      timestamp: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (error: any) {
    console.error(`[OHLCV] Failed to fetch for ${poolAddress}:`, error.message);
    return [];
  }
}

export function calculateIndicators(candles: Candle[]): Indicators | null {
  if (candles.length < 50) return null; // Need enough history

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // 1. Supertrend (10, 3)
  const period = 10;
  const multiplier = 3;
  
  let atrValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    );
    if (i === 1) {
      atrValues.push(tr);
    } else {
      atrValues.push((atrValues[atrValues.length - 1] * (period - 1) + tr) / period);
    }
  }

  let supertrendUpper = 0;
  let supertrendLower = 0;
  let isGreen = true;
  
  for (let i = 1; i < candles.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const atr = atrValues[i - 1] || 0;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;
    
    if (i === 1) {
      supertrendUpper = basicUpper;
      supertrendLower = basicLower;
      isGreen = closes[i] > supertrendUpper;
    } else {
      const prevUpper = supertrendUpper;
      const prevLower = supertrendLower;
      
      supertrendUpper = (basicUpper < prevUpper || closes[i-1] > prevUpper) ? basicUpper : prevUpper;
      supertrendLower = (basicLower > prevLower || closes[i-1] < prevLower) ? basicLower : prevLower;
      
      if (isGreen && closes[i] < supertrendLower) {
        isGreen = false;
      } else if (!isGreen && closes[i] > supertrendUpper) {
        isGreen = true;
      }
    }
  }

  // 2. RSI (2)
  const rsiResult = RSI.calculate({ period: 2, values: closes });
  const currentRSI = rsiResult[rsiResult.length - 1] || 0;

  // 3. MACD (12, 26, 9)
  const macdResult = MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
    values: closes
  });
  const currentMACD = macdResult[macdResult.length - 1] || { MACD: 0, signal: 0, histogram: 0 };

  // 4. Bollinger Bands (20, 2)
  const bbResult = BollingerBands.calculate({
    period: 20,
    stdDev: 2,
    values: closes
  });
  const currentBB = bbResult[bbResult.length - 1] || { upper: 0, middle: 0, lower: 0 };

  // 5. Highest Close (ATH logic)
  const highestClose = Math.max(...closes);

  return {
    supertrend: {
      upper: supertrendUpper,
      lower: supertrendLower,
      isGreen
    },
    rsi: currentRSI,
    macd: {
      macd: currentMACD.MACD || 0,
      signal: currentMACD.signal || 0,
      histogram: currentMACD.histogram || 0,
      previousHistogram: macdResult.length > 1 ? (macdResult[macdResult.length - 2]?.histogram || 0) : 0
    },
    bb: {
      upper: currentBB.upper,
      middle: currentBB.middle,
      lower: currentBB.lower
    },
    highestClose,
    currentClose: closes[closes.length - 1],
    volumeHistory: volumes.slice(-4)
  };
}
