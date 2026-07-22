import { publicClient } from './viem.js';
import { parseAbi } from 'viem';
import { prisma } from '../core/db.js';
import { getAllDexConfigs } from '../core/dexConfig.js';
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
export async function detectBestFee(tokenIn, tokenOut, amountIn, targetRouter) {
    let uniqueV3Quoters = [];
    let uniqueV4Quoters = [];
    try {
        const v3Configs = await getAllDexConfigs('V3');
        const v4Configs = await getAllDexConfigs('V4');
        uniqueV3Quoters = v3Configs.map(c => c.quoterAddress).filter(Boolean);
        uniqueV4Quoters = v4Configs.map(c => c.quoterAddress).filter(Boolean);
    }
    catch (e) {
        console.warn(`[PoolFeeDetector] Failed to load dynamic routers from DB`, e);
    }
    // Remove duplicates
    uniqueV3Quoters = Array.from(new Set(uniqueV3Quoters));
    uniqueV4Quoters = Array.from(new Set(uniqueV4Quoters));
    if (uniqueV3Quoters.length === 0) {
        console.warn('[PoolFeeDetector] ⚠️ V3 QUOTER not configured! V3 detection skipped.');
    }
    if (uniqueV4Quoters.length === 0) {
        console.warn('[PoolFeeDetector] ⚠️ V4 QUOTER not configured! V4 detection skipped.');
    }
    const quoterV3Abi = parseAbi([
        'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ]);
    const quoterV3_V2Abi = [
        {
            type: 'function',
            name: 'quoteExactInputSingle',
            inputs: [
                {
                    name: 'params',
                    type: 'tuple',
                    components: [
                        { name: 'tokenIn', type: 'address' },
                        { name: 'tokenOut', type: 'address' },
                        { name: 'amountIn', type: 'uint256' },
                        { name: 'fee', type: 'uint24' },
                        { name: 'sqrtPriceLimitX96', type: 'uint160' }
                    ]
                }
            ],
            outputs: [
                { name: 'amountOut', type: 'uint256' },
                { name: 'sqrtPriceX96After', type: 'uint160' },
                { name: 'initializedTicksCrossed', type: 'uint32' },
                { name: 'gasEstimate', type: 'uint256' }
            ],
            stateMutability: 'nonpayable'
        }
    ];
    const quoterV4Abi = [
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
    const isZeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
    const currency0 = isZeroForOne ? tokenIn : tokenOut;
    const currency1 = isZeroForOne ? tokenOut : tokenIn;
    let best = { fee: 3000, expectedOut: 0n, type: 'V3' };
    // Query all fee tiers across all quoters in parallel
    const v3Promises = [];
    const v3_V2Promises = [];
    const v4Promises = [];
    for (const quoter of uniqueV3Quoters) {
        for (const fee of FEE_TIERS) {
            // Try V3 Quoter V1 ABI
            v3Promises.push(publicClient.readContract({
                address: quoter,
                abi: quoterV3Abi,
                functionName: 'quoteExactInputSingle',
                args: [tokenIn, tokenOut, fee, amountIn, 0n]
            }).then(out => ({ fee, expectedOut: out, type: 'V3' })));
            // Try V3 Quoter V2 ABI
            v3_V2Promises.push(publicClient.readContract({
                address: quoter,
                abi: quoterV3_V2Abi,
                functionName: 'quoteExactInputSingle',
                args: [{
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        amountIn,
                        fee,
                        sqrtPriceLimitX96: 0n
                    }]
            }).then((out) => ({ fee, expectedOut: out[0], type: 'V3' })));
        }
    }
    for (const quoter of uniqueV4Quoters) {
        for (const fee of FEE_TIERS) {
            let tickSpacing = 60;
            if (fee === 500)
                tickSpacing = 10;
            else if (fee === 10000)
                tickSpacing = 200;
            // Try V4 Quoter
            v4Promises.push(publicClient.readContract({
                address: quoter,
                abi: quoterV4Abi,
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
                    0n,
                    '0x'
                ]
            }).then(out => ({ fee, expectedOut: out[0], type: 'V4' })));
        }
    }
    const allPromises = [...v3Promises, ...v3_V2Promises, ...v4Promises];
    const results = await Promise.allSettled(allPromises);
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.expectedOut > best.expectedOut) {
            best = result.value;
        }
    }
    if (best.expectedOut > 0n) {
        process.stdout.write(`[PoolFeeDetector] ✅ Best ${best.type} pool: fee=${best.fee} → expectedOut=${best.expectedOut}\n`);
        return best;
    }
    // V2 Fallback
    console.log(`[PoolFeeDetector] ⚠️ V4/V3 Quoters failed. Trying V2 Routers...`);
    let v2Configs = [];
    try {
        v2Configs = await getAllDexConfigs('V2');
    }
    catch (e) { }
    const V2_ROUTERS = v2Configs.map(c => c.routerAddress).filter(Boolean);
    if (targetRouter && !V2_ROUTERS.includes(targetRouter)) {
        V2_ROUTERS.unshift(targetRouter); // Try target router first
    }
    const uniqueV2Routers = Array.from(new Set(V2_ROUTERS));
    for (const v2Router of uniqueV2Routers) {
        try {
            const v2RouterAbi = parseAbi([
                'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
            ]);
            const amountsOut = await publicClient.readContract({
                address: v2Router,
                abi: v2RouterAbi,
                functionName: 'getAmountsOut',
                args: [amountIn, [tokenIn, tokenOut]]
            });
            if (amountsOut && amountsOut.length > 1 && amountsOut[1] > 0n) {
                if (amountsOut[1] > best.expectedOut) {
                    best = { fee: 3000, expectedOut: amountsOut[1], type: 'V2', routerAddress: v2Router };
                    process.stdout.write(`[PoolFeeDetector] ✅ Found V2 pool at ${v2Router} → expectedOut=${best.expectedOut}\n`);
                    // Asynchronously save to DB if it's a dynamic target router
                    if (v2Router === targetRouter) {
                        prisma.dexProtocol.findFirst({ where: { routerAddress: v2Router } })
                            .then((existing) => {
                            if (!existing) {
                                return prisma.dexProtocol.create({
                                    data: { name: 'Auto-Detected V2', version: 'V2', routerAddress: v2Router, verified: true }
                                });
                            }
                        })
                            .then(() => console.log(`[PoolFeeDetector] 💾 Saved new verified V2 Router to DB: ${v2Router}`))
                            .catch((err) => console.warn(`[PoolFeeDetector] Failed to save router to DB`, err));
                    }
                    return best;
                }
            }
        }
        catch (err) {
            // V2 Router fallback failed for this address
        }
    }
    if (best.expectedOut === 0n) {
        throw new Error(`[PoolFeeDetector] ❌ No active pool found for ${tokenIn} → ${tokenOut}. Sim failed.`);
    }
    return best;
}
