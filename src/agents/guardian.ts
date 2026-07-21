import { publicClient } from '../services/viem.js';
import { parseAbi, parseEther, type Address } from 'viem';
import { prisma } from '../core/db.js';
import type { Position, LPPosition } from '@prisma/client';
import { detectBestFee } from '../services/poolFeeDetector.js';
import { calcAnnualizedFeeRate, calcIL, getNPMPosition, checkPositionRange, isPastDayCloseTime, tickToPrice } from '../services/lpMath.js';
import { logEvent } from '../utils/logger.js';

export class GuardianAgent {
  public onExitSignal?: (pos: Position, reason: string, txHash?: string) => void;
  public onLPCloseSignal?: (pos: LPPosition, reason: string) => void;
  public onLPCompoundSignal?: (pos: LPPosition) => void;
  public onLPRebalanceSignal?: (pos: LPPosition, reason: string) => void;

  private activeIntervals: Map<string, {
    intervalId: NodeJS.Timeout;
    initialQuote: number;
    highestQuote: number;
    startedAt: number;
  }> = new Map();

  private lpMonitorInterval?: NodeJS.Timeout;

  constructor() {}

  public isMonitoring(tokenAddress: string): boolean {
    return this.activeIntervals.has(tokenAddress);
  }

  /**
   * Initializes autonomous polling of database for OPEN positions.
   * This ensures resilience across bot restarts.
   */
  public async init() {
    console.log(`[Guardian] 🛡️ Initializing autonomous DB polling for OPEN positions...`);
    
    // Poll every 15 seconds for unmonitored open positions
    setInterval(async () => {
      try {
        const openPositions = await prisma.position.findMany({ where: { status: 'OPEN' } });
        for (const pos of openPositions) {
          if (!this.activeIntervals.has(pos.tokenAddress)) {
            console.log(`[Guardian] 📡 Detected unmonitored OPEN position for ${pos.tokenAddress}. Starting monitoring...`);
            this.startMonitoring(pos);
          }
        }
      } catch (e) {
        console.error(`[Guardian] Error polling for open positions`, e);
      }
    }, 15000);

    // ─── LP Engine v2.0 Monitoring ──────────────────────────────────────────
    this.startLPMonitoring();
  }

  // ─── LP Engine Guardian (Rule §3.4) ───────────────────────────────────────

  private startLPMonitoring() {
    console.log(`[Guardian] 🛡️ Starting autonomous LP Engine monitoring (Rule §3.4)...`);
    
    // Poll hourly for LP positions
    this.lpMonitorInterval = setInterval(async () => {
      try {
        const openLPs = await prisma.lPPosition.findMany({ where: { status: 'OPEN' } });
        for (const pos of openLPs) {
          await this.evaluateLPPosition(pos);
        }
        await this.sendLPDailyReport();
      } catch (e) {
        console.error(`[Guardian] LP monitor loop error:`, e);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  private async evaluateLPPosition(pos: LPPosition): Promise<void> {
    if (pos.tokenId.startsWith('PENDING')) return;

    try {
      // 1. Fetch live data
      const npmPos = await getNPMPosition(BigInt(pos.tokenId), pos.managerAddress);
      const config = await prisma.systemConfig.findUnique({ where: { key: 'lp.ilHourThreshold' } });
      const maxIlHours = parseInt(config?.value ?? '4');
      const capConfig = await prisma.systemConfig.findUnique({ where: { key: 'lp.positionCap' } });
      const positionCap = parseFloat(capConfig?.value ?? '2000');

      // (Simulate token price from Uniswap V3 current tick)
      const rangeStatus = await checkPositionRange(pos.pool, pos.tickLower, pos.tickUpper);
      const currentPrice = tickToPrice(rangeStatus.currentTick);

      // 2. Calc IL
      // Simplification: WETH base price = 3500
      const isToken0 = BigInt(pos.token0) < BigInt(process.env.WETH_ADDRESS ?? '0');
      const wethPrice = 3500;
      const entryP0 = isToken0 ? (pos.entryValue / 2) / (wethPrice * currentPrice) : wethPrice; 
      const entryP1 = isToken0 ? wethPrice : (pos.entryValue / 2) / (wethPrice / currentPrice);
      const curP0 = isToken0 ? wethPrice * currentPrice : wethPrice;
      const curP1 = isToken0 ? wethPrice : wethPrice / currentPrice;

      const ilData = calcIL({
        entryPrice0: entryP0, entryPrice1: entryP1,
        currentPrice0: curP0, currentPrice1: curP1,
        entryValue: pos.entryValue,
        tickLower: pos.tickLower, tickUpper: pos.tickUpper
      });

      // 3. Calc Fees
      // Simplified USD estimation
      const feesUsd = (Number(npmPos.tokensOwed0) + Number(npmPos.tokensOwed1)) / 1e18 * wethPrice;
      
      const hoursOpen = Math.max(1, (Date.now() - pos.createdAt.getTime()) / 3600000);
      const feeRate = calcAnnualizedFeeRate(feesUsd, pos.entryValue, hoursOpen);
      const ilRate = calcAnnualizedFeeRate(Math.abs(ilData.ilUsd), pos.entryValue, hoursOpen);

      console.log(`[Guardian] LP ${pos.id.slice(0,8)} | FeeRate: ${(feeRate*100).toFixed(1)}% | ILRate: ${(ilRate*100).toFixed(1)}%`);

      // 4. Rule §3.4 Logic
      let ilHours = pos.ilAboveFeeHours;
      let feeHours = pos.feeAboveILHours;

      if (ilData.ilUsd < 0 && Math.abs(ilData.ilUsd) > feesUsd) {
        ilHours += 1;
        feeHours = 0;
        if (ilHours >= maxIlHours) {
          console.log(`[Guardian] 🚨 LP ${pos.id} IL > Fee for ${maxIlHours}h. Triggering CLOSE.`);
          await logEvent('WARN', `[LP] Guardian triggered CLOSE: IL > Fee for ${maxIlHours}h`, { positionId: pos.id });
          if (this.onLPCloseSignal) this.onLPCloseSignal(pos, `IL > Fee for ${maxIlHours} consecutive hours`);
        }
      } else {
        feeHours += 1;
        ilHours = 0;
        // Compound check
        if (pos.entryValue + feesUsd < positionCap && feesUsd > 10) {
          await logEvent('INFO', `[LP] Guardian triggered COMPOUND`, { positionId: pos.id, feesUsd });
          if (this.onLPCompoundSignal) this.onLPCompoundSignal(pos);
        }
      }

      // Update DB counters
      await prisma.lPPosition.update({
        where: { id: pos.id },
        data: { 
          ilAboveFeeHours: ilHours, 
          feeAboveILHours: feeHours,
          ilRunning: ilData.ilUsd 
        }
      });

      // 5. Check Range
      if (!rangeStatus.inRange) {
        console.log(`[Guardian] ⚠️ LP ${pos.id} OUT OF RANGE. Triggering REBALANCE/CLOSE.`);
        await logEvent('WARN', `[LP] Guardian triggered REBALANCE: Out of range`, { positionId: pos.id });
        if (this.onLPRebalanceSignal) this.onLPRebalanceSignal(pos, "Out of range");
      }

      // 6. DAY Mode fallback close
      if (pos.dayMode) {
        const closeTimeCfg = await prisma.systemConfig.findUnique({ where: { key: 'lp.dayCloseTime' } });
        if (isPastDayCloseTime(closeTimeCfg?.value ?? '23:00')) {
          console.log(`[Guardian] 🌙 LP ${pos.id} DAY mode fallback close triggered.`);
          await logEvent('INFO', `[LP] Guardian triggered DAY fallback close`, { positionId: pos.id });
          if (this.onLPCloseSignal) this.onLPCloseSignal(pos, "DAY mode 23:00 WIB fallback close");
        }
      }

    } catch (e: any) {
      console.error(`[Guardian] Error evaluating LP ${pos.id}:`, e);
      await logEvent('ERROR', `[LP] Guardian evaluation error`, { positionId: pos.id, error: e.message });
    }
  }

  private async sendLPDailyReport() {
    // Only send at 23:55 WIB
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const h = parseInt(parts.find(p => p.type === 'hour')!.value);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value);
    
    if (h === 23 && m >= 55) {
       // We would send a daily summary to telegram via Orchestrator bot
       // Not implemented directly here to avoid circular bot dependency, 
       // but can emit an event or save a log
       console.log(`[Guardian] Daily LP report time.`);
    }
  }


  /**
   * Starts an interval loop to continuously monitor an open position using real Quoter data.
   */
  public async startMonitoring(pos: Position) {
    const tokenAddress = pos.tokenAddress;
    console.log(`[Guardian] Starting active monitoring for token ${tokenAddress} (Entry Price: ${pos.entryPrice} WETH/Token)...`);
    
    const quoterAbi = parseAbi([
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ]);
    const WETH_ADDRESS = process.env.WETH_ADDRESS!; 
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS!;

    // Instead of passing the total wei we hold (which breaks Quoter on altcoins vs WETH), 
    // we query "How many altcoins do I get for 0.01 WETH?"
    const wethTestAmount = parseEther('0.01');
    const initialQuote = pos.entryPrice;

    let highestQuote = initialQuote;
    let failCount = 0;
    const startedAt = Date.now(); // We can also use pos.createdAt.getTime(), but let's stick to start of monitoring for time limits

    // Polling every 10 seconds
    const intervalId = setInterval(async () => {
      // console.log(`[Guardian] 🔍 Polling current price for ${tokenAddress}...`);
      
      try {
        // Query best active pool
        const { expectedOut: tokensOut } = await detectBestFee(WETH_ADDRESS, tokenAddress, wethTestAmount);


        // Calculate current exchange rate (WETH per 1 wei of Token)
        const currentQuote = Number(wethTestAmount) / Number(tokensOut);

        // Update High Watermark
        if (currentQuote > highestQuote) {
          highestQuote = currentQuote;
          console.log(`[Guardian] 🚀 New High Watermark for ${tokenAddress}: ${highestQuote} WETH`);
        }
        
        // 1. Fixed Take Profit (+50% -> 1.5x)
        const tpTarget = initialQuote * 1.5;
        if (currentQuote >= tpTarget) {
          console.log(`[Guardian] 📈 TARGET REACHED: +50% TP hit for ${tokenAddress}!`);
          this.triggerExit(pos, "FIXED_TAKE_PROFIT_50");
          return;
        } 
        
        // 2. Fixed Stop-Loss (-30% from entry)
        const slTarget = initialQuote * 0.7;
        if (currentQuote <= slTarget) {
          console.log(`[Guardian] 📉 STOP-LOSS HIT: -30% from entry for ${tokenAddress}!`);
          this.triggerExit(pos, "FIXED_STOP_LOSS_30");
          return;
        }

        // 3. Trailing Take-Profit (-30% from peak)
        if (highestQuote > initialQuote) {
          const trailingSlTarget = highestQuote * 0.7;
          if (currentQuote <= trailingSlTarget) {
            console.log(`[Guardian] 📉 TRAILING TAKE-PROFIT HIT: -30% from peak for ${tokenAddress}!`);
            this.triggerExit(pos, "TRAILING_TAKE_PROFIT_30");
            return;
          }
        }

        // 4. Emergency Rug Failsafe (-90% from peak)
        const emergencyTarget = highestQuote * 0.1;
        if (currentQuote <= emergencyTarget) {
          console.log(`[Guardian] 🚨 EMERGENCY: Massive liquidity drop detected for ${tokenAddress}!`);
          this.triggerExit(pos, "EMERGENCY_RUG");
          return;
        }

        // 5. Max Holding Time (Time Limit)
        const maxHoldMinutes = parseInt(process.env.MAX_HOLD_TIME_MINUTES || '30', 10);
        const MAX_HOLD_TIME_MS = maxHoldMinutes * 60 * 1000;
        if (Date.now() - pos.createdAt.getTime() > MAX_HOLD_TIME_MS) { // Using true creation time
          console.log(`[Guardian] ⏳ MAX HOLD TIME EXCEEDED (${maxHoldMinutes} Minutes) for ${tokenAddress}!`);
          this.triggerExit(pos, "TIME_LIMIT_EXCEEDED");
          return;
        }

      } catch (err) {
        failCount++;
        console.warn(`[Guardian] ⚠️ Failed to fetch current quote for ${tokenAddress} - pool might be temporarily unavailable. (Fail count: ${failCount}/3)`);
        
        if (failCount >= 3) {
           console.log(`[Guardian] ❌ Token ${tokenAddress} failed quoting 3 times. Marking as unsupported/rug.`);
           this.triggerExit(pos, "UNSUPPORTED_OR_RUG_NO_QUOTES");
        }
      }
      
    }, 10000); // 10 seconds

    this.activeIntervals.set(tokenAddress, { intervalId, initialQuote, highestQuote, startedAt });
  }

  /**
   * Triggers an exit and stops monitoring.
   */
  private triggerExit(pos: Position, reason: string) {
    console.log(`[Guardian] Triggering exit sequence for ${pos.tokenAddress}. Reason: ${reason}`);
    
    // Stop the interval loop
    const record = this.activeIntervals.get(pos.tokenAddress);
    if (record) {
      clearInterval(record.intervalId);
      this.activeIntervals.delete(pos.tokenAddress);
    }

    // Fire the event back to the orchestrator
    if (this.onExitSignal) {
      this.onExitSignal(pos, reason);
    }
  }
}
