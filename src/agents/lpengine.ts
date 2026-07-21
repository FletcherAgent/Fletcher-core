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

import { encodeFunctionData, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { PrismaClient } from '@prisma/client';
import { publicClient } from '../services/viem.js';
import { getSessionKeyClient, buildAndSendLPUserOperation, type UserOpCall } from '../services/sessionKey.js';
import { getUserTier, getTierLimits } from '../services/tierGate.js';
import { prisma } from '../core/db.js';
import { logEvent } from '../utils/logger.js';
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
  calcNightTickRange,
  getPoolSlot0,
  feeToTickSpacing,
  MIN_TICK,
  MAX_TICK,
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
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);

const MAX_UINT128 = 340282366920938463463374607431768211455n;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LPProposal {
  type:        'OPEN' | 'CLOSE' | 'COMPOUND' | 'REBALANCE' | 'HARVEST';
  positionId?: string;   // LPPosition.id (if existing)
  pool:        string;
  token0:      string;
  token1:      string;
  token0Symbol: string;
  token1Symbol: string;
  feeTier:     number;
  tickLower:   number;
  tickUpper:   number;
  entryValueUsd: number;
  calldata:    Hex;      // encoded tx data for NPM
  to:          Address;  // NPM address
  dayMode:     boolean;
  nightMode:   boolean;
  mode:        'MANUAL' | 'SEMI' | 'FULL';
  description: string;   // human-readable for Telegram
}

// ─── MetaConfig loader ────────────────────────────────────────────────────────

interface LPConfig {
  maxPositions: number;
  positionCap:  number;
  startSize:    number;
  nightRange:   number;
  dayCloseTime: string;
  ilHourThreshold: number;
}

async function loadLPConfig(): Promise<LPConfig> {
  const keys = [
    'lp.maxPositions', 'lp.positionCap', 'lp.startSize',
    'lp.nightRange', 'lp.dayCloseTime', 'lp.ilHourThreshold',
  ];
  const configs = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(configs.map(c => [c.key, c.value]));

  return {
    maxPositions:     parseInt(map['lp.maxPositions']    ?? '3'),
    positionCap:      parseFloat(map['lp.positionCap']   ?? '2000'),
    startSize:        parseFloat(map['lp.startSize']     ?? '500'),
    nightRange:       parseFloat(map['lp.nightRange']    ?? '0.25'),
    dayCloseTime:     map['lp.dayCloseTime'] ?? '23:00',
    ilHourThreshold:  parseInt(map['lp.ilHourThreshold'] ?? '4'),
  };
}

// ─── LP Engine Agent ──────────────────────────────────────────────────────────

export class LPEngineAgent {

  /** Callback -> Orchestrator: send proposal to approval flow */
  public onProposal?: (proposal: LPProposal) => Promise<void>;
  public onNotification?: (message: string) => Promise<void>;

  constructor() {}

  private async getAddresses() {
    const dexConfig = await getDexConfig('V3');
    const npmAddress = (dexConfig.positionManager || '') as Address;
    const factoryAddress = (dexConfig.factoryAddress || '') as Address;
    const wethAddress = (process.env.WETH_ADDRESS || '') as Address;

    if (!npmAddress)     console.warn('[LPEngine] ⚠️ POSITION_MANAGER not set');
    if (!factoryAddress) console.warn('[LPEngine] ⚠️ UNISWAP_V3_FACTORY_ADDRESS not set');
    if (!wethAddress)    console.warn('[LPEngine] ⚠️ WETH_ADDRESS not set');

    return { npmAddress, factoryAddress, wethAddress };
  }

  // ─── Position Cap Check ─────────────────────────────────────────────────────

  /** Check if new position can be opened (max positions from metaConfig) */
  private async canOpenNewPosition(): Promise<{ ok: boolean; reason?: string }> {
    const config = await loadLPConfig();
    const openCount = await prisma.lPPosition.count({
      where: { status: { in: ['OPEN', 'PENDING'] } },
    });
    if (openCount >= config.maxPositions) {
      return { ok: false, reason: `Already at max ${config.maxPositions} positions (${openCount} open)` };
    }
    return { ok: true };
  }

  // ─── Pool Resolution ────────────────────────────────────────────────────────

  /**
   * Resolve pool address from Uniswap V3 Factory.
   * Try fee tiers: 500 -> 3000 -> 10000, use the first available.
   */
  private async resolvePool(
    token0: string,
    token1: string,
    preferredFee = 3000
  ): Promise<{ poolAddress: string; feeTier: number; factoryAddress: string; managerAddress: string } | null> {
    const v3Configs = await getAllDexConfigs('V3');
    const feesToTry = [preferredFee, 500, 3000, 10000].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );

    for (const config of v3Configs) {
      if (!config.factoryAddress || !config.positionManager) continue;

      for (const fee of feesToTry) {
        try {
          const poolAddr = await publicClient.readContract({
            address: config.factoryAddress as Address,
            abi: FACTORY_ABI,
            functionName: 'getPool',
            args: [token0 as Address, token1 as Address, fee],
          }) as string;

          if (poolAddr && poolAddr !== '0x0000000000000000000000000000000000000000') {
            console.log(`[LPEngine] ✅ Pool found: ${poolAddr} on factory ${config.factoryAddress} (fee: ${fee})`);
            return { 
              poolAddress: poolAddr, 
              feeTier: fee, 
              factoryAddress: config.factoryAddress, 
              managerAddress: config.positionManager 
            };
          }
        } catch (error) {
          console.warn(`[LPEngine] ⚠️ getPool failed on factory ${config.factoryAddress} (fee: ${fee}):`, error);
        }
      }
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
    token0: Address; token1: Address; fee: number;
    tickLower: number; tickUpper: number;
    amount0Desired: bigint; amount1Desired: bigint;
    recipient: Address; deadline: bigint;
  }): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'mint',
      args: [{
        token0: params.token0,
        token1: params.token1,
        fee: params.fee,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min: 0n, // slippage handled via approval timing
        amount1Min: 0n,
        recipient: params.recipient,
        deadline: params.deadline,
      }],
    });
  }

  buildCollectCalldata(tokenId: bigint, recipient: Address): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'collect',
      args: [{
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    });
  }

  buildDecreaseLiquidityCalldata(
    tokenId: bigint,
    liquidity: bigint,
    deadline: bigint
  ): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }],
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
    console.log('[LPEngine] ☀️ DAY mode started...');
    if (this.onNotification) await this.onNotification('☀️ *LP DAY mode started* — screening pairs...');

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
    
    // Evaluate candidates with Grok
    for (const candidate of candidates) {
      console.log(`[LPEngine] 🧠 Asking Grok to analyze sentiment for ${candidate.token.symbol}...`);
      
      const sentiment = await IntelligenceLayer.analyzeSentiment(candidate.token.symbol, candidate.token.address);
      console.log(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`);
      
      if (sentiment.label === 'BEARISH' || sentiment.score < 50) {
        console.log(`[LPEngine] ❌ Grok REJECTED ${candidate.token.symbol}: Bearish or score < 50`);
        continue;
      }
      
      console.log(`[LPEngine] ✅ Grok APPROVED ${candidate.token.symbol}`);
      if (this.onNotification) await this.onNotification(`✅ *Grok APPROVED $${candidate.token.symbol}*\nScore: ${sentiment.score}\n_Wait for V3 pool..._`);
      
      selectedCandidate = candidate;
      break; // Found the top candidate that passed Grok
    }

    if (!selectedCandidate) {
      console.warn('[LPEngine] DAY mode: No pairs passed Grok sentiment analysis');
      await logEvent('WARN', '[LP] DAY mode: No pairs passed Grok sentiment analysis');
      return;
    }

    await this.proposeOpenPosition(selectedCandidate, { dayMode: true, nightMode: false });
  }

  // ─── MODE NIGHT: Concentrated Spray ────────────────────────────────────────

  /**
   * Spray ≤3 pair lolos screening dengan concentrated range ±nightRange%.
   * Deploy sebelum tidur, collect pagi.
   */
  async runNightMode(): Promise<void> {
    console.log('[LPEngine] 🌙 NIGHT mode started — screening up to 3 pairs...');
    if (this.onNotification) await this.onNotification('🌙 *LP NIGHT mode started* — screening up to 3 pairs...');

    const config    = await loadLPConfig();
    const canOpen   = await this.canOpenNewPosition();
    if (!canOpen.ok) {
      console.warn(`[LPEngine] ⛔ NIGHT mode blocked: ${canOpen.reason}`);
      await logEvent('WARN', `[LP] NIGHT mode blocked: ${canOpen.reason}`);
      if (this.onNotification) await this.onNotification(`⛔ *NIGHT mode blocked:* ${canOpen.reason}`);
      return;
    }

    // Hitung berapa slot tersisa
    const openCount = await prisma.lPPosition.count({
      where: { status: { in: ['OPEN', 'PENDING'] } },
    });
    const slotsLeft = config.maxPositions - openCount;
    if (slotsLeft <= 0) return;

    const candidates = await screenPairs();
    const toOpen: PoolCandidate[] = [];
    
    // Evaluate candidates with Grok until we fill the slots
    for (const candidate of candidates) {
      if (toOpen.length >= Math.min(slotsLeft, 3)) break;
      
      console.log(`[LPEngine] 🧠 Asking Grok to analyze sentiment for ${candidate.token.symbol}...`);
      
      const sentiment = await IntelligenceLayer.analyzeSentiment(candidate.token.symbol, candidate.token.address);
      console.log(`[LPEngine] Grok Result for ${candidate.token.symbol}: ${sentiment.label} (Score: ${sentiment.score}) - ${sentiment.reasoning}`);
      
      if (sentiment.label === 'BEARISH' || sentiment.score < 50) {
        console.log(`[LPEngine] ❌ Grok REJECTED ${candidate.token.symbol}: Bearish or score < 50`);
        continue;
      }
      
      console.log(`[LPEngine] ✅ Grok APPROVED ${candidate.token.symbol}`);
      if (this.onNotification) await this.onNotification(`✅ *Grok APPROVED $${candidate.token.symbol}*\nScore: ${sentiment.score}\n_Wait for V3 pool..._`);
      toOpen.push(candidate);
    }

    for (const candidate of toOpen) {
      await this.proposeOpenPosition(candidate, {
        dayMode: false,
        nightMode: true,
        nightRange: config.nightRange,
      });
    }
  }

  // ─── Direct Alpha Signal Processing ──────────────────────────────────────────

  /** Called by Userbot when a signal passes Grok sentiment verification */
  async processAlphaSignal(token: GMGNToken, sentimentScore: number): Promise<void> {
    const config  = await loadLPConfig();
    const canOpen = await this.canOpenNewPosition();
    if (!canOpen.ok) {
      console.warn(`[LPEngine] ⛔ Alpha Signal blocked: ${canOpen.reason}`);
      await logEvent('WARN', `[LP] Alpha Signal blocked: ${canOpen.reason}`);
      if (this.onNotification) await this.onNotification(`⛔ *Alpha Signal blocked:* ${canOpen.reason}`);
      return;
    }

    // Pass token and score directly without mocking PoolCandidate
    await this.proposeOpenPosition({ token, score: sentimentScore }, {
      dayMode: true,
      nightMode: false,
      source: 'ALPHA'
    });
  }

  // ─── Core: Propose Open Position ────────────────────────────────────────────

  private async proposeOpenPosition(
    candidate: { token: GMGNToken; score: number },
    options: { dayMode: boolean; nightMode: boolean; nightRange?: number; source?: string }
  ): Promise<void> {
    const config    = await loadLPConfig();
    const token     = candidate.token;
    const modeCfg   = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const isDryRun  = (modeCfg?.value || 'LIVE') === 'DRY_RUN';
    const { wethAddress } = await this.getAddresses();

    console.log(`[LPEngine] 📋 Proposing position: ${token.symbol} | dayMode=${options.dayMode} | dryRun=${isDryRun}`);
    await logEvent('INFO', `[LP] Proposing position: ${token.symbol} | dayMode=${options.dayMode} | dryRun=${isDryRun}`);

    // Resolve pool address via factory
    const resolved = await this.resolvePool(token.address, wethAddress);
    if (!resolved) {
      console.warn(`[LPEngine] No V3 pool found for ${token.symbol}/WETH`);
      await logEvent('WARN', `[LP] No V3 pool found for ${token.symbol}/WETH`);
      if (this.onNotification) await this.onNotification(`⚠️ *Open Position Canceled*\nActive pool for $${token.symbol}/WETH not found.`);
      return;
    }
    const { poolAddress, feeTier, managerAddress } = resolved;
    const npmAddress = managerAddress as `0x${string}`;

    // Get token meta
    const [tokenMeta, wethMeta] = await Promise.all([
      this.getTokenMeta(token.address),
      this.getTokenMeta(wethAddress),
    ]);

    // Ensure token0 < token1 (Uniswap V3 requirement)
    const isToken0 = BigInt(token.address) < BigInt(wethAddress);
    const t0 = isToken0 ? token.address : wethAddress;
    const t1 = isToken0 ? wethAddress : token.address;
    const t0Symbol = isToken0 ? tokenMeta.symbol : wethMeta.symbol;
    const t1Symbol = isToken0 ? wethMeta.symbol  : tokenMeta.symbol;
    const t0Dec = isToken0 ? tokenMeta.decimals : wethMeta.decimals;
    const t1Dec = isToken0 ? wethMeta.decimals  : tokenMeta.decimals;

    // Tick range
    let tickLower: number;
    let tickUpper: number;

    if (options.dayMode) {
      const ticks = fullRangeTicks(feeTier);
      tickLower = ticks.tickLower;
      tickUpper = ticks.tickUpper;
    } else {
      // NIGHT mode: get current tick from pool
      const { currentTick } = await getPoolSlot0(poolAddress);
      const ticks = calcNightTickRange(
        currentTick,
        options.nightRange ?? 0.25,
        feeTier
      );
      tickLower = ticks.tickLower;
      tickUpper = ticks.tickUpper;
    }

    // Amount calculation: split startSize 50/50 between token0 and token1
    const halfUsd = config.startSize / 2;
    const token0Price = isToken0 ? token.priceUsd : 1; // WETH assumed ~$3500, use 1 for ETH-pair
    const token1Price = isToken0 ? 1 : token.priceUsd;
    const amount0Desired = this.usdToTokenAmount(halfUsd, token0Price, t0Dec);
    const amount1Desired = this.usdToTokenAmount(halfUsd, token1Price, t1Dec);

    const recipient = (process.env.USER_WALLET_ADDRESS ?? '') as Address;
    const tier = await getUserTier(recipient);
    const limits = getTierLimits(tier);

    // Enforce Active Positions Limit
    const activePositionsCount = await prisma.lPPosition.count({
      where: {
        status: { in: ['OPEN', 'PENDING'] }
      }
    });

    if (activePositionsCount >= limits.maxPositions) {
      const msg = `*Tier Limit Reached*\nYou are currently on Tier ${tier}. You have reached the maximum allowed active LP positions (${limits.maxPositions}). Please close an existing position or upgrade your $FLETCH holdings.`;
      console.warn(`[LPEngine] ${msg}`);
      await logEvent('WARN', `[LP] Limit Reached: Tier ${tier} cannot open position for ${token.symbol}`);
      if (this.onNotification) await this.onNotification(`⚠️ ${msg}`);
      return;
    }

    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 60 * 10); // 10 min

    // Build calldata
    const calldata = this.buildMintCalldata({
      token0: t0 as Address,
      token1: t1 as Address,
      fee: feeTier,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      recipient,
      deadline,
    });

    const modeLabel = options.dayMode ? 'DAY' : 'NIGHT';
    const rangeLabel = options.dayMode
      ? 'Full Range'
      : `±${((options.nightRange ?? 0.25) * 100).toFixed(0)}% concentrated`;

    const description =
      `💧 *LP OPEN Proposal — ${modeLabel} MODE*\n` +
      `Pool: \`${poolAddress.slice(0, 10)}...\`\n` +
      `Pair: ${t0Symbol}/${t1Symbol} (fee: ${feeTier / 10000}%)\n` +
      `Range: ${rangeLabel}\n` +
      `Size: $${config.startSize}\n` +
      `Score: ${candidate.score}/100\n` +
      `MCap: $${(token.marketCap / 1000).toFixed(0)}K | Vol24h: $${(token.volume24h / 1000).toFixed(0)}K`;

    const defaultModeRecord = await prisma.systemConfig.findUnique({ where: { key: 'lp.defaultMode' } });
    const currentMode = (defaultModeRecord?.value as 'MANUAL' | 'SEMI' | 'FULL') || 'MANUAL';

    // Save PENDING record to DB (or OPEN if DRY RUN simulation)
    const dbRecord = await prisma.lPPosition.create({
      data: {
        tokenId:     isDryRun ? `SIM-${Date.now()}` : `PENDING-${Date.now()}`,
        pool:        poolAddress,
        token0:      t0,
        token1:      t1,
        managerAddress: npmAddress,
        token0Symbol: t0Symbol,
        token1Symbol: t1Symbol,
        feeTier,
        tickLower,
        tickUpper,
        entryValue:  config.startSize,
        mode:        currentMode,
        status:      isDryRun ? 'OPEN' : 'PENDING',
        dayMode:     options.dayMode,
        nightMode:   options.nightMode,
        source:      options.source ?? 'SYSTEM',
        tradingMode: (modeCfg?.value || 'LIVE'),
      },
    });

    console.log(`[LPEngine] 📝 LPPosition created in DB: ${dbRecord.id} (PENDING)`);
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
      entryValueUsd: config.startSize,
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
      console.log(`[LPEngine] Mode FULL — Executing automatically via Alchemy Session Key`);
      try {
        const tier = await getUserTier(recipient);
        const client = await getSessionKeyClient('FULL', tier);
        const calls: UserOpCall[] = [{
          target: npmAddress,
          data: calldata
        }];

        const txHash = await buildAndSendLPUserOperation(client, calls);
        
        await prisma.lPPosition.update({
          where: { id: dbRecord.id },
          data: { status: 'OPEN' }
        });

        proposal.description = `✅ *Auto-Opened LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
        await logEvent('INFO', `[LP] Position Auto-Opened via Session Key`, { positionId: dbRecord.id, txHash });
        if (this.onProposal) await this.onProposal(proposal); // Acts as notification
        return;
      } catch (e: any) {
        await logEvent('ERROR', `[LP] Auto-Open Failed`, { error: e.message });
        console.error(`[LPEngine] Failed to auto-open position: ${e.message}`);
        proposal.description = `❌ *Auto-Open Failed*\n` + proposal.description + `\nError: ${e.message}`;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      }
    }

    if (this.onProposal) {
      await this.onProposal(proposal);
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
    const pos = await prisma.lPPosition.findUnique({ where: { id: positionId } });
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
    const recipient = (process.env.USER_WALLET_ADDRESS ?? '') as Address;

    // Read current liquidity from NPM (skip if simulated)
    let liquidity = 0n;
    if (!isSim) {
      try {
        const data = await publicClient.readContract({
          address: npmAddress,
          abi: NPM_ABI,
          functionName: 'positions',
          args: [tokenId],
        }) as unknown as any[];
        liquidity = data[7] as bigint;
      } catch (e: any) {
        console.error(`[LPEngine] NPM positions() failed: ${e.message}`);
      }
    } else {
      liquidity = 1000000000n; // Dummy liquidity for simulation proposal
    }

    // Decrease 100% liquidity
    const decreaseCalldata = this.buildDecreaseLiquidityCalldata(tokenId, liquidity, deadline);

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
      calldata: decreaseCalldata,
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
      console.log(`[LPEngine] Mode FULL — Auto-closing position via Alchemy Session Key`);
      try {
        const tier = await getUserTier(recipient);
        const client = await getSessionKeyClient('FULL', tier);
        const collectCalldata = this.buildCollectCalldata(tokenId, recipient);
        
        // Batch: Decrease + Collect
        const calls: UserOpCall[] = [
          { target: npmAddress, data: decreaseCalldata },
          { target: npmAddress, data: collectCalldata }
        ];

        const txHash = await buildAndSendLPUserOperation(client, calls);
        
        await prisma.lPPosition.update({
          where: { id: positionId },
          data: { status: 'CLOSED' } as any,
        });

        await logEvent('INFO', `[LP] Position Closed (Confirmed)`, { positionId });

        proposal.description = `✅ *Auto-Closed LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
        if (this.onProposal) await this.onProposal(proposal);
        return;
      } catch (e: any) {
        await logEvent('ERROR', `[LP] Auto-Close Failed`, { error: e.message });
        console.error(`[LPEngine] Failed to auto-close position: ${e.message}`);
        proposal.description = `❌ *Auto-Close Failed*\n` + proposal.description + `\nError: ${e.message}`;
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

    const positions = await prisma.lPPosition.findMany({ where });
    const recipient = (process.env.USER_WALLET_ADDRESS ?? '') as Address;
    const tier = await getUserTier(recipient);
    const { npmAddress: defaultNpm } = await this.getAddresses();

    for (const pos of positions) {
      if (pos.tokenId.startsWith('PENDING')) continue;
      const isSim = pos.tokenId.startsWith('SIM-') || pos.tradingMode === 'DRY_RUN';

      const tokenId = isSim ? 0n : BigInt(pos.tokenId);
      const recipient = (process.env.USER_WALLET_ADDRESS ?? '') as Address;
      const npmAddress = (pos.managerAddress as `0x${string}`) || (await this.getAddresses()).npmAddress;

      const calldata = isSim ? '0x' : this.buildCollectCalldata(tokenId, recipient);

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
          if (this.onProposal) await this.onProposal(proposal);
          continue;
        }
        console.log(`[LPEngine] Mode ${pos.mode} — Auto-harvesting via Alchemy Session Key`);
        try {
          const client = await getSessionKeyClient(pos.mode as 'SEMI' | 'FULL', tier);
          const calls: UserOpCall[] = [
            { target: npmAddress, data: calldata }
          ];

          const txHash = await buildAndSendLPUserOperation(client, calls);
          await logEvent('INFO', `[LP] Position Auto-Harvested via Session Key`, { positionId: pos.id, txHash });

          proposal.description = `✅ *Auto-Harvested LP*\n` + proposal.description + `\nTx: \`${txHash.slice(0, 10)}...\``;
          if (this.onProposal) await this.onProposal(proposal);
          continue; // Move to next position
        } catch (e: any) {
          await logEvent('ERROR', `[LP] Auto-Harvest Failed`, { error: e.message });
          console.error(`[LPEngine] Failed to auto-harvest position: ${e.message}`);
          proposal.description = `❌ *Auto-Harvest Failed*\n` + proposal.description + `\nError: ${e.message}`;
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
  async onOpenConfirmed(positionId: string, realTokenId: string): Promise<void> {
    await prisma.lPPosition.update({
      where: { id: positionId },
      data: { status: 'OPEN', tokenId: realTokenId } as any,
    });
    await logEvent('INFO', `[LP] Position Opened (Confirmed) - TokenID: ${realTokenId}`, { positionId });
    console.log(`[LPEngine] ✅ Position ${positionId} confirmed — tokenId: ${realTokenId}`);
  }

  async onCloseConfirmed(positionId: string, feesCollectedUsd: number): Promise<void> {
    await prisma.lPPosition.update({
      where: { id: positionId },
      data: {
        status: 'CLOSED',
        feesCollected: { increment: feesCollectedUsd },
      },
    });
    console.log(`[LPEngine] ✅ Position ${positionId} closed — fees: $${feesCollectedUsd}`);
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
