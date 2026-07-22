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
export function getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0) {
    let lower = sqrtRatioAX96;
    let upper = sqrtRatioBX96;
    if (lower > upper) {
        lower = sqrtRatioBX96;
        upper = sqrtRatioAX96;
    }
    const intermediate = (lower * upper) / Q96;
    return (amount0 * intermediate) / (upper - lower);
}
export function getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1) {
    let lower = sqrtRatioAX96;
    let upper = sqrtRatioBX96;
    if (lower > upper) {
        lower = sqrtRatioBX96;
        upper = sqrtRatioAX96;
    }
    return (amount1 * Q96) / (upper - lower);
}
export function getLiquidityForAmounts(sqrtRatioX96, sqrtRatioAX96, sqrtRatioBX96, amount0, amount1) {
    let lower = sqrtRatioAX96;
    let upper = sqrtRatioBX96;
    if (lower > upper) {
        lower = sqrtRatioBX96;
        upper = sqrtRatioAX96;
    }
    if (sqrtRatioX96 <= lower) {
        return getLiquidityForAmount0(lower, upper, amount0);
    }
    else if (sqrtRatioX96 < upper) {
        const liquidity0 = getLiquidityForAmount0(sqrtRatioX96, upper, amount0);
        const liquidity1 = getLiquidityForAmount1(lower, sqrtRatioX96, amount1);
        return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
    }
    else {
        return getLiquidityForAmount1(lower, upper, amount1);
    }
}
export function tickToSqrtPriceX96(tick) {
    const price = 1.0001 ** tick;
    const sqrtPrice = Math.sqrt(price);
    // multiply by 2^96
    // we do this using BigInt to maintain precision as best as we can in JS
    const fraction = BigInt(Math.floor(sqrtPrice * (2 ** 50))); // multiply by 2^50 as float
    const shifted = fraction * (2n ** 46n); // shift remaining 46 bits
    return shifted;
}
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
// ─── Tick & Price Helpers ─────────────────────────────────────────────────────
/**
 * Convert Uniswap V3 tick to price (token1 per token0).
 * price = 1.0001^tick
 */
export function tickToPrice(tick) {
    return Math.pow(1.0001, tick);
}
/**
 * Convert price to nearest valid tick.
 * tick = floor(log(price) / log(1.0001))
 * Then rounded to nearest tickSpacing.
 */
export function priceToTick(price, tickSpacing) {
    const rawTick = Math.floor(Math.log(price) / Math.log(1.0001));
    return Math.round(rawTick / tickSpacing) * tickSpacing;
}
/**
 * Get tickSpacing from feeTier.
 */
export function feeToTickSpacing(feeTier) {
    if (feeTier === 500)
        return 10;
    if (feeTier === 3000)
        return 60;
    if (feeTier === 10000)
        return 200;
    return 60;
}
/**
 * Calculate tick range for NIGHT mode.
 * range = currentPrice ± rangePercent.
 * Returns [tickLower, tickUpper] rounded to tickSpacing.
 */
export function calcNightTickRange(currentTick, tickMultiplier, // e.g. 2.0 = ±2.0x tick spacing
feeTier) {
    const spacing = feeToTickSpacing(feeTier);
    const halfRange = Math.round(spacing * tickMultiplier);
    const rawLower = currentTick - halfRange;
    const rawUpper = currentTick + halfRange;
    const tickLower = Math.max(MIN_TICK, Math.floor(rawLower / spacing) * spacing);
    const tickUpper = Math.min(MAX_TICK, Math.ceil(rawUpper / spacing) * spacing);
    return { tickLower, tickUpper };
}
/**
 * Full-range ticks for DAY mode. Rounded to tickSpacing.
 */
export function fullRangeTicks(feeTier) {
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
export async function getPoolSlot0(poolAddress) {
    const result = await publicClient.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'slot0',
    });
    return {
        sqrtPriceX96: result[0],
        currentTick: result[1],
    };
}
/**
 * Read positions(tokenId) from NPM to get accrued fees.
 */
export async function getNPMPosition(tokenId, managerAddress) {
    let NPM_ADDRESS = managerAddress;
    if (!NPM_ADDRESS) {
        const dexConfig = await getDexConfig('V3');
        NPM_ADDRESS = dexConfig.positionManager;
    }
    if (!NPM_ADDRESS)
        throw new Error('[lpMath] POSITION_MANAGER not set in DB config');
    const r = await publicClient.readContract({
        address: NPM_ADDRESS,
        abi: NPM_ABI,
        functionName: 'positions',
        args: [tokenId],
    });
    return {
        token0: r[2],
        token1: r[3],
        fee: Number(r[4]),
        tickLower: Number(r[5]),
        tickUpper: Number(r[6]),
        liquidity: r[7],
        tokensOwed0: r[10],
        tokensOwed1: r[11],
    };
}
// ─── Range Status ─────────────────────────────────────────────────────────────
/**
 * Check if the position is still in-range based on the current tick.
 */
export async function checkPositionRange(poolAddress, tickLower, tickUpper) {
    const { currentTick } = await getPoolSlot0(poolAddress);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;
    const distanceLower = Math.abs(currentTick - tickLower);
    const distanceUpper = Math.abs(tickUpper - currentTick);
    const rangeWidth = tickUpper - tickLower;
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
export function calcIL(params) {
    const { entryPrice0, entryPrice1, currentPrice0, currentPrice1, entryValue } = params;
    // Base prices in terms of token1/token0 ratio (assuming token1 is quote, e.g. USD)
    // price = P1 / P0 in terms of their USD values.
    const P0 = entryPrice1 > 0 ? entryPrice0 / entryPrice1 : 1;
    const P = currentPrice1 > 0 ? currentPrice0 / currentPrice1 : 1;
    const Pa = tickToPrice(params.tickLower);
    const Pb = tickToPrice(params.tickUpper);
    // If entry price is out of bounds, we clamp it for the purpose of finding initial token amounts.
    // Realistically it shouldn't be, but this protects the math.
    const clampedP0 = Math.max(Pa, Math.min(Pb, P0));
    // Let L = 1
    const x0 = (Math.sqrt(Pb) - Math.sqrt(clampedP0)) / (Math.sqrt(clampedP0) * Math.sqrt(Pb));
    const y0 = Math.sqrt(clampedP0) - Math.sqrt(Pa);
    // HODL value in terms of token1
    const hodl_unit_value = x0 * P + y0;
    // LP value in terms of token1
    let lp_unit_value = 0;
    if (P < Pa) {
        lp_unit_value = ((Math.sqrt(Pb) - Math.sqrt(Pa)) / (Math.sqrt(Pa) * Math.sqrt(Pb))) * P;
    }
    else if (P > Pb) {
        lp_unit_value = Math.sqrt(Pb) - Math.sqrt(Pa);
    }
    else {
        lp_unit_value = 2 * Math.sqrt(P) - (P / Math.sqrt(Pb)) - Math.sqrt(Pa);
    }
    // To get values in USD, we normalize against the entry value.
    // entry_unit_value is lp_unit_value at P0
    let entry_unit_value = 2 * Math.sqrt(clampedP0) - (clampedP0 / Math.sqrt(Pb)) - Math.sqrt(Pa);
    if (entry_unit_value <= 0)
        entry_unit_value = 1e-18; // protect div0
    // The actual LP value in USD today
    // We use currentPrice1 to convert the token1-denominated unit value to USD
    // Wait, entryValue is in USD. So at entry, L = entryValue / (entry_unit_value * entryPrice1)
    const L_usd = entryValue / (entry_unit_value * entryPrice1);
    const lpValue = L_usd * lp_unit_value * currentPrice1;
    const hodlValue = L_usd * hodl_unit_value * currentPrice1;
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
export function calcAnnualizedFeeRate(feesUsd, positionUsd, periodHours) {
    if (positionUsd <= 0 || periodHours <= 0)
        return 0;
    const hoursPerYear = 8760;
    return (feesUsd / positionUsd) * (hoursPerYear / periodHours);
}
/**
 * Calculate realized APR from total fees collected since opening.
 */
export function calcRealizedAPR(totalFeesUsd, entryValueUsd, daysOpen) {
    if (entryValueUsd <= 0 || daysOpen <= 0)
        return 0;
    return (totalFeesUsd / entryValueUsd) * (365 / daysOpen);
}
// ─── Day Close Check ──────────────────────────────────────────────────────────
/**
 * Check if it is past the closing time for DAY mode.
 * Default: 23:00 WIB (Asia/Jakarta).
 */
export function isPastDayCloseTime(closeTimeStr = '23:00', tz = 'Asia/Jakarta') {
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
    const currentH = parseInt(parts.find(p => p.type === 'hour').value);
    const currentM = parseInt(parts.find(p => p.type === 'minute').value);
    return currentH > closeH || (currentH === closeH && currentM >= closeM);
}
/**
 * Cek apakah sekarang dalam window NIGHT mode.
 * nightWindow: { start: "22:00", end: "06:00", tz: "Asia/Jakarta" }
 */
export function isInNightWindow(window) {
    const toMinutes = (t) => {
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
    const h = parseInt(parts.find(p => p.type === 'hour').value);
    const m = parseInt(parts.find(p => p.type === 'minute').value);
    const nowMin = h * 60 + m;
    const startMin = toMinutes(window.start);
    const endMin = toMinutes(window.end);
    // Overnight window: start > end (e.g. 22:00 → 06:00)
    if (startMin > endMin) {
        return nowMin >= startMin || nowMin < endMin;
    }
    return nowMin >= startMin && nowMin < endMin;
}
