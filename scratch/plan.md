# Fix Guardian Exit Logic & Resiliency

## 1. GuardianAgent (`src/agents/guardian.ts`)
- Add `init()` method to poll `prisma.position.findMany({ where: { status: 'OPEN' } })` every 15 seconds.
- If an open position is found and not in `activeIntervals`, call `startMonitoring(pos)`.
- Change `startMonitoring` to accept a `Position` object.
- `initialQuote` = `pos.entryPrice`.
- Monitor current price by querying Quoter with `WETH -> Token` for 0.01 WETH to get a safe ratio: `currentPrice = Number(0.01 WETH) / Number(tokensOut)`.
- Apply +50% TP, -30% SL, -30% trailing SL against `currentPrice`.
- If triggered, call `onExitSignal(pos, reason)`.

## 2. Orchestrator (`src/core/orchestrator.ts`)
- Remove `this.guardian.startMonitoring` calls, as Guardian is now autonomous via DB polling.
- Call `this.guardian.init()` in `startAll()`.
- Update `onExitSignal` signature to receive `(pos: Position, reason: string)`.
- When exiting:
  - Try fetching real `balanceOf`.
  - If real balance > 0, sell real balance.
  - If real balance == 0, fallback to `simulatedBalance = (pos.size * 1e18) / pos.entryPrice` (assuming Paper Trade).
  - Forward to `trader.processExitSignal(pos.tokenAddress, tokenAmountToSell, reason, isPaperTrade)`.

## 3. TraderAgent (`src/agents/trader.ts`)
- Update `processExitSignal(token, amount, reason, isPaperTrade)`.
- If `isPaperTrade`, simulate the exit instead of executing a real transaction. Quote the sell price, update position `exitPrice` in DB, mark `status: 'CLOSED'`, and calc PnL.
