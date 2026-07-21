/**
 * LP Math — Uniswap V3 fee & impermanent loss calculations
 *
 * Dipakai oleh:
 *   - lpengine.ts  (tick range calculation, amount estimation)
 *   - guardian.ts  (fee-vs-IL rule §3.4, per-jam monitoring)
 */

import { publicClient } from './viem.js';
import { parseAbi } from 'viem';
import { getDexConfig } from '../core/dexConfig.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Uniswap V3 absolute tick bounds */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** 2^96 — used in sqrtPriceX96 math */
const Q96 = 2n ** 96n;

// ─── ABI fragments ────────────────────────────────────────────────────────────

const POOL_ABI = parseAbi([
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function feeGrowthGlobal0X128() external view returns (uint256)',
  'function feeGrowthGlobal1X128() external view returns (uint256)',
]);

const NPM_ABI = parseAbi([
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PositionFees {
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  token0Symbol: string;
  token1Symbol: string;
}

export interface ILResult {
  /** IL in USD (negative = loss vs HODL) */
  ilUsd:       number;
  /** IL as percentage of entry value */
  ilPct:       number;
  hodlValueUsd: number;
  lpValueUsd:   number;
}

export interface RangeStatus {
  inRange:      boolean;
  currentTick:  number;
  tickLower:    number;
  tickUpper:    number;
  /** Price distance to nearest boundary, as % */
  distanceToBoundaryPct: number;
}

// ─── Tick & Price Helpers ─────────────────────────────────────────────────────

/**
 * Convert Uniswap V3 tick to price (token1 per token0).
 * price = 1.0001^tick
 */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * Convert price to nearest valid tick.
 * tick = floor(log(price) / log(1.0001))
 * Then rounded to nearest tickSpacing.
 */
export function priceToTick(price: number, tickSpacing: number): number {
  const rawTick = Math.floor(Math.log(price) / Math.log(1.0001));
  return Math.round(rawTick / tickSpacing) * tickSpacing;
}

/**
 * Get tickSpacing from feeTier.
 */
export function feeToTickSpacing(feeTier: number): number {
  if (feeTier === 500)   return 10;
  if (feeTier === 3000)  return 60;
  if (feeTier === 10000) return 200;
  return 60;
}

/**
 * Calculate tick range for NIGHT mode.
 * range = currentPrice ± rangePercent.
 * Returns [tickLower, tickUpper] rounded to tickSpacing.
 */
export function calcNightTickRange(
  currentTick: number,
  rangePercent: number, // e.g. 0.25 = ±25%
  feeTier: number
): { tickLower: number; tickUpper: number } {
  const spacing = feeToTickSpacing(feeTier);
  const currentPrice = tickToPrice(currentTick);
  const lowerPrice   = currentPrice * (1 - rangePercent);
  const upperPrice   = currentPrice * (1 + rangePercent);

  const rawLower = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
  const rawUpper = Math.floor(Math.log(upperPrice) / Math.log(1.0001));

  const tickLower = Math.max(MIN_TICK, Math.floor(rawLower / spacing) * spacing);
  const tickUpper = Math.min(MAX_TICK, Math.ceil(rawUpper  / spacing) * spacing);

  return { tickLower, tickUpper };
}

/**
 * Full-range ticks for DAY mode. Rounded to tickSpacing.
 */
export function fullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const spacing = feeToTickSpacing(feeTier);
  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  };
}

// ─── On-Chain Data Fetchers ───────────────────────────────────────────────────

/**
 * Read slot0 of the pool to get current tick & sqrtPrice.
 */
export async function getPoolSlot0(poolAddress: string): Promise<{
  sqrtPriceX96: bigint;
  currentTick: number;
}> {
  const result = await publicClient.readContract({
    address: poolAddress as `0x${string}`,
    abi: POOL_ABI,
    functionName: 'slot0',
  }) as unknown as [bigint, number, ...unknown[]];

  return {
    sqrtPriceX96: result[0],
    currentTick:  result[1],
  };
}

/**
 * Read positions(tokenId) from NPM to get accrued fees.
 */
export async function getNPMPosition(tokenId: bigint): Promise<{
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}> {
  const dexConfig = await getDexConfig('V3');
  const NPM_ADDRESS = dexConfig.positionManager;
  if (!NPM_ADDRESS) throw new Error('[lpMath] POSITION_MANAGER not set in DB config');

  const r = await publicClient.readContract({
    address: NPM_ADDRESS as `0x${string}`,
    abi: NPM_ABI,
    functionName: 'positions',
    args: [tokenId],
  }) as unknown as any[];

  return {
    token0:      r[2],
    token1:      r[3],
    fee:         Number(r[4]),
    tickLower:   Number(r[5]),
    tickUpper:   Number(r[6]),
    liquidity:   r[7] as bigint,
    tokensOwed0: r[10] as bigint,
    tokensOwed1: r[11] as bigint,
  };
}

// ─── Range Status ─────────────────────────────────────────────────────────────

/**
 * Check if the position is still in-range based on the current tick.
 */
export async function checkPositionRange(
  poolAddress: string,
  tickLower: number,
  tickUpper: number
): Promise<RangeStatus> {
  const { currentTick } = await getPoolSlot0(poolAddress);
  const inRange = currentTick >= tickLower && currentTick <= tickUpper;

  const distanceLower = Math.abs(currentTick - tickLower);
  const distanceUpper = Math.abs(tickUpper - currentTick);
  const rangeWidth    = tickUpper - tickLower;
  const distanceToBoundaryPct = rangeWidth > 0
    ? (Math.min(distanceLower, distanceUpper) / rangeWidth) * 100
    : 0;

  return { inRange, currentTick, tickLower, tickUpper, distanceToBoundaryPct };
}

// ─── Impermanent Loss ─────────────────────────────────────────────────────────

/**
 * Calculate Impermanent Loss using Uniswap V3 IL formula.
 *
 * IL = LP_value - HODL_value
 * For full-range, this is equivalent to the V2 formula.
 * For concentrated range, IL is higher inside the range.
 *
 * @param entryPrice0   Price of token0 in USD at entry
 * @param entryPrice1   Price of token1 in USD at entry
 * @param currentPrice0 Current price of token0 in USD
 * @param currentPrice1 Current price of token1 in USD
 * @param entryValue    Total entry value in USD
 * @param tickLower     Position lower tick
 * @param tickUpper     Position upper tick
 */
export function calcIL(params: {
  entryPrice0:   number;
  entryPrice1:   number;
  currentPrice0: number;
  currentPrice1: number;
  entryValue:    number;
  tickLower:     number;
  tickUpper:     number;
}): ILResult {
  const { entryPrice0, entryPrice1, currentPrice0, currentPrice1, entryValue } = params;

  // Price ratio change
  const priceRatio0 = entryPrice0 > 0 ? currentPrice0 / entryPrice0 : 1;
  const priceRatio1 = entryPrice1 > 0 ? currentPrice1 / entryPrice1 : 1;

  // Uniswap V2-equivalent IL formula (approximation for concentrated range):
  // LP_value = entryValue * 2 * sqrt(priceRatio0 * priceRatio1) / (priceRatio0 + priceRatio1) * avgPriceChange
  // Simplified: IL_factor = 2*sqrt(k)/(1+k) where k = priceRatio0/priceRatio1
  const k = priceRatio0 / (priceRatio1 || 1);
  const ilFactor  = (2 * Math.sqrt(k)) / (1 + k);
  const hodlValue = entryValue * (priceRatio0 * 0.5 + priceRatio1 * 0.5); // 50/50 HODL
  const lpValue   = entryValue * ilFactor * ((priceRatio0 + priceRatio1) / 2);

  const ilUsd = lpValue - hodlValue; // negative = loss
  const ilPct = hodlValue > 0 ? (ilUsd / hodlValue) * 100 : 0;

  return { ilUsd, ilPct, hodlValueUsd: hodlValue, lpValueUsd: lpValue };
}

// ─── Fee Rate Calculator ──────────────────────────────────────────────────────

/**
 * Calculate annualized fee rate based on fees collected during the period.
 *
 * @param feesUsd      Total fee USD yang di-collect dalam `periodHours`
 * @param positionUsd  Current position value in USD
 * @param periodHours  Observation window in hours
 * @returns Annualized fee APR (e.g. 0.5 = 50%)
 */
export function calcAnnualizedFeeRate(
  feesUsd: number,
  positionUsd: number,
  periodHours: number
): number {
  if (positionUsd <= 0 || periodHours <= 0) return 0;
  const hoursPerYear = 8760;
  return (feesUsd / positionUsd) * (hoursPerYear / periodHours);
}

/**
 * Calculate realized APR from total fees collected since opening.
 */
export function calcRealizedAPR(
  totalFeesUsd: number,
  entryValueUsd: number,
  daysOpen: number
): number {
  if (entryValueUsd <= 0 || daysOpen <= 0) return 0;
  return (totalFeesUsd / entryValueUsd) * (365 / daysOpen);
}

// ─── Day Close Check ──────────────────────────────────────────────────────────

/**
 * Check if it is past the closing time for DAY mode.
 * Default: 23:00 WIB (Asia/Jakarta).
 */
export function isPastDayCloseTime(closeTimeStr = '23:00', tz = 'Asia/Jakarta'): boolean {
  const [closeH, closeM] = closeTimeStr.split(':').map(Number);
  const now = new Date();
  // Get current time in target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const currentH = parseInt(parts.find(p => p.type === 'hour')!.value);
  const currentM = parseInt(parts.find(p => p.type === 'minute')!.value);
  return currentH > closeH || (currentH === closeH && currentM >= closeM);
}

/**
 * Cek apakah sekarang dalam window NIGHT mode.
 * nightWindow: { start: "22:00", end: "06:00", tz: "Asia/Jakarta" }
 */
export function isInNightWindow(window: { start: string; end: string; tz: string }): boolean {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: window.tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value);
  const nowMin   = h * 60 + m;
  const startMin = toMinutes(window.start);
  const endMin   = toMinutes(window.end);

  // Overnight window: start > end (e.g. 22:00 → 06:00)
  if (startMin > endMin) {
    return nowMin >= startMin || nowMin < endMin;
  }
  return nowMin >= startMin && nowMin < endMin;
}
