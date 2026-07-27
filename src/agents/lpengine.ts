/**
 * LP Engine Agent — Fletcher v2.0 Core
 *
 * Autonomous LP position manager based on Uniswap V3 (NonfungiblePositionManager).
 * Acts as Fletcher's main agent replacing the simple LP safety check.
 *
 * Supported Modes:
 *   - DAY mode  : full-range position, bigcap runner, close at 23:00 WIB
 *   - NIGHT mode: concentrated range ±25%, spray ≤3 pair, close in the morning
 *
 * Execution:
 *   - MANUAL : all tx via Telegram approval
 *   - SEMI   : automatic collect + compound via session key (Phase 3)
 *   - FULL   : all LP ops via session key (Phase 3)
 *
 * Zero-custody: agent only builds calldata & proposes. User signs.
 */

import { encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbi, parseUnits, decodeEventLog, type Address, type Hex } from 'viem';
import { PrismaClient } from '@prisma/client';
import { publicClient, walletClient, account } from '../services/viem.js';
import { getSessionKeyClient, buildAndSendLPUserOperation, ensureSmartAccountFunded, type UserOpCall } from '../services/sessionKey.js';
import { getUserTier, getTierLimits } from '../services/tierGate.js';
import { prisma } from '../core/db.js';
import { logEvent } from '../utils/logger.js';
import { dbLogger } from '../services/logger.js';
import { getDexConfig, getAllDexConfigs } from '../core/dexConfig.js';
import { IntelligenceLayer } from '../services/intelligence.js';
import {
  screenPairs,
  type PoolCandidate,
  type LPScreeningCriteria,
  type GMGNToken,
} from '../services/gmgn.js';
import {
  fullRangeTicks,
  tickToPrice,
  calcNightTickRange,
  getNPMPosition,
  getPoolSlot0,
  getFeeGrowthGlobal,
  feeToTickSpacing,
  MIN_TICK,
  MAX_TICK,
  getLiquidityForAmounts,
  tickToSqrtPriceX96
} from '../services/lpMath.js';

// ─── ABI ─────────────────────────────────────────────────────────────────────

const NPM_ABI = parseAbi([
  // mint
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  // increaseLiquidity
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function increaseLiquidity(IncreaseLiquidityParams params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  // decreaseLiquidity
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function decreaseLiquidity(DecreaseLiquidityParams params) external payable returns (uint256 amount0, uint256 amount1)',
  // collect
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function collect(CollectParams params) external payable returns (uint256 amount0, uint256 amount1)',
  // burn
  'function burn(uint256 tokenId) external payable',
  // positions (for reading)
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  // events
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);

const MAX_UINT128 = 340282366920938463463374607431768211455n;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LPProposal {
  type: 'OPEN' | 'CLOSE' | 'COMPOUND' | 'REBALANCE' | 'HARVEST';
  positionId?: string;   // LPPosition.id (if existing)
  agentId?: string;      // User Agent ID (if applicable)
  pool: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  entryValueUsd: number;
  calldata: Hex;      // encoded tx data for NPM
  to: Address;  // NPM address
  dayMode: boolean;
  nightMode: boolean;
  mode: 'MANUAL' | 'SEMI' | 'FULL';
  description: string;   // human-readable for Telegram
}

// ─── MetaConfig loader ────────────────────────────────────────────────────────

interface LPConfig {
  maxPositions: number;
  positionCap: number;
  startSizeLive: number;
  startSizeDryRun: number;
  nightRange: number;
  dayCloseTime: string;
  ilHourThreshold: number;
  minGrokScore: number;
  /** Minutes to wait before triggering rebalance/close when out of range (grace period) */
  outOfRangeGraceMinutes: number;
  /** If true, use MCap-based dynamic range multiplier instead of fixed nightRange */
  dynamicRange: boolean;
}

/**
 * Returns a dynamic night range multiplier based on token market cap.
 * Smaller MCap = wider range needed (more volatile).
 */
function calcDynamicNightRange(marketCapUsd: number): number {
  if (marketCapUsd < 50_000) return 20;  // < $50K  → ±40% range (ultra meme)
  if (marketCapUsd < 200_000) return 15;  // < $200K → ±30% range
  if (marketCapUsd < 1_000_000) return 10;  // < $1M   → ±20% range
  if (marketCapUsd < 5_000_000) return 7;   // < $5M   → ±14% range
  return 5;                                    // > $5M   → ±10% range (more stable)
}

async function loadLPConfig(): Promise<LPConfig> {
  const keys = [
    'lp.maxPositions', 'lp.positionCap', 'lp.startSize.live', 'lp.startSize.dryrun',
    'lp.nightRange', 'lp.dayCloseTime', 'lp.ilHourThreshold', 'lp.minGrokScore',
    'lp.outOfRangeGraceMinutes', 'lp.dynamicRange'
  ];
  const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(configs.map(c => [c.key, c.value]));

  return {
    maxPositions: parseInt(map['lp.maxPositions'] ?? '3'),
    positionCap: parseFloat(map['lp.positionCap'] ?? '2000'),
    startSizeLive: parseFloat(map['lp.startSize.live'] ?? '10'),
    startSizeDryRun: parseFloat(map['lp.startSize.dryrun'] ?? '500'),
    nightRange: parseFloat(map['lp.nightRange'] ?? '15'),
    dayCloseTime: map['lp.dayCloseTime'] ?? '23:00',
    ilHourThreshold: parseInt(map['lp.ilHourThreshold'] ?? '4'),
    minGrokScore: parseInt(map['lp.minGrokScore'] ?? '60'),
    outOfRangeGraceMinutes: parseInt(map['lp.outOfRangeGraceMinutes'] ?? '15'),
    dynamicRange: (map['lp.dynamicRange'] ?? 'true') === 'true',
  };
}

// ─── LP Engine Agent ──────────────────────────────────────────────────────────

export class LPEngineAgent {

  /** Callback -> Orchestrator: send proposal to approval flow */
  public onProposal?: (proposal: LPProposal) => Promise<void>;
  public onNotification?: (message: string) => Promise<void>;

  constructor() { }

  public async getAddresses() {
    const dexConfig = await getDexConfig('V3');
    const npmAddress = (dexConfig.positionManager || '') as Address;
    const factoryAddress = (dexConfig.factoryAddress || '') as Address;

    const quoteConfig = await prisma.systemConfig.findMany({
      where: { key: { in: ['tokens.quote.weth', 'tokens.quote.usdg'] } }
    });
    const quoteMap = Object.fromEntries(quoteConfig.map(c => [c.key, c.value]));
    const wethAddress = (quoteMap['tokens.quote.weth'] || process.env.WETH_ADDRESS || '') as Address;
    const usdgAddress = (quoteMap['tokens.quote.usdg'] || '') as Address;

    if (!npmAddress) console.warn('[LPEngine] ⚠️ POSITION_MANAGER not set');
    if (!factoryAddress) console.warn('[LPEngine] ⚠️ UNISWAP_V3_FACTORY_ADDRESS not set');
    if (!wethAddress) console.warn('[LPEngine] ⚠️ WETH_ADDRESS not set (DB nor env)');

    return {
      npmAddress: npmAddress.toLowerCase() as `0x${string}`,
      factoryAddress: factoryAddress.toLowerCase() as `0x${string}`,
      wethAddress: wethAddress.toLowerCase() as `0x${string}`,
      usdgAddress: usdgAddress.toLowerCase() as `0x${string}`
    };
  }

  // ─── Zombie Cleanup ─────────────────────────────────────────────────────────

  /**
   * Cleans up PENDING positions older than 10 minutes that have no txHash.
   * This prevents them from becoming zombies that block new entries if the process restarts
   * while waiting for a transaction to be mined.
   */
  public async cleanupZombiePositions(): Promise<void> {
    const threshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    try {
      const zombies = await prisma.lPPosition.findMany({
        where: {
          status: 'PENDING',
          txHash: null,
          createdAt: { lt: threshold }
        }
      });
      if (zombies.length > 0) {
        dbLogger.info(`[LPEngine] 🧟 Found ${zombies.length} zombie PENDING positions. Marking as FAILED...`, { source: 'LPEngine' });
        for (const zombie of zombies) {
          await prisma.lPPosition.update({
            where: { id: zombie.id },
            data: { status: 'FAILED' }
          });
          await logEvent('WARN', `[LP] Zombie Cleanup: Marked ${zombie.token0Symbol}/${zombie.token1Symbol} as FAILED`, { positionId: zombie.id });
        }
      }
    } catch (e: any) {
      dbLogger.error(`[LPEngine] Failed to cleanup zombie positions: ${e.message}`, { source: 'LPEngine' });
    }
  }

  // ─── Position Cap Check ─────────────────────────────────────────────────────

  /** Check if new position can be opened (max positions from metaConfig) for the current mode */
  private async canOpenNewPosition(): Promise<{ ok: boolean; reason?: string }> {
    await this.cleanupZombiePositions();

    const config = await loadLPConfig();
    const modeCfg = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const isDryRun = (modeCfg?.value || 'LIVE') === 'DRY_RUN';
    const currentMode = isDryRun ? 'DRY_RUN' : 'LIVE';

    const openCount = await prisma.lPPosition.count({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        tradingMode: currentMode
      },
    });
    if (openCount >= config.maxPositions) {
      return { ok: false, reason: `Already at max ${config.maxPositions} positions for ${currentMode} (${openCount} open)` };
    }
    return { ok: true };
  }

  // ─── Pool Resolution ────────────────────────────────────────────────────────

  public async resolvePool(
    token0: string,
    token1?: string,
    preferredFee = 3000
  ): Promise<{ poolAddress: string; feeTier: number; factoryAddress: string; managerAddress: string; version: string; quoteAddress: string } | null> {
    const v3ConfigsRaw = await getAllDexConfigs('V3');
    const v4ConfigsRaw = await getAllDexConfigs('V4');

    // Map V4's poolManager to factoryAddress so getPool works
    const v4ConfigsMapped = v4ConfigsRaw.map(c => ({
      ...c,
      factoryAddress: c.poolManager || c.factoryAddress,
      version: 'V4'
    }));

    const v3Configs = v3ConfigsRaw.map(c => ({ ...c, version: 'V3' }));
    const allConfigs = [...v3Configs, ...v4ConfigsMapped];

    // Try all standard fees to find the most liquid pool
    const feesToTry = [10000, 3000, 500, 100];

    const quoteConfig = await prisma.systemConfig.findMany({
      where: { key: { in: ['tokens.quote.weth', 'tokens.quote.usdg'] } }
    });
    const quoteMap = Object.fromEntries(quoteConfig.map(c => [c.key, c.value]));
    const wethAddress = quoteMap['tokens.quote.weth'] || process.env.WETH_ADDRESS || '';
    const usdgAddress = quoteMap['tokens.quote.usdg'] || process.env.USDG_ADDRESS || '';

    const quotesToTry = token1 ? [token1] : [
      usdgAddress,
      wethAddress,
    ].filter(Boolean) as string[];
    const uniqueQuotes = Array.from(new Set(quotesToTry.map(a => a.toLowerCase())));

    const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);

    let bestPool: { poolAddress: string; feeTier: number; factoryAddress: string; managerAddress: string; liquidity: bigint; version: string; quoteAddress: string } | null = null;

    for (const config of allConfigs) {
      if (!config.factoryAddress || !config.positionManager) continue;

      for (const qt of uniqueQuotes) {
        for (const fee of feesToTry) {
          try {
            const poolAddr = await publicClient.readContract({
              address: config.factoryAddress as Address,
              abi: FACTORY_ABI,
              functionName: 'getPool',
              args: [token0 as Address, qt as Address, fee],
            }) as string;

            if (poolAddr && poolAddr !== '0x0000000000000000000000000000000000000000') {
              let liq = 0n;
              try {
                liq = await publicClient.readContract({
                  address: poolAddr as Address,
                  abi: poolAbi,
                  functionName: 'liquidity'
                }) as bigint;
              } catch (err) { }

              dbLogger.info(`[LPEngine] 🔎 Found pool candidate: ${poolAddr} on ${config.factoryAddress} (fee: ${fee}, liq: ${liq})`, { source: 'LPEngine' });

              if (!bestPool || liq > bestPool.liquidity) {
                bestPool = {
                  poolAddress: poolAddr,
                  feeTier: fee,
                  factoryAddress: config.factoryAddress,
                  managerAddress: config.positionManager,
                  liquidity: liq,
                  version: config.version,
                  quoteAddress: qt
                };
              }
            }
          } catch (error) {
            // suppress getPool fail errors to avoid log spam
          }
        }
      }
    }

    if (bestPool) {
      dbLogger.info(`[LPEngine] ✅ Best Pool Selected: ${bestPool.poolAddress} (fee: ${bestPool.feeTier}, liq: ${bestPool.liquidity})`, { source: 'LPEngine' });
      return {
        poolAddress: bestPool.poolAddress,
        feeTier: bestPool.feeTier,
        factoryAddress: bestPool.factoryAddress,
        managerAddress: bestPool.managerAddress,
        version: bestPool.version,
        quoteAddress: bestPool.quoteAddress
      };
    }
    return null;
  }

  // ─── Token Helpers ──────────────────────────────────────────────────────────

  private async getTokenMeta(address: string): Promise<{ decimals: number; symbol: string }> {
    try {
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({ address: address as Address, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
        publicClient.readContract({ address: address as Address, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
      ]);
      return { decimals: Number(decimals), symbol };
    } catch {
      return { decimals: 18, symbol: address.slice(0, 6) };
    }
  }

  /** Convert USD amount to token amount (approximate via price) */
  private usdToTokenAmount(usdAmount: number, priceUsd: number, decimals: number): bigint {
    if (priceUsd <= 0) return 0n;
    const tokenAmount = usdAmount / priceUsd;
    return BigInt(Math.floor(tokenAmount * 10 ** decimals));
  }

  // ─── NPM Calldata Builders ──────────────────────────────────────────────────

  buildMintCalldata(params: {
    token0: Address; token1: Address; fee: number; tickSpacing: number; hooks: Address;
    tickLower: number; tickUpper: number;
    amount0Desired: bigint; amount1Desired: bigint;
    liquidity: bigint;
    recipient: Address; deadline: bigint;
  }): Hex {
    const MAX_UINT128 = 340282366920938463463374607431768211455n; // 2**128 - 1
    const actions = '0x020d' as Hex; // MINT_POSITION (0x02), SETTLE_PAIR (0x0d)
    const param0 = encodeAbiParameters(
      parseAbiParameters('address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData'),
      [
        params.token0, params.token1, params.fee, params.tickSpacing, params.hooks,
        params.tickLower, params.tickUpper, params.liquidity,
        MAX_UINT128, MAX_UINT128, params.recipient, '0x'
      ]
    );
    const param1 = encodeAbiParameters(
      parseAbiParameters('address currency0, address currency1'),
      [params.token0, params.token1]
    );
    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes actions, bytes[] params'),
      [actions, [param0, param1]]
    );

    return encodeFunctionData({
      abi: parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) external payable']),
      functionName: 'modifyLiquidities',
      args: [unlockData, params.deadline]
    });
  }

  /**
   * Build V4 modifyLiquidities calldata for collecting fees (DECREASE with 0 liquidity then TAKE_PAIR).
   * On V4, calling decrease with 0 liquidity credits the caller with accrued fees.
   * This replaces the V3 `collect()` function.
   */
  buildCollectCalldata(tokenId: bigint, recipient: Address, token0: Address, token1: Address, deadline: bigint): Hex {
    // Action 0x01 = DECREASE_LIQUIDITY (with 0 liq = collect fees only), 0x11 = TAKE_PAIR (ALPS V4)
    const actions = '0x0111' as Hex;
    const param0 = encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData'),
      [tokenId, 0n, 0n, 0n, '0x']
    );
    const param1 = encodeAbiParameters(
      parseAbiParameters('address currency0, address currency1, address recipient'),
      [token0, token1, recipient]
    );
    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes actions, bytes[] params'),
      [actions, [param0, param1]]
    );
    return encodeFunctionData({
      abi: parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) external payable']),
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline]
    });
  }

  /**
   * Build V4 modifyLiquidities calldata for BURN_POSITION.
   * BURN_POSITION (0x06) automatically decreases 100% liquidity and burns the NFT.
   * Must be followed by TAKE_PAIR (0x0e) to sweep tokens to recipient.
   */
  buildDecreaseLiquidityCalldata(
    tokenId: bigint,
    liquidity: bigint,
    deadline: bigint,
    token0: Address,
    token1: Address,
    recipient: Address
  ): Hex {
    // Action 0x03 = BURN_POSITION, 0x11 = TAKE_PAIR (ALPS V4 action values)
    const actions = '0x0311' as Hex;
    const param0 = encodeAbiParameters(
      parseAbiParameters('uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData'),
      [tokenId, 0n, 0n, '0x']
    );
    const param1 = encodeAbiParameters(
      parseAbiParameters('address currency0, address currency1, address recipient'),
      [token0, token1, recipient]
    );
    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes actions, bytes[] params'),
      [actions, [param0, param1]]
    );
    return encodeFunctionData({
      abi: parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) external payable']),
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline]
    });
  }

  buildIncreaseLiquidityCalldata(
    tokenId: bigint,
    amount0Desired: bigint,
    amount1Desired: bigint,
    deadline: bigint
  ): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'increaseLiquidity',
      args: [{
        tokenId,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }],
    });
  }

  buildBurnCalldata(tokenId: bigint): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'burn',
      args: [tokenId],
    });
  }

  // ─── MODE DAY: Full-Range Position ─────────────────────────────────────────

  /**
   * Pick top daily runner from screening -> create DAY position proposal.
   * Full range = MIN_TICK/MAX_TICK -> minimal IL, fee from volume.
   */
  async runDayMode(): Promise<void> {
    dbLogger.info('[LPEngine] ☀️ DAY mode started...', { source: 'LPEngine' });
    if (this.onNotification) await this.onNotification('☀️ *LP DAY mode started* — screening pairs...');

    const config = await loadLPConfig();
    const canOpen = await this.canOpenNewPosition();
    if (!canOpen.ok) {
      console.warn(`[LPEngine] ⛔ DAY mode blocked: ${canOpen.reason}`);
      await logEvent('WARN', `[LP] DAY mode blocked: ${canOpen.reason}`);
      if (this.onNotification) await this.onNotification(`⛔ *DAY mode blocked:* ${canOpen.reason}`);
      return;
    }

    // Screen pairs
    const candidates = await screenPairs();
    if (candidates.length === 0) {
      console.warn('[LPEngine] DAY mode: no pairs passed screening');
      return;
    }

    let selectedCandidate: PoolCandidate | null = null;

    const grokModeConfig = await prisma.systemConfig.findUnique({ where: { key: 'grok.mode' } });
    const grokMode = grokModeConfig?.value || 'VETO';

    // Evaluate candidates with Grok
    for (const candidate of candidates) {
      dbLogger.info(`[LPEngine] 🧠 Asking Grok to analyze sentiment for ${candidate.token.symbol}...`, { source: 'LPEngine' });

      const sentiment = await IntelligenceLayer.analyzeSentiment(candidate.token.symbol, candidate.token.address);
      if (sentiment.label === 'SKIPPED') {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: SKIPPED - ${sentiment.reasoning}`, { source: 'LPEngine' });
        candidate.grokScore = undefined;
        candidate.grokLabel = 'SKIPPED';
      } else if (sentiment.label === 'BEARISH' || (sentiment.score !== null && sentiment.score < config.minGrokScore)) {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`, { source: 'LPEngine' });
        if (grokMode === 'ANNOTATION') {
          dbLogger.info(`[LPEngine] 📝 Grok flagged ${candidate.token.symbol} as BEARISH, but grok.mode is ANNOTATION. Proceeding.`, { source: 'LPEngine' });
          candidate.grokScore = sentiment.score ?? undefined;
          candidate.grokLabel = sentiment.label;
        } else {
          dbLogger.info(`[LPEngine] ❌ Grok REJECTED ${candidate.token.symbol}: Bearish or score < ${config.minGrokScore}`, { source: 'LPEngine' });
          continue;
        }
      } else {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`, { source: 'LPEngine' });
        dbLogger.info(`[LPEngine] ✅ Grok APPROVED ${candidate.token.symbol}`, { source: 'LPEngine' });
        if (this.onNotification) await this.onNotification(`✅ *Grok APPROVED $${candidate.token.symbol}*\nScore: ${sentiment.score}\n_Wait for V3 pool..._`);
        candidate.grokScore = sentiment.score ?? undefined;
        candidate.grokLabel = sentiment.label;
      }

      selectedCandidate = candidate;
      break; // Found the top candidate that passed Grok
    }

    if (!selectedCandidate) {
      console.warn('[LPEngine] DAY mode: No pairs passed Grok sentiment analysis');
      await logEvent('WARN', '[LP] DAY mode: No pairs passed Grok sentiment analysis');
      return;
    }

    const addrs = await this.getAddresses();
    let qSymbol = 'UNKNOWN';
    if (selectedCandidate.token.quoteToken?.toLowerCase() === addrs.wethAddress.toLowerCase()) qSymbol = 'WETH';
    if (selectedCandidate.token.quoteToken?.toLowerCase() === addrs.usdgAddress?.toLowerCase()) qSymbol = 'USDG';

    // Push to Watchlist instead of opening directly
    await prisma.watchlist.upsert({
      where: { tokenAddress: selectedCandidate.token.address.toLowerCase() },
      update: {
        symbol: selectedCandidate.token.symbol,
        name: selectedCandidate.token.name,
        quoteAddress: selectedCandidate.token.quoteToken,
        quoteSymbol: qSymbol,
        poolAddress: selectedCandidate.pool.address.toLowerCase(),
        sentimentStatus: selectedCandidate.grokLabel,
        tradingMode: (await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }))?.value === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE',
        status: 'WATCHING',
      },
      create: {
        tokenAddress: selectedCandidate.token.address.toLowerCase(),
        symbol: selectedCandidate.token.symbol,
        name: selectedCandidate.token.name,
        quoteAddress: selectedCandidate.token.quoteToken,
        quoteSymbol: qSymbol,
        poolAddress: selectedCandidate.pool.address.toLowerCase(),
        sentimentStatus: selectedCandidate.grokLabel,
        tradingMode: (await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }))?.value === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE',
      }
    });

    dbLogger.info(`[LPEngine] 📋 Added $${selectedCandidate.token.symbol} to Watchlist (Awaiting TA Signal)`, { source: 'LPEngine' });
    if (this.onNotification) await this.onNotification(`📋 *Added to Watchlist:* $${selectedCandidate.token.symbol}\n_Awaiting Supertrend/ATH breakout_`);
  }

  // ─── MODE NIGHT: Concentrated Spray ────────────────────────────────────────

  /**
   * Spray ≤3 pair lolos screening dengan concentrated range ±nightRange%.
   * Deploy sebelum tidur, collect pagi.
   */
  async runNightMode(): Promise<void> {
    dbLogger.info('[LPEngine] 🌙 NIGHT mode started — screening up to 3 pairs...', { source: 'LPEngine' });
    if (this.onNotification) await this.onNotification('🌙 *LP NIGHT mode started* — screening up to 3 pairs...');

    const config = await loadLPConfig();
    const canOpen = await this.canOpenNewPosition();
    if (!canOpen.ok) {
      console.warn(`[LPEngine] ⛔ NIGHT mode blocked: ${canOpen.reason}`);
      await logEvent('WARN', `[LP] NIGHT mode blocked: ${canOpen.reason}`);
      if (this.onNotification) await this.onNotification(`⛔ *NIGHT mode blocked:* ${canOpen.reason}`);
      return;
    }

    // Calculate remaining slots for current mode (DRY_RUN and LIVE are counted separately)
    const tModeConfig = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const currentMode = (tModeConfig?.value ?? 'LIVE') === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';

    const openCount = await prisma.lPPosition.count({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        tradingMode: currentMode
      },
    });
    const slotsLeft = config.maxPositions - openCount;
    if (slotsLeft <= 0) return;

    const candidates = await screenPairs();
    const toOpen: PoolCandidate[] = [];

    const grokModeConfig = await prisma.systemConfig.findUnique({ where: { key: 'grok.mode' } });
    const grokMode = grokModeConfig?.value || 'VETO';

    // Evaluate candidates with Grok until we fill the slots
    for (const candidate of candidates) {
      if (toOpen.length >= Math.min(slotsLeft, 3)) break;

      dbLogger.info(`[LPEngine] 🧠 Asking Grok to analyze sentiment for ${candidate.token.symbol}...`, { source: 'LPEngine' });

      const sentiment = await IntelligenceLayer.analyzeSentiment(candidate.token.symbol, candidate.token.address);
      if (sentiment.label === 'SKIPPED') {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: SKIPPED - ${sentiment.reasoning}`, { source: 'LPEngine' });
        candidate.grokScore = undefined;
        candidate.grokLabel = 'SKIPPED';
      } else if (sentiment.label === 'BEARISH' || (sentiment.score !== null && sentiment.score < config.minGrokScore)) {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`, { source: 'LPEngine' });
        if (grokMode === 'ANNOTATION') {
          dbLogger.info(`[LPEngine] 📝 Grok flagged ${candidate.token.symbol} as BEARISH, but grok.mode is ANNOTATION. Proceeding.`, { source: 'LPEngine' });
          candidate.grokScore = sentiment.score ?? undefined;
          candidate.grokLabel = sentiment.label;
        } else {
          dbLogger.info(`[LPEngine] ❌ Grok REJECTED ${candidate.token.symbol}: Bearish or score < ${config.minGrokScore}`, { source: 'LPEngine' });
          continue;
        }
      } else {
        dbLogger.info(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`, { source: 'LPEngine' });
        dbLogger.info(`[LPEngine] ✅ Grok APPROVED ${candidate.token.symbol}`, { source: 'LPEngine' });
        if (this.onNotification) await this.onNotification(`✅ *Grok APPROVED $${candidate.token.symbol}*\nScore: ${sentiment.score}\n_Wait for V3 pool..._`);
        candidate.grokScore = sentiment.score ?? undefined;
        candidate.grokLabel = sentiment.label;
      }

      toOpen.push(candidate);
    }

    for (const candidate of toOpen) {
      const addrs = await this.getAddresses();
      let qSymbol = 'UNKNOWN';
      if (candidate.token.quoteToken?.toLowerCase() === addrs.wethAddress.toLowerCase()) qSymbol = 'WETH';
      if (candidate.token.quoteToken?.toLowerCase() === addrs.usdgAddress?.toLowerCase()) qSymbol = 'USDG';

      await prisma.watchlist.upsert({
        where: { tokenAddress: candidate.token.address.toLowerCase() },
        update: {
          symbol: candidate.token.symbol,
          name: candidate.token.name,
          quoteAddress: candidate.token.quoteToken,
          quoteSymbol: qSymbol,
          poolAddress: candidate.pool.address.toLowerCase(),
          sentimentStatus: candidate.grokLabel,
          tradingMode: currentMode,
          status: 'WATCHING',
        },
        create: {
          tokenAddress: candidate.token.address.toLowerCase(),
          symbol: candidate.token.symbol,
          name: candidate.token.name,
          quoteAddress: candidate.token.quoteToken,
          quoteSymbol: qSymbol,
          poolAddress: candidate.pool.address.toLowerCase(),
          sentimentStatus: candidate.grokLabel,
          tradingMode: currentMode,
        }
      });
      dbLogger.info(`[LPEngine] 📋 Added $${candidate.token.symbol} to Watchlist (NIGHT)`, { source: 'LPEngine' });
      if (this.onNotification) await this.onNotification(`📋 *Added to Watchlist:* $${candidate.token.symbol}\n_Awaiting Supertrend/ATH breakout_`);
    }
  }

  // ─── Direct Alpha Signal Processing ──────────────────────────────────────────

  /** Called by Userbot when a signal passes Grok sentiment verification */
  async processAlphaSignal(token: GMGNToken, sentimentScore: number): Promise<void> {
    const config = await loadLPConfig();
    const canOpen = await this.canOpenNewPosition();
    if (!canOpen.ok) {
      console.warn(`[LPEngine] ⛔ Alpha Signal blocked: ${canOpen.reason}`);
      await logEvent('WARN', `[LP] Alpha Signal blocked: ${canOpen.reason}`);
      if (this.onNotification) await this.onNotification(`⛔ *Alpha Signal blocked:* ${canOpen.reason}`);
      return;
    }

    const tModeConfig = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const isDryRun = (tModeConfig?.value ?? 'LIVE') === 'DRY_RUN';
    const currentMode = isDryRun ? 'DRY_RUN' : 'LIVE';

    const addrs = await this.getAddresses();
    let qSymbol = 'UNKNOWN';
    if (token.quoteToken?.toLowerCase() === addrs.wethAddress.toLowerCase()) qSymbol = 'WETH';
    if (token.quoteToken?.toLowerCase() === addrs.usdgAddress?.toLowerCase()) qSymbol = 'USDG';

    await prisma.watchlist.upsert({
      where: { tokenAddress: token.address.toLowerCase() },
      update: {
        symbol: token.symbol,
        name: token.name,
        quoteAddress: token.quoteToken,
        quoteSymbol: qSymbol,
        tradingMode: currentMode,
        status: 'WATCHING',
      },
      create: {
        tokenAddress: token.address.toLowerCase(),
        symbol: token.symbol,
        name: token.name,
        quoteAddress: token.quoteToken,
        quoteSymbol: qSymbol,
        poolAddress: '', // Pool will be discovered later if missing
        tradingMode: currentMode,
      }
    });

    dbLogger.info(`[LPEngine] 📋 Added $${token.symbol} from Alpha Signal to Watchlist`, { source: 'LPEngine' });
    if (this.onNotification) await this.onNotification(`📋 *Alpha Signal Added to Watchlist:* $${token.symbol}\n_Awaiting Supertrend/ATH breakout_`);
  }

  // ─── Core: Propose Open Position ────────────────────────────────────────────

  public async proposeOpenPosition(
    candidate: { token: GMGNToken; score: number; grokScore?: number; grokLabel?: string; sentimentStatus?: string },
    options: { dayMode: boolean; nightMode: boolean; nightRange?: number; strategyMode?: boolean; lowerPct?: number; upperPct?: number; source?: string; agentId?: string; wallet?: string }
  ): Promise<void> {
    const config = await loadLPConfig();
    const token = candidate.token;
    const modeCfg = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const isDryRun = (modeCfg?.value || 'LIVE') === 'DRY_RUN';
    const { wethAddress } = await this.getAddresses();

    dbLogger.info(`[LPEngine] 📋 Proposing position: ${token.symbol} | dayMode=${options.dayMode} | dryRun=${isDryRun}`, { source: 'LPEngine', wallet: options.wallet, agentId: options.agentId });
    await logEvent('INFO', `[LP] Proposing position: ${token.symbol} | dayMode=${options.dayMode} | dryRun=${isDryRun}`);

    const currentTradingMode = isDryRun ? 'DRY_RUN' : 'LIVE';

    // Enforce No Duplicate Token (per trading mode)
    const existingTokenPosition = await prisma.lPPosition.findFirst({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        tradingMode: currentTradingMode,
        OR: [
          { token0: { equals: token.address, mode: 'insensitive' } },
          { token1: { equals: token.address, mode: 'insensitive' } }
        ]
      }
    });

    if (existingTokenPosition) {
      const msg = `⚠️ Skipped duplicate LP position for $${token.symbol} (already open/pending in ${currentTradingMode}).`;
      console.warn(`[LPEngine] ${msg}`);
      await logEvent('WARN', `[LP] Skipped duplicate position for ${token.symbol} in ${currentTradingMode}`);
      if (this.onNotification) await this.onNotification(msg);
      return;
    }

    // Resolve pool address via factory
    const resolved = await this.resolvePool(token.address);
    if (!resolved) {
      console.warn(`[LPEngine] No active pool found for ${token.symbol}`);
      await logEvent('WARN', `[LP] No pool found for ${token.symbol}`);
      if (this.onNotification) await this.onNotification(`⚠️ *Open Position Canceled*\nActive pool for $${token.symbol} not found.`);
      return;
    }
    const { poolAddress, feeTier, managerAddress, version, quoteAddress } = resolved;
    const npmAddress = managerAddress as `0x${string}`;

    // Get token meta
    const [tokenMeta, quoteMeta] = await Promise.all([
      this.getTokenMeta(token.address),
      this.getTokenMeta(quoteAddress),
    ]);

    // Ensure token0 < token1 (Uniswap V3 requirement)
    const isToken0 = BigInt(token.address) < BigInt(quoteAddress);
    const t0 = isToken0 ? token.address : quoteAddress;
    const t1 = isToken0 ? quoteAddress : token.address;
    const t0Symbol = isToken0 ? tokenMeta.symbol : quoteMeta.symbol;
    const t1Symbol = isToken0 ? quoteMeta.symbol : tokenMeta.symbol;
    const t0Dec = isToken0 ? tokenMeta.decimals : quoteMeta.decimals;
    const t1Dec = isToken0 ? quoteMeta.decimals : tokenMeta.decimals;

    // Tick range
    let tickLower: number;
    let tickUpper: number;
    const { currentTick: entryTick, sqrtPriceX96 } = await getPoolSlot0(poolAddress);

    if (options.dayMode) {
      const ticks = fullRangeTicks(feeTier);
      tickLower = ticks.tickLower;
      tickUpper = ticks.tickUpper;
    } else if (options.strategyMode) {
      // 91% - 105% of MEME price
      const lowerPct = options.lowerPct ?? 0.91;
      const upperPct = options.upperPct ?? 1.05;

      const tickSpacing = feeToTickSpacing(feeTier);
      const lowerOffset = Math.round(Math.log(lowerPct) / Math.log(1.0001)); // e.g. -943
      const upperOffset = Math.round(Math.log(upperPct) / Math.log(1.0001)); // e.g. +487

      let rawLower, rawUpper;
      if (isToken0) {
        // Meme is Token0. Price = 1.0001^tick.
        rawLower = entryTick + lowerOffset; // lower tick
        rawUpper = entryTick + upperOffset; // upper tick
      } else {
        // Meme is Token1. Price = 1 / 1.0001^tick.
        // Price drops -> Tick goes UP
        rawLower = entryTick - upperOffset; // upper price (1.05x) means lower tick
        rawUpper = entryTick - lowerOffset; // lower price (0.91x) means higher tick
      }

      tickLower = Math.max(MIN_TICK, Math.floor(rawLower / tickSpacing) * tickSpacing);
      tickUpper = Math.min(MAX_TICK, Math.ceil(rawUpper / tickSpacing) * tickSpacing);
    } else {
      // NIGHT mode: get current tick from pool
      const ticks = calcNightTickRange(
        entryTick,
        options.nightRange ?? 2.0,
        feeTier
      );
      tickLower = ticks.tickLower;
      tickUpper = ticks.tickUpper;
    }

    // Addendum §3, §7: Entry Windows & Regime modifiers
    const regimeCfg = await prisma.systemConfig.findUnique({ where: { key: 'lp.portfolio.regime' } });
    const regime = regimeCfg?.value || 'normal';
    const regimeMultCfg = await prisma.systemConfig.findUnique({ where: { key: 'lp.portfolio.crowdedSizeMult' } });
    const regimeMult = parseFloat(regimeMultCfg?.value || '0.6');

    const windowMultCfg = await prisma.systemConfig.findUnique({ where: { key: 'lp.entryWindows.outsideSizeMult' } });
    const windowMult = parseFloat(windowMultCfg?.value || '0.5');

    const now = new Date();
    const jakartaTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const currentMins = jakartaTime.getHours() * 60 + jakartaTime.getMinutes();

    const windows = [
      { start: 9 * 60, end: 10 * 60 + 30 },
      { start: 18 * 60, end: 19 * 60 + 30 },
      { start: 22 * 60, end: 23 * 60 + 30 }
    ];
    const isInsideWindow = windows.some(w => currentMins >= w.start && currentMins <= w.end);

    let baseStartSize = isDryRun ? config.startSizeDryRun : config.startSizeLive;
    let finalStartSize = baseStartSize;
    let sizingLog = [];

    if (regime === 'crowded') {
      finalStartSize *= regimeMult;
      sizingLog.push(`Regime=Crowded (${regimeMult}x)`);
    }

    // Shadow logging window state
    if (!isInsideWindow) {
      sizingLog.push(`Out-of-Window (Would size ${windowMult}x)`);
      // Keeping size untouched for now as per shadow mode rules, only logging.
    } else {
      sizingLog.push(`In-Window`);
    }

    if (sizingLog.length > 0) {
      dbLogger.info(`[LPEngine] ⚖️ Sizing adjustments for $${token.symbol}: ${sizingLog.join(', ')}. Base: $${baseStartSize} -> Final: $${finalStartSize}`, { source: 'LPEngine' });
    }

    // Amount calculation: split startSize 50/50 between token0 and token1
    const currentStartSize = finalStartSize;
    const halfUsd = currentStartSize / 2;
    // Increase precision to 18 decimals to avoid 0 rounding for low-price pools
    const precisionMultiplier = 1000000000000000000n; // 1e18
    const poolPriceRaw = Number((BigInt(sqrtPriceX96) * precisionMultiplier) / (2n ** 96n)) / Number(precisionMultiplier);
    const poolPrice = poolPriceRaw ** 2;
    const decimalAdjustedPoolPrice = poolPrice * (10 ** (t0Dec - t1Dec));

    let token0Price: number, token1Price: number;
    if (isToken0) {
      token0Price = token.priceUsd;
      token1Price = token0Price / decimalAdjustedPoolPrice;
    } else {
      token1Price = token.priceUsd;
      token0Price = token1Price * decimalAdjustedPoolPrice;
    }

    console.log(`[LPEngine Debug] token.priceUsd=${token.priceUsd}, poolPriceRaw=${poolPriceRaw}, decimalAdjustedPoolPrice=${decimalAdjustedPoolPrice}, isToken0=${isToken0}, token0Price=${token0Price}, token1Price=${token1Price}`);

    // Dynamically evaluate Smart Account address
    let recipient = ((process.env.LP_WALLET_ADDRESS || process.env.USER_WALLET_ADDRESS) ?? '') as Address;
    if (!isDryRun) {
      try {
        const { createSmartAccount } = await import('../services/sessionKey.js');
        const dummyClient = await createSmartAccount(process.env.LP_PRIVATE_KEY as `0x${string}`, 3);
        recipient = dummyClient.account.address as Address;
      } catch (e) {
        console.warn(`[LPEngine] Failed to evaluate smart account address:`, e);
      }
    }

    const tier = await getUserTier(recipient);
    const limits = getTierLimits(tier);

    const isQuote0 = t0.toLowerCase() === quoteAddress.toLowerCase();

    let quoteBalance = 0n;
    if (!isDryRun) {
      try {
        quoteBalance = await publicClient.readContract({
          address: quoteAddress as Address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [recipient]
        }) as bigint;
      } catch (e) {
        console.warn(`[LPEngine] Failed to fetch quote token balance: ${e}`);
      }
    }

    let amount0Desired: bigint;
    let amount1Desired: bigint;

    if (!isDryRun) {
      // Tier-based allocation
      let allocationPercent = 10n; // Default Tier 3 (10%)
      if (limits.maxPositions === 1) allocationPercent = 90n; // Tier 1
      else if (limits.maxPositions === 3) allocationPercent = 30n; // Tier 2

      // Calculate the proposed USD allocation based on quote token balance
      const quoteDecimals = isQuote0 ? t0Dec : t1Dec;
      const quotePriceUsd = isQuote0 ? token0Price : token1Price;
      const quoteBalanceUsd = (Number(quoteBalance) / (10 ** quoteDecimals)) * quotePriceUsd;

      let proposedUsdAllocation = quoteBalanceUsd * Number(allocationPercent) / 100;

      // Minimum profitability threshold ($10 USD)
      if (proposedUsdAllocation < 10) {
        proposedUsdAllocation = 10;
      }

      // Check for insufficient balance
      if (quoteBalanceUsd < 10) {
        const msg = `⚠️ Insufficient [WETH/USDG] balance to open position. Minimum required balance is equivalent to $10 USD.`;
        console.warn(`[LPEngine] ${msg} (Current: $${quoteBalanceUsd.toFixed(2)})`);
        await logEvent('WARN', `[LP] Insufficient balance for ${token.symbol}`);
        if (this.onNotification) await this.onNotification(msg);
        return;
      }

      // Apply regime multiplier to the allocation
      if (regime === 'crowded') {
        proposedUsdAllocation *= regimeMult;
      }

      // Calculate half amounts for Token0 and Token1
      const halfUsdAlloc = proposedUsdAllocation / 2;
      amount0Desired = this.usdToTokenAmount(halfUsdAlloc, token0Price, t0Dec);
      amount1Desired = this.usdToTokenAmount(halfUsdAlloc, token1Price, t1Dec);

      dbLogger.info(`[LPEngine] 💰 Dynamic Sizing: Using ${allocationPercent}% of Quote Balance ($${proposedUsdAllocation.toFixed(2)} USD)`, { source: 'LPEngine' });
    } else {
      amount0Desired = this.usdToTokenAmount(halfUsd, token0Price, t0Dec);
      amount1Desired = this.usdToTokenAmount(halfUsd, token1Price, t1Dec);
    }

    // Apply a 10% reduction buffer to the desired amounts for minting.
    // This accommodates the Universal Router swap fee (up to 1%) and price impact.
    // NPM will pull the proportional amounts based on the current pool price,
    // leaving a tiny amount of unused dust in the Smart Account, preventing
    // "ERC20: transfer amount exceeds balance" reverts.
    amount0Desired = amount0Desired * 90n / 100n;
    amount1Desired = amount1Desired * 90n / 100n;

    const sqrtRatioAX96 = tickToSqrtPriceX96(tickLower);
    const sqrtRatioBX96 = tickToSqrtPriceX96(tickUpper);
    const simulatedLiquidity = getLiquidityForAmounts(
      sqrtPriceX96,
      sqrtRatioAX96,
      sqrtRatioBX96,
      amount0Desired,
      amount1Desired
    );

    // Enforce Active Positions Limit per mode
    const modeStr = isDryRun ? 'DRY_RUN' : 'LIVE';
    const activePositionsCount = await prisma.lPPosition.count({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        tradingMode: modeStr
      }
    });

    if (activePositionsCount >= limits.maxPositions) {
      const msg = `*Tier Limit Reached*\nYou are currently on Tier ${tier}. You have reached the maximum allowed active LP positions (${limits.maxPositions}). Please close an existing position or upgrade your $FLETCH holdings.`;
      console.warn(`[LPEngine] ${msg}`);
      await logEvent('WARN', `[LP] Limit Reached: Tier ${tier} cannot open position for ${token.symbol}`);
      if (this.onNotification) await this.onNotification(`⚠️ ${msg}`);
      return;
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 10); // 10 min

    // Apply a 50% buffer reduction to the swapped token amount to account for swap fees and high price impact
    // This prevents "ERC20: transfer amount exceeds balance" when NPM tries to pull the minted tokens
    const adjustedAmount0 = amount0Desired * 50n / 100n;
    const adjustedAmount1 = amount1Desired * 50n / 100n;

    // Calculate adjusted liquidity for the reduced amounts to satisfy V4 exact liquidity requirements
    const adjustedLiquidity = getLiquidityForAmounts(
      sqrtPriceX96,
      sqrtRatioAX96,
      sqrtRatioBX96,
      adjustedAmount0,
      adjustedAmount1
    );

    // Build calldata
    const calldata = this.buildMintCalldata({
      token0: t0 as Address,
      token1: t1 as Address,
      fee: feeTier,
      tickLower,
      tickUpper,
      amount0Desired: adjustedAmount0,
      amount1Desired: adjustedAmount1,
      liquidity: adjustedLiquidity,
      tickSpacing: feeToTickSpacing(feeTier),
      hooks: '0x0000000000000000000000000000000000000000',
      recipient,
      deadline,
    });

    const modeLabel = options.dayMode ? 'DAY' : 'NIGHT';
    const rangeLabel = options.dayMode
      ? 'Full Range'
      : `±${(options.nightRange ?? 2.0).toFixed(1)}x tick concentrated`;

    const description =
      `💧 *LP OPEN Proposal — ${modeLabel} MODE*\n` +
      `Pool: \`${poolAddress.slice(0, 10)}...\`\n` +
      `Pair: ${t0Symbol}/${t1Symbol} (fee: ${feeTier / 10000}%)\n` +
      `Range: ${rangeLabel}\n` +
      `Size: $${isDryRun ? config.startSizeDryRun : config.startSizeLive}\n` +
      `Grok Score: ${candidate.grokScore ?? 'N/A'}/100 (${candidate.grokLabel ?? 'N/A'})\n` +
      `Est APR: ${(candidate.score).toFixed(2)}%\n` +
      `MCap: $${(token.marketCap / 1000).toFixed(0)}K | Vol24h: $${(token.volume24h / 1000).toFixed(0)}K`;

    const defaultModeRecord = await prisma.systemConfig.findUnique({ where: { key: 'lp.defaultMode' } });
    const currentMode = (defaultModeRecord?.value as 'MANUAL' | 'SEMI' | 'FULL') || 'MANUAL';

    let lastFeeGrowth0 = null;
    let lastFeeGrowth1 = null;

    // Always fetch fee growth for ALPS V4 PositionManager so we can simulate/track fees properly
    if (isDryRun || npmAddress.toLowerCase() === '0x58daec3116aae6d93017baaea7749052e8a04fa7') {
      try {
        const { feeGrowthGlobal0, feeGrowthGlobal1 } = await getFeeGrowthGlobal(poolAddress);
        lastFeeGrowth0 = feeGrowthGlobal0.toString();
        lastFeeGrowth1 = feeGrowthGlobal1.toString();
      } catch (e) {
        console.warn(`[LPEngine] Failed to fetch initial feeGrowthGlobal for ${poolAddress}:`, e);
      }
    }

    // Save PENDING record to DB (or OPEN if DRY RUN simulation)
    const dbRecord = await prisma.lPPosition.create({
      data: {
        tokenId: isDryRun ? `SIM-${Date.now()}` : `PENDING-${Date.now()}`,
        pool: poolAddress,
        token0: t0,
        token1: t1,
        managerAddress: npmAddress,
        token0Symbol: t0Symbol,
        token1Symbol: t1Symbol,
        feeTier,
        tickLower,
        tickUpper,
        entryValue: isDryRun ? config.startSizeDryRun : config.startSizeLive,
        entryTick,
        mode: currentMode,
        status: isDryRun ? 'OPEN' : 'PENDING',
        dayMode: options.dayMode,
        nightMode: options.nightMode,
        source: options.source ?? 'SYSTEM',
        tradingMode: isDryRun ? 'DRY_RUN' : 'LIVE',
        sentimentStatus: candidate.sentimentStatus || candidate.grokLabel,
        simulatedLiquidity: simulatedLiquidity ? simulatedLiquidity.toString() : null,
        lastFeeGrowth0,
        lastFeeGrowth1,
      },
    });

    dbLogger.info(`[LPEngine] 📝 LPPosition created in DB: ${dbRecord.id} (PENDING)`, { source: 'LPEngine', wallet: options.wallet });
    await logEvent('INFO', `[LP] OPEN Proposal created for ${t0Symbol}/${t1Symbol}`, { positionId: dbRecord.id, mode: currentMode });

    const proposal: LPProposal = {
      type: 'OPEN',
      positionId: dbRecord.id,
      pool: poolAddress,
      token0: t0,
      token1: t1,
      token0Symbol: t0Symbol,
      token1Symbol: t1Symbol,
      feeTier,
      tickLower,
      tickUpper,
      entryValueUsd: isDryRun ? config.startSizeDryRun : config.startSizeLive,
      calldata,
      to: npmAddress,
      dayMode: options.dayMode,
      nightMode: options.nightMode,
      mode: 'MANUAL',
      description,
    };

    if (currentMode === 'FULL') {
      if (isDryRun) {
        proposal.description = `✅ *Auto-Opened LP (Simulated)*\n` + proposal.description;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      }
      dbLogger.info(`[LPEngine] Mode FULL — Executing automatically via Alchemy Session Key`, { source: 'LPEngine', wallet: options.wallet });
      try {
        const tier = await getUserTier(recipient);
        // selfFunded=true: creates client without Alchemy paymaster middleware.
        // LP UserOps are self-funded from SA's ETH to avoid paymaster policy restrictions.
        const client = await getSessionKeyClient('FULL', tier, true);

        // Ensure smart account has enough ETH for gas
        await ensureSmartAccountFunded(client.account.address);
        const dexConfig = await getDexConfig(version as 'V3' | 'V4');
        const routerAddress = (dexConfig.routerAddress || process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS || '') as Address;

        // Slippage / Swap setup
        const isQuote0 = t0.toLowerCase() === quoteAddress.toLowerCase();
        const quoteAddressHex = quoteAddress as Address;
        const memeTokenAddress = (isQuote0 ? t1 : t0) as Address;
        // We multiply the swap amount by 2.0 (200% buffer) because the desired amounts were previously reduced by 10%.
        // Swapping significantly more Quote token guarantees we receive enough Meme token to satisfy the exact proportional LP mint requirements,
        // leaving any excess Meme token as dust in the Smart Account, preventing TRANSFER_FROM_FAILED reverts during NPM minting
        // where the price shift requires more Meme tokens than expected.
        const quoteAmountToSwap = (isQuote0 ? amount0Desired : amount1Desired) * 200n / 100n;
        console.log(`[LPEngine Debug] quoteAmountToSwap=${quoteAmountToSwap}, amount0=${amount0Desired}, amount1=${amount1Desired}, isQuote0=${isQuote0}`);

        const isUniversalRouter = version === 'V3';
        const isAlpsRouter = version === 'V4';
        // ALWAYS use ALPS Router for swapping! It has deep liquidity across all tokens and doesn't throw SliceOutOfBounds.
        const actualRouterAddress = '0xcaf681a66d020601342297493863e78c959e5cb2' as Address;
        let swapCalldata: Hex;

        let preSwapCalls: UserOpCall[] = [];
        const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
        const permit2Abi = parseAbi([
          'function approve(address token, address spender, uint160 amount, uint48 expiration)'
        ]);

        if (actualRouterAddress.toLowerCase() === '0x8876789976decbfcbbbe364623c63652db8c0904') {
          // ExactInputSingleParams ABI for Universal Router
          const commands = '0x00' as `0x${string}`; // V3_SWAP_EXACT_IN
          const feeHex = feeTier.toString(16).padStart(6, '0');
          const path = (quoteAddress + feeHex + memeTokenAddress.replace('0x', '')) as `0x${string}`;

          const exactInputSingleParamsAbi = [
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'bytes' },
            { type: 'bool' }
          ];

          const expectedMemeOut = isQuote0 ? amount1Desired : amount0Desired;
          const amountOutMin = expectedMemeOut * 90n / 100n; // 10% max slippage

          const swapInput = encodeAbiParameters(exactInputSingleParamsAbi, [
            recipient, // recipient
            quoteAmountToSwap,
            amountOutMin, // 10% slippage protection
            path,
            true // payerIsUser = true (requires Permit2)
          ]);

          const universalRouterAbi = parseAbi([
            'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable'
          ]);

          const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

          swapCalldata = encodeFunctionData({
            abi: universalRouterAbi,
            functionName: 'execute',
            args: [commands, [swapInput], deadline]
          });

          preSwapCalls = [
            { target: quoteAddressHex, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2_ADDRESS, MAX_UINT128] }) },
            { target: PERMIT2_ADDRESS, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [quoteAddressHex, actualRouterAddress, BigInt(MAX_UINT128), 4000000000] }) }
          ];
        } else {
          // Standard SwapRouter02 (ALPS)
          const swapRouterAbi = parseAbi([
            'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
            'function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)'
          ]);

          const expectedMemeOut = isQuote0 ? amount1Desired : amount0Desired;
          const amountOutMin = expectedMemeOut * 90n / 100n; // 10% max slippage

          swapCalldata = encodeFunctionData({
            abi: swapRouterAbi,
            functionName: 'exactInputSingle',
            args: [{
              tokenIn: quoteAddress as Address,
              tokenOut: memeTokenAddress as Address,
              fee: feeTier,
              recipient: recipient,
              amountIn: quoteAmountToSwap,
              amountOutMinimum: amountOutMin, // 10% slippage protection
              sqrtPriceLimitX96: 0n
            }]
          });

          // ALPS Router uses direct ERC20 approval, not Permit2
          preSwapCalls = [
            { target: quoteAddressHex, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [actualRouterAddress, MAX_UINT128] }) }
          ];
        }

        console.log(`[LPEngine Debug] Using Router Address: ${actualRouterAddress}`);

        // Single atomic batch: approve → swap → approve Permit2 & NPM × 2 → mint
        // State changes from step 1 (approve) are visible to step 2 (swap) in the same UserOp.
        const calls: UserOpCall[] = [
          ...preSwapCalls,
          // Swap Quote Token → Meme Token
          { target: actualRouterAddress, data: swapCalldata },

          // Approve Permit2 via ERC20 to pull Quote and Meme tokens
          { target: quoteAddressHex, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2_ADDRESS, MAX_UINT128] }) },
          { target: memeTokenAddress, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2_ADDRESS, MAX_UINT128] }) },

          // Approve NPM via Permit2 to pull Quote and Meme tokens
          { target: PERMIT2_ADDRESS, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [quoteAddressHex, npmAddress, BigInt(MAX_UINT128), 4000000000] }) },
          { target: PERMIT2_ADDRESS, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [memeTokenAddress, npmAddress, BigInt(MAX_UINT128), 4000000000] }) },

          // Mint LP Position
          { target: npmAddress, data: calldata }
        ];

        const txHash = await buildAndSendLPUserOperation(client, calls);

        // Save txHash immediately to prevent zombie states if process restarts during wait
        await prisma.lPPosition.update({
          where: { id: dbRecord.id },
          data: { txHash }
        });

        dbLogger.info(`[LPEngine] 📜 Waiting for receipt to extract TokenID...`, { source: 'LPEngine', wallet: options.wallet });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });

        let realTokenId = dbRecord.tokenId; // Fallback to PENDING-...
        try {
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({
                abi: NPM_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName === 'IncreaseLiquidity' || decoded.eventName === 'Transfer') {
                realTokenId = (decoded.args as any).tokenId.toString();
                dbLogger.info(`[LPEngine] 🎯 Successfully extracted Real TokenID: ${realTokenId} from ${decoded.eventName}`, { source: 'LPEngine', wallet: options.wallet });
                break;
              }
            } catch (e) {
              // Ignore logs that don't match our ABI
            }
          }
        } catch (err) {
          console.warn(`[LPEngine] Could not decode logs for TokenID extraction`);
        }

        await prisma.lPPosition.update({
          where: { id: dbRecord.id },
          data: { status: 'OPEN', tokenId: realTokenId, txHash }
        });

        proposal.description = `✅ *Auto-Opened LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
        await logEvent('INFO', `[LP] Position Auto-Opened via Session Key`, { positionId: dbRecord.id, txHash });
        if (this.onProposal) await this.onProposal(proposal); // Acts as notification
        return;
      } catch (e: any) {
        let errorMsg = e.message;
        console.log("[LPEngine Detailed Error]:", e.message);
        if (process.env.ALCHEMY_API_KEY) {
          errorMsg = errorMsg.replace(new RegExp(process.env.ALCHEMY_API_KEY, 'g'), '[REDACTED_ALCHEMY_KEY]');
        }
        await logEvent('ERROR', `[LP] Auto-Open Failed`, { error: errorMsg });
        dbLogger.error(`[LPEngine] Failed to auto-open position: ${errorMsg}`, { source: 'LPEngine', wallet: options.wallet });

        await prisma.lPPosition.update({
          where: { id: dbRecord.id },
          data: { status: 'FAILED' }
        });

        proposal.description = `❌ *Auto-Open Failed*\n` + proposal.description + `\nError: ${e.message}`;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      }
    }

    if (this.onProposal) {
      await this.onProposal(proposal);
      
      // Multi-Agent Expansion: Also emit proposal for all active User Agents
      try {
        const activeAgents = await prisma.agent.findMany({ where: { status: 'ACTIVE' } });
        for (const agent of activeAgents) {
          const userProposal = { ...proposal, agentId: agent.id };
          await this.onProposal(userProposal);
        }
      } catch (err) {
        console.error('[LPEngine] Failed to emit proposals for User Agents:', err);
      }
    } else {
      console.warn('[LPEngine] onProposal callback not set — proposal dropped');
    }
  }

  // ─── Close Position ─────────────────────────────────────────────────────────

  /**
   * Build proposal to close LP position (decrease 100% -> collect -> burn).
   * Called by Guardian (LPCloseSignal) or user via /lp close <id>.
   */
  async proposeClosePosition(positionId: string, reason: string): Promise<void> {
    const pos = await prisma.lPPosition.findUnique({ where: { id: positionId }, include: { user: true } });
    const userWallet = pos?.user?.walletAddress;
    if (!pos || pos.status !== 'OPEN') {
      console.warn(`[LPEngine] proposeClosePosition: position ${positionId} not found or not OPEN`);
      await logEvent('WARN', `[LP] proposeClosePosition: position ${positionId} not found or not OPEN`);
      return;
    }
    const { npmAddress: defaultNpm } = await this.getAddresses();
    const npmAddress = (pos.managerAddress as `0x${string}`) || defaultNpm;

    const isSim = pos.tokenId.startsWith('SIM-') || pos.tradingMode === 'DRY_RUN';
    const tokenId = isSim ? 0n : BigInt(pos.tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 10);
    const recipient = ((process.env.LP_WALLET_ADDRESS || process.env.USER_WALLET_ADDRESS) ?? '') as Address;

    // Read current liquidity from NPM (skip if simulated)
    // V4 uses getPositionLiquidity instead of positions()
    let liquidity = 0n;
    if (!isSim) {
      try {
        liquidity = await publicClient.readContract({
          address: npmAddress,
          abi: parseAbi(['function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity)']),
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        }) as bigint;
        dbLogger.info(`[LPEngine] Position liquidity: ${liquidity}`, { source: 'LPEngine', wallet: userWallet });
      } catch (e: any) {
        dbLogger.error(`[LPEngine] getPositionLiquidity() failed: ${e.message}`, { source: 'LPEngine', wallet: userWallet });
      }
    } else {
      liquidity = pos.simulatedLiquidity ? BigInt(pos.simulatedLiquidity) : 0n;
    }

    // Build V4 BURN_POSITION calldata (atomically closes position + sweeps tokens)
    const closeCalldata = this.buildDecreaseLiquidityCalldata(tokenId, liquidity, deadline, pos.token0 as Address, pos.token1 as Address, recipient);

    const description =
      `🔴 *LP CLOSE Proposal*\n` +
      `Position: \`${pos.id.slice(0, 8)}\`\n` +
      `Pair: ${pos.token0Symbol}/${pos.token1Symbol}\n` +
      `Reason: ${reason}\n` +
      `Fee collected: $${pos.feesCollected.toFixed(2)} | IL: $${pos.ilRunning.toFixed(2)}`;

    // Update status to EXITING
    await prisma.lPPosition.update({
      where: { id: positionId },
      data: { status: 'EXITING' } as any,
    });

    await logEvent('INFO', `[LP] CLOSE Proposal created for ${pos.token0Symbol}/${pos.token1Symbol}`, { positionId, reason });

    const proposal: LPProposal = {
      type: 'CLOSE',
      positionId,
      pool: pos.pool,
      token0: pos.token0,
      token1: pos.token1,
      token0Symbol: pos.token0Symbol ?? '',
      token1Symbol: pos.token1Symbol ?? '',
      feeTier: pos.feeTier,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      entryValueUsd: pos.entryValue,
      calldata: closeCalldata,
      to: npmAddress,
      dayMode: pos.dayMode,
      nightMode: pos.nightMode,
      mode: pos.mode as 'MANUAL' | 'SEMI' | 'FULL',
      description,
    };

    if (pos.mode === 'FULL') {
      if (pos.tradingMode === 'DRY_RUN') {
        await prisma.lPPosition.update({
          where: { id: positionId },
          data: { status: 'CLOSED' } as any,
        });
        proposal.description = `✅ *Auto-Closed LP (Simulated)*\n` + proposal.description;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      }
      dbLogger.info(`[LPEngine] Mode FULL — Auto-closing position via Alchemy Session Key`, { source: 'LPEngine', wallet: userWallet });
      try {
        const tier = await getUserTier(recipient);
        const client = await getSessionKeyClient('FULL', tier);
        // Single atomic V4 call: BURN_POSITION + TAKE_PAIR
        const calls: UserOpCall[] = [
          { target: npmAddress, data: closeCalldata },
        ];

        const txHash = await buildAndSendLPUserOperation(client, calls);

        await prisma.lPPosition.update({
          where: { id: positionId },
          data: { status: 'CLOSED', exitTxHash: txHash } as any,
        });

        await logEvent('INFO', `[LP] Position Closed (Confirmed)`, { positionId });

        proposal.description = `✅ *Auto-Closed LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      } catch (e: any) {
        let errorMsg = e.message;
        if (errorMsg && errorMsg.length > 200) {
          errorMsg = errorMsg.substring(0, 200) + '...';
        }
        if (process.env.ALCHEMY_API_KEY) {
          errorMsg = errorMsg.replace(new RegExp(process.env.ALCHEMY_API_KEY, 'g'), '[REDACTED]');
        }
        // Strip Markdown special chars to avoid Telegram parse errors
        errorMsg = errorMsg.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ');

        // Revert status back to OPEN so it stays in Active LP and can be retried
        await prisma.lPPosition.update({
          where: { id: positionId },
          data: { status: 'OPEN' } as any,
        });

        await logEvent('ERROR', `[LP] Auto-Close Failed (Reverted to OPEN)`, { error: e.message });
        dbLogger.error(`[LPEngine] Failed to auto-close position: ${e.message}`, { source: 'LPEngine', wallet: userWallet });
        proposal.description = `❌ Auto-Close Failed\nPair: ${pos.token0Symbol}/${pos.token1Symbol}\nStatus: Reverted to OPEN\nError: ${errorMsg}`;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      }
    }

    if (this.onProposal) await this.onProposal(proposal);
  }

  // ─── Harvest / Collect Fees ─────────────────────────────────────────────────

  /**
   * Collect fee from all OPEN eligible positions.
   * Called via /harvest command or Guardian LPCompoundSignal.
   */
  async proposeHarvest(positionId?: string): Promise<void> {
    const where = positionId
      ? { id: positionId, status: 'OPEN' }
      : { status: 'OPEN' };

    const positions = await prisma.lPPosition.findMany({ where, include: { user: true } });
    const recipient = ((process.env.LP_WALLET_ADDRESS || process.env.USER_WALLET_ADDRESS) ?? '') as Address;
    const tier = await getUserTier(recipient);
    const { npmAddress: defaultNpm } = await this.getAddresses();

    for (const pos of positions) {
      if (pos.tokenId.startsWith('PENDING')) continue;
      const userWallet = (pos as any).user?.walletAddress;
      const isSim = pos.tokenId.startsWith('SIM-') || pos.tradingMode === 'DRY_RUN';

      const tokenId = isSim ? 0n : BigInt(pos.tokenId);
      const recipient = ((process.env.LP_WALLET_ADDRESS || process.env.USER_WALLET_ADDRESS) ?? '') as Address;
      const npmAddress = (pos.managerAddress as `0x${string}`) || (await this.getAddresses()).npmAddress;

      const harvestDeadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 10);
      const calldata = isSim ? '0x' : this.buildCollectCalldata(tokenId, recipient, pos.token0 as Address, pos.token1 as Address, harvestDeadline);

      const proposal: LPProposal = {
        type: 'HARVEST',
        positionId: pos.id,
        pool: pos.pool,
        token0: pos.token0,
        token1: pos.token1,
        token0Symbol: pos.token0Symbol ?? '',
        token1Symbol: pos.token1Symbol ?? '',
        feeTier: pos.feeTier,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        entryValueUsd: pos.entryValue,
        calldata,
        to: npmAddress,
        dayMode: pos.dayMode,
        nightMode: pos.nightMode,
        mode: pos.mode as 'MANUAL' | 'SEMI' | 'FULL',
        description:
          `🌾 *LP HARVEST Proposal*\n` +
          `Position: \`${pos.id.slice(0, 8)}\`\n` +
          `Pair: ${pos.token0Symbol}/${pos.token1Symbol}\n` +
          `Collecting all accrued fees`,
      };

      await logEvent('INFO', `[LP] HARVEST Proposal created for ${pos.token0Symbol}/${pos.token1Symbol}`, { positionId: pos.id });

      if (pos.mode === 'SEMI' || pos.mode === 'FULL') {
        if (pos.tradingMode === 'DRY_RUN') {
          proposal.description = `✅ *Auto-Harvested LP (Simulated)*\n` + proposal.description;
          await prisma.lPPosition.update({
            where: { id: pos.id },
            data: { harvestedFees: { increment: pos.feesCollected } }
          });
          if (this.onProposal) await this.onProposal(proposal);
          continue;
        }
        dbLogger.info(`[LPEngine] Mode ${pos.mode} — Auto-harvesting via Alchemy Session Key`, { source: 'LPEngine', wallet: userWallet });
        try {
          const client = await getSessionKeyClient(pos.mode as 'SEMI' | 'FULL', tier);
          const calls: UserOpCall[] = [
            { target: npmAddress, data: calldata }
          ];

          const txHash = await buildAndSendLPUserOperation(client, calls);
          await logEvent('INFO', `[LP] Position Auto-Harvested via Session Key`, { positionId: pos.id, txHash });

          await prisma.lPPosition.update({
            where: { id: pos.id },
            data: { harvestedFees: { increment: pos.feesCollected } }
          });

          proposal.description = `✅ *Auto-Harvested LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
          if (this.onProposal) await this.onProposal(proposal);
          continue; // Move to next position
        } catch (e: any) {
          let errorMsg = e.message;
          if (errorMsg && errorMsg.length > 500) {
            errorMsg = errorMsg.substring(0, 500) + '... [TRUNCATED]';
          }
          if (process.env.ALCHEMY_API_KEY) {
            errorMsg = errorMsg.replace(new RegExp(process.env.ALCHEMY_API_KEY, 'g'), '[REDACTED_ALCHEMY_KEY]');
          }
          await logEvent('ERROR', `[LP] Auto-Harvest Failed`, { error: errorMsg });
          dbLogger.error(`[LPEngine] Failed to auto-harvest position: ${errorMsg}`, { source: 'LPEngine', wallet: userWallet });
          proposal.description = `❌ *Auto-Harvest Failed*\n` + proposal.description + `\nError: ${errorMsg}`;
          if (this.onProposal) await this.onProposal(proposal);
          continue;
        }
      }

      if (this.onProposal) await this.onProposal(proposal);
    }
  }

  // ─── After Approval: Update DB ──────────────────────────────────────────────

  /**
   * Called by bot after user approve + tx confirmed.
   * Parse tokenId from receipt event and update DB.
   */
  async onOpenConfirmed(positionId: string, realTokenId: string, txHash?: string): Promise<void> {
    await prisma.lPPosition.update({
      where: { id: positionId },
      data: { status: 'OPEN', tokenId: realTokenId, txHash } as any,
    });
    await logEvent('INFO', `[LP] Position Opened (Confirmed) - TokenID: ${realTokenId}`, { positionId, txHash });
    dbLogger.info(`[LPEngine] ✅ Position ${positionId} confirmed — tokenId: ${realTokenId}`, { source: 'LPEngine' }); // We could fetch wallet here, but omitting for now or fetching it
  }

  async onCloseConfirmed(positionId: string, feesCollectedUsd: number, txHash?: string): Promise<void> {
    await prisma.lPPosition.update({
      where: { id: positionId },
      data: {
        status: 'CLOSED',
        exitTxHash: txHash,
        feesCollected: { increment: feesCollectedUsd },
      },
    });
    dbLogger.info(`[LPEngine] ✅ Position ${positionId} closed — fees: $${feesCollectedUsd}`, { source: 'LPEngine' }); // Same here
  }

  // ─── Status Summary ─────────────────────────────────────────────────────────

  /** Generate status summary for /lp status command */
  async getStatusSummary(): Promise<string> {
    const positions = await prisma.lPPosition.findMany({
      where: { status: { in: ['OPEN', 'PENDING', 'OUT_OF_RANGE'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (positions.length === 0) {
      return '📭 *No active LP positions.*\n\nUse /lp scan to see available pairs.';
    }

    let msg = `💧 *Active LP Positions (${positions.length})*\n\n`;

    for (const pos of positions) {
      const statusEmoji = pos.status === 'OPEN'
        ? '🟢' : pos.status === 'PENDING'
          ? '🟡' : '🟠';

      const modeEmoji = pos.dayMode ? '☀️' : pos.nightMode ? '🌙' : '⚙️';

      msg +=
        `${statusEmoji} ${modeEmoji} *${pos.token0Symbol ?? '?'}/${pos.token1Symbol ?? '?'}*\n` +
        `  ID: \`${pos.id.slice(0, 8)}\`\n` +
        `  Fee: $${pos.feesCollected.toFixed(2)} | IL: $${pos.ilRunning.toFixed(2)}\n` +
        `  Mode: ${pos.mode} | Status: ${pos.status}\n` +
        `  IL>fee hours: ${pos.ilAboveFeeHours}h\n\n`;
    }

    return msg.trim();
  }
}
