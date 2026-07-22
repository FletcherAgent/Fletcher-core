import { encodeFunctionData, parseAbi } from 'viem';
import { LiquidityProtocol, MintParams, PoolState, PositionInfo } from './LiquidityProtocol.js';
import { publicClient } from '../viem.js';

const POOL_ABI = parseAbi([
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const NPM_ABI = parseAbi([
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)'
]);

const MAX_UINT128 = 340282366920938463463374607431768211455n;

export class UniswapV3Adapter implements LiquidityProtocol {
  protocol: 'V3' | 'V4' = 'V3';
  
  async getPoolState(poolAddress: string): Promise<PoolState> {
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

  async getPosition(tokenId: bigint, managerAddress: string): Promise<PositionInfo> {
    const r = await publicClient.readContract({
      address: managerAddress as `0x${string}`,
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

  buildMintCalldata(params: MintParams): `0x${string}` {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'mint',
      args: [{
        token0: params.token0 as `0x${string}`,
        token1: params.token1 as `0x${string}`,
        fee: params.feeTier,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
        recipient: params.recipient as `0x${string}`,
        deadline: BigInt(params.deadline),
      }],
    });
  }

  buildCollectCalldata(tokenId: bigint, recipient: string): `0x${string}` {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'collect',
      args: [{
        tokenId,
        recipient: recipient as `0x${string}`,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    });
  }

  buildCloseCalldata(tokenId: bigint, liquidity: bigint, recipient: string, deadline?: number): `0x${string}` {
    const ts = deadline ? BigInt(deadline) : BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
    // Usually a multicall is needed to decreaseLiquidity and then collect
    // But for the scope of just building calldata, we replicate current lpengine behavior.
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: ts,
      }],
    });
  }
}
