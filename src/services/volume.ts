import { publicClient } from './viem.js';
import { parseAbiItem, formatUnits } from 'viem';
import { getTokenInfo } from './gmgn/index.js';

const SWAP_EVENT_ABI = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

export async function getTrailingVolume5m(poolAddress: string, token0: string, token1: string, wethPrice: number): Promise<number> {
  try {
    const latestBlock = await publicClient.getBlockNumber();
    // Robinhood chain block time is ~2 seconds. 5 minutes = 300 seconds = ~150 blocks.
    // We add a buffer of 50 blocks just to be safe.
    const fromBlock = latestBlock - 200n;

    const logs = await publicClient.getLogs({
      address: poolAddress as `0x${string}`,
      event: SWAP_EVENT_ABI,
      fromBlock,
      toBlock: latestBlock,
    });

    // We need to fetch the block timestamp to filter exactly 5 minutes (300 seconds)
    const blockCache = new Map<bigint, number>();
    
    let totalUsdVolume = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const fiveMinsAgo = nowSec - 300;
    
    const wethAddr = (process.env.WETH_ADDRESS ?? '').toLowerCase();
    
    // We only need to know which token is WETH or base token to calculate USD volume.
    // If one token is WETH, we use its amount. If neither, we need the token price.
    let token0PriceUsd = 0;
    let token1PriceUsd = 0;

    if (token0.toLowerCase() === wethAddr) {
      token0PriceUsd = wethPrice;
    } else {
      const info = await getTokenInfo(token0);
      token0PriceUsd = info?.priceUsd || 0;
    }

    if (token1.toLowerCase() === wethAddr) {
      token1PriceUsd = wethPrice;
    } else {
      const info = await getTokenInfo(token1);
      token1PriceUsd = info?.priceUsd || 0;
    }

    // Fetch decimals to calculate exact amounts
    const ERC20_DECIMALS_ABI = parseAbiItem('function decimals() external view returns (uint8)');
    
    let token0Decimals = 18;
    let token1Decimals = 18;
    try {
      token0Decimals = await publicClient.readContract({
        address: token0 as `0x${string}`,
        abi: [ERC20_DECIMALS_ABI],
        functionName: 'decimals'
      }) as number;
    } catch(e) {}
    try {
      token1Decimals = await publicClient.readContract({
        address: token1 as `0x${string}`,
        abi: [ERC20_DECIMALS_ABI],
        functionName: 'decimals'
      }) as number;
    } catch(e) {}

    for (const log of logs) {
      // Lazy load block timestamps
      let blockTime = blockCache.get(log.blockNumber!);
      if (!blockTime) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber! });
        blockTime = Number(block.timestamp);
        blockCache.set(log.blockNumber!, blockTime);
      }

      if (blockTime >= fiveMinsAgo) {
        const { amount0, amount1 } = log.args;
        // In Uniswap V3, amount0 and amount1 are delta balances. One is positive, one is negative.
        // The volume is the absolute value of the swap size.
        const absAmount0 = Math.abs(Number(formatUnits(BigInt(amount0 ?? 0), token0Decimals)));
        const absAmount1 = Math.abs(Number(formatUnits(BigInt(amount1 ?? 0), token1Decimals)));
        
        // Prefer pricing the WETH side if available, otherwise token price
        let tradeVolUsd = 0;
        if (token0PriceUsd > 0) {
          tradeVolUsd = absAmount0 * token0PriceUsd;
        } else if (token1PriceUsd > 0) {
          tradeVolUsd = absAmount1 * token1PriceUsd;
        }

        totalUsdVolume += tradeVolUsd;
      }
    }

    return totalUsdVolume;
  } catch (e: any) {
    console.error(`[VolumeService] Failed to calculate 5m volume for ${poolAddress}:`, e.message);
    return 0;
  }
}
