import { prisma } from '../core/db.js';
import type { GMGNToken } from '../services/gmgn/endpoints.js';

export type LivenessVerdict = {
  alive: boolean;
  failedCheck?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  failReason?: string;
};

/**
 * Executes the Liveness Gate checks (L1, L6, L3, L2, L5, L4).
 * A token is considered DEAD if any check fails.
 */
export async function checkLiveness(
  tokenAddress: string,
  tokenData: GMGNToken,
  poolAddress: string
): Promise<LivenessVerdict> {
  // Check Liveness Cache first
  const cached = await prisma.livenessCache.findUnique({
    where: { tokenAddress: tokenAddress }
  });

  if (cached && cached.expiresAt > new Date()) {
    if (cached.verdict === 'DEAD') {
      return { alive: false, failedCheck: cached.failedCheck as any, failReason: cached.failReason || 'Cached' };
    } else {
      return { alive: true };
    }
  }

  // Load configs
  const configs = await prisma.systemConfig.findMany({
    where: { key: { startsWith: 'liveness.' } }
  });
  const conf = Object.fromEntries(configs.map(c => [c.key, c.value]));
  
  const minVol1h = parseFloat(conf['liveness.minVol1hUsd'] || '40000');
  const minDecay = parseFloat(conf['liveness.minVolumeDecayRatio'] || '0.30');
  const maxAthDrawdown = parseFloat(conf['liveness.maxAthDrawdownPct'] || '70') / 100;
  const cacheMin = parseInt(conf['liveness.verdictCacheMin'] || '5', 10);
  const blacklistHours = parseInt(conf['liveness.deadBlacklistHours'] || '6', 10);

  const setCache = async (verdict: 'ALIVE' | 'DEAD', failedCheck?: string, failReason?: string) => {
    const expiresAt = new Date();
    if (verdict === 'ALIVE') {
      expiresAt.setMinutes(expiresAt.getMinutes() + cacheMin);
    } else {
      expiresAt.setHours(expiresAt.getHours() + blacklistHours);
    }
    
    await prisma.livenessCache.upsert({
      where: { tokenAddress: tokenAddress },
      update: { verdict, failedCheck, failReason, expiresAt },
      create: { tokenAddress, verdict, failedCheck, failReason, expiresAt }
    });
  };

  const reject = async (check: any, reason: string): Promise<LivenessVerdict> => {
    await setCache('DEAD', check, reason);
    
    // Increment factory consecutive fails if token belongs to a known factory
    if (tokenData.launchPad && tokenData.launchPad !== 'None' && tokenData.launchPad.toLowerCase() !== 'unknown') {
      const factory = await prisma.factoryRegistry.findFirst({
        where: { name: { equals: tokenData.launchPad, mode: 'insensitive' } }
      });
      if (factory) {
        await prisma.factoryRegistry.update({
          where: { id: factory.id },
          data: { consecutiveLivenessFails: { increment: 1 } }
        });
      }
    }
    
    return { alive: false, failedCheck: check, failReason: reason };
  };

  // --- L1: Data Existence ---
  if (!tokenData.volume24h || !tokenData.liquidity || !tokenData.priceUsd) {
    return reject('L1', `Missing basic data: vol24h=${tokenData.volume24h}, liq=${tokenData.liquidity}, price=${tokenData.priceUsd}`);
  }

  // --- L6: Source Liveness ---
  if (tokenData.launchPad && tokenData.launchPad !== 'None' && tokenData.launchPad.toLowerCase() !== 'unknown') {
    const factory = await prisma.factoryRegistry.findFirst({
      where: { name: { equals: tokenData.launchPad, mode: 'insensitive' } }
    });
    if (factory && (factory.status === 'dead' || factory.status === 'dormant')) {
      return reject('L6', `Factory ${factory.name} is ${factory.status}`);
    }
  }

  // --- L3: Volume Decay ---
  const vol1h = tokenData.vol1h;
  const vol24h = tokenData.volume24h;
  if (vol1h < minVol1h) {
    return reject('L3', `vol1h ($${vol1h.toFixed(2)}) < $${minVol1h}`);
  }
  
  if (vol24h > 0) {
    const runRate = vol1h * 24;
    const decay = runRate / vol24h;
    if (decay < minDecay) {
      return reject('L3', `Volume decay: runRate/vol24h = ${decay.toFixed(2)} < ${minDecay}`);
    }
  }

  // --- L2: Trade Recency ---
  // If we have 0 swaps in the last 5m and less than 10 swaps in the last 1h, it's dead.
  if (tokenData.swaps5m === 0 && tokenData.swaps1h < 10) {
    return reject('L2', `No swaps in last 5m and < 10 swaps in 1h (${tokenData.swaps1h})`);
  }

  // --- L5: Price Structure ---
  if (tokenData.athPrice && tokenData.athPrice > 0 && tokenData.priceUsd > 0) {
    const drawdown = 1 - (tokenData.priceUsd / tokenData.athPrice);
    if (drawdown > maxAthDrawdown) {
      return reject('L5', `ATH Drawdown ${(drawdown * 100).toFixed(2)}% > ${(maxAthDrawdown * 100).toFixed(0)}%`);
    }
  }

  // --- L4: Liquidity Direction ---
  if (tokenData.liquidity < 5000) {
     return reject('L4', `Liquidity drained to < $5000 ($${tokenData.liquidity.toFixed(2)})`);
  }
  if (tokenData.liquidity < vol1h * 0.05) {
     return reject('L4', `Liquidity too thin compared to 1h vol (liq=$${tokenData.liquidity.toFixed(2)}, vol1h=$${vol1h.toFixed(2)})`);
  }

  // Passed all checks
  await setCache('ALIVE');
  
  // Reset factory consecutive fails on success
  if (tokenData.launchPad && tokenData.launchPad !== 'None' && tokenData.launchPad.toLowerCase() !== 'unknown') {
    const factory = await prisma.factoryRegistry.findFirst({
      where: { name: { equals: tokenData.launchPad, mode: 'insensitive' } }
    });
    if (factory && factory.consecutiveLivenessFails > 0) {
      await prisma.factoryRegistry.update({
        where: { id: factory.id },
        data: { consecutiveLivenessFails: 0 }
      });
    }
  }

  return { alive: true };
}
