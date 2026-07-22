import { encodeFunctionData, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { publicClient } from '../viem.js';
import { feeToTickSpacing } from '../lpMath.js';
// Minimal V4 ABIs
const POOL_MANAGER_ABI = parseAbi([
    'function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);
const POS_MANAGER_ABI = parseAbi([
    // Note: V4 PositionManager is still actively being finalized, using a representative signature.
    'function mint(tuple(bytes32 poolId, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData) params) external payable returns (uint256 amount0, uint256 amount1)',
    'function positions(uint256 tokenId) external view returns (bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
]);
export class UniswapV4Adapter {
    protocol = 'V4';
    getPoolId(token0, token1, fee, tickSpacing, hooks) {
        // PoolId is keccak256(abi.encode(token0, token1, fee, tickSpacing, hooks))
        return keccak256(encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [token0, token1, fee, tickSpacing, hooks]));
    }
    async getPoolState(poolAddress) {
        // In V4, poolAddress is actually the PoolManager address. 
        // We would need the PoolKey to get slot0, which is tricky with this interface.
        // For now, we assume we have a way to resolve it or poolAddress acts as a generic identifier.
        // We'll throw an error if this is called directly without a proper PoolId.
        throw new Error('V4 getPoolState requires PoolId, not just PoolManager address. Refactoring needed for full V4 support.');
    }
    async getPosition(tokenId, managerAddress) {
        const r = await publicClient.readContract({
            address: managerAddress,
            abi: POS_MANAGER_ABI,
            functionName: 'positions',
            args: [tokenId],
        });
        return {
            token0: '0x', // We don't get this directly from positions mapping in V4 (it's inside PoolKey)
            token1: '0x',
            fee: 0,
            tickLower: Number(r[1]),
            tickUpper: Number(r[2]),
            liquidity: r[3],
            tokensOwed0: 0n, // V4 fee claiming is different
            tokensOwed1: 0n,
        };
    }
    buildMintCalldata(params) {
        const tickSpacing = feeToTickSpacing(params.feeTier);
        const poolId = this.getPoolId(params.token0, params.token1, params.feeTier, tickSpacing, '0x0000000000000000000000000000000000000000');
        return encodeFunctionData({
            abi: POS_MANAGER_ABI,
            functionName: 'mint',
            args: [{
                    poolId,
                    tickLower: params.tickLower,
                    tickUpper: params.tickUpper,
                    liquidity: params.amount0Desired, // Simplified: V4 uses exact liquidity or requires router
                    amount0Max: params.amount0Desired,
                    amount1Max: params.amount1Desired,
                    owner: params.recipient,
                    hookData: '0x'
                }],
        });
    }
    buildCollectCalldata(tokenId, recipient) {
        throw new Error('V4 collect not fully implemented in adapter.');
    }
    buildCloseCalldata(tokenId, liquidity, recipient, deadline) {
        throw new Error('V4 close not fully implemented in adapter.');
    }
}
