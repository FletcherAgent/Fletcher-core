import { publicClient } from './viem.js';
import { parseAbi } from 'viem';

/**
 * All Uniswap V3/V4 fee tiers to probe, sorted by most common first.
 * 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
 */
const FEE_TIERS = [500, 3000, 10000] as const;

interface FeeDetectionResult {
  fee: number;
  expectedOut: bigint;
}

/**
 * Detects the best pool fee tier for a token pair by querying the Quoter
 * for all known fee tiers in parallel, then selecting the one that yields
 * the highest output amount.
 *
 * Falls back to fee=3000 with expectedOut=0n if all queries fail.
 */
export async function detectBestFee(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<FeeDetectionResult> {
  const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;

  if (!QUOTER_ADDRESS) {
    console.warn('[PoolFeeDetector] QUOTER_ADDRESS not set. Falling back to default fee 3000.');
    return { fee: 3000, expectedOut: 0n };
  }

  const quoterAbi = parseAbi([
    'function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)'
  ]);

  // Query all fee tiers in parallel
  const results = await Promise.allSettled(
    FEE_TIERS.map(async (fee) => {
      const out = await publicClient.readContract({
        address: QUOTER_ADDRESS as `0x${string}`,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [
          tokenIn as `0x${string}`,
          tokenOut as `0x${string}`,
          fee,
          amountIn,
          0n
        ]
      }) as bigint;
      return { fee, expectedOut: out };
    })
  );

  let best: FeeDetectionResult = { fee: 3000, expectedOut: 0n };

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const fee = FEE_TIERS[i];

    if (result.status === 'fulfilled' && result.value.expectedOut > best.expectedOut) {
      best = result.value;
    } else if (result.status === 'rejected') {
      // No pool for this fee tier — silently skip
    }
  }

  if (best.expectedOut > 0n) {
    console.log(`[PoolFeeDetector] ✅ Best pool: fee=${best.fee} (${best.fee / 10000}%) → expectedOut=${best.expectedOut}`);
  } else {
    console.warn(`[PoolFeeDetector] ⚠️ No active pool found for ${tokenIn} → ${tokenOut}. Using fee=3000, amountOutMin=0 (sniper mode).`);
  }

  return best;
}
