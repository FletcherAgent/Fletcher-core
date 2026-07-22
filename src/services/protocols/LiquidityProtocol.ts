import { Address } from 'viem';

export interface PositionInfo {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  currentTick: number;
}

export interface MintParams {
  token0: string;
  token1: string;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
  deadline: number;
}

export interface LiquidityProtocol {
  protocol: 'V3' | 'V4';
  
  /** Get current pool state */
  getPoolState(poolAddress: string): Promise<PoolState>;

  /** Get position info */
  getPosition(tokenId: bigint, managerAddress?: string): Promise<PositionInfo>;

  /** Build calldata for minting a new position */
  buildMintCalldata(params: MintParams): `0x${string}`;

  /** Build calldata for collecting fees */
  buildCollectCalldata(tokenId: bigint, recipient: string): `0x${string}`;

  /** Build calldata for closing a position (remove liquidity + collect) */
  buildCloseCalldata(tokenId: bigint, liquidity: bigint, recipient: string, deadline?: number): `0x${string}`;
}
