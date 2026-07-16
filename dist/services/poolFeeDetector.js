import { publicClient } from './viem.js';
import { parseAbi } from 'viem';
/**
 * All Uniswap V3/V4 fee tiers to probe, sorted by most common first.
 * 500 = 0.05%, 3000 = 0.3%, 10000 = 1%
 */
const FEE_TIERS = [500, 3000, 10000];
/**
 * Detects the best pool fee tier for a token pair by querying the Quoter
 * for all known fee tiers in parallel, then selecting the one that yields
 * the highest output amount.
 *
 * Falls back to fee=3000 with expectedOut=0n if all queries fail.
 */
export async function detectBestFee(tokenIn, tokenOut, amountIn) {
    const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS;
    if (!QUOTER_ADDRESS) {
        throw new Error('[PoolFeeDetector] ❌ QUOTER_ADDRESS not set in .env! Cannot perform real queries without Quoter.');
    }
    const quoterAbi = [
        {
            type: 'function',
            name: 'quoteExactInputSingle',
            inputs: [
                {
                    name: 'key',
                    type: 'tuple',
                    components: [
                        { name: 'currency0', type: 'address' },
                        { name: 'currency1', type: 'address' },
                        { name: 'fee', type: 'uint24' },
                        { name: 'tickSpacing', type: 'int24' },
                        { name: 'hooks', type: 'address' }
                    ]
                },
                { name: 'zeroForOne', type: 'bool' },
                { name: 'amountIn', type: 'uint128' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
                { name: 'hookData', type: 'bytes' }
            ],
            outputs: [
                { name: 'amountOut', type: 'uint256' },
                { name: 'gasEstimate', type: 'uint256' }
            ],
            stateMutability: 'nonpayable'
        }
    ];
    // Determine token order
    const isZeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
    const currency0 = isZeroForOne ? tokenIn : tokenOut;
    const currency1 = isZeroForOne ? tokenOut : tokenIn;
    // Query all fee tiers in parallel
    const results = await Promise.allSettled(FEE_TIERS.map(async (fee) => {
        // Common tickSpacings: 500 -> 10, 3000 -> 60, 10000 -> 200
        let tickSpacing = 60;
        if (fee === 500)
            tickSpacing = 10;
        else if (fee === 10000)
            tickSpacing = 200;
        const out = await publicClient.readContract({
            address: QUOTER_ADDRESS,
            abi: quoterAbi,
            functionName: 'quoteExactInputSingle',
            args: [
                {
                    currency0: currency0,
                    currency1: currency1,
                    fee,
                    tickSpacing,
                    hooks: '0x0000000000000000000000000000000000000000'
                },
                isZeroForOne,
                amountIn,
                0n, // sqrtPriceLimitX96
                '0x'
            ]
        });
        return { fee, expectedOut: out[0] };
    }));
    let best = { fee: 3000, expectedOut: 0n };
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const fee = FEE_TIERS[i];
        if (result.status === 'fulfilled' && result.value.expectedOut > best.expectedOut) {
            best = result.value;
        }
        else if (result.status === 'rejected') {
            // No pool for this fee tier — silently skip
        }
    }
    if (best.expectedOut > 0n) {
        console.log(`[PoolFeeDetector] ✅ Best pool: fee=${best.fee} (${best.fee / 10000}%) → expectedOut=${best.expectedOut}`);
    }
    else {
        // V2 Fallback
        const V2_ROUTER_ADDRESS = process.env.V2_ROUTER_ADDRESS;
        if (V2_ROUTER_ADDRESS) {
            try {
                console.log(`[PoolFeeDetector] ⚠️ V4 Quoter failed. Trying V2 Router fallback...`);
                const v2RouterAbi = parseAbi([
                    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
                ]);
                const amountsOut = await publicClient.readContract({
                    address: V2_ROUTER_ADDRESS,
                    abi: v2RouterAbi,
                    functionName: 'getAmountsOut',
                    args: [amountIn, [tokenIn, tokenOut]]
                });
                if (amountsOut && amountsOut.length > 1 && amountsOut[1] > 0n) {
                    best = { fee: 3000, expectedOut: amountsOut[1] }; // V2 standard fee is 0.3%
                    console.log(`[PoolFeeDetector] ✅ Found V2 pool → expectedOut=${best.expectedOut}`);
                    return best;
                }
            }
            catch (err) {
                console.warn(`[PoolFeeDetector] ❌ V2 Router fallback failed.`);
            }
        }
        throw new Error(`[PoolFeeDetector] ❌ No active pool found for ${tokenIn} → ${tokenOut}. Simulation and dummy data are disabled.`);
    }
    return best;
}
