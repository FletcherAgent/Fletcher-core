import { publicClient } from './viem.js';
import { parseAbi } from 'viem';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)'
]);

const CACHE_DURATION = 5 * 60 * 1000;
const tierCache = new Map<string, { tier: number; timestamp: number }>();

/**
 * Get user tier based on their $FLETCH balance.
 * Tiers:
 * 3 (VIP) >= 100,000 $FLETCH
 * 2 (Pro) >= 50,000 $FLETCH
 * 1 (Base) >= 10,000 $FLETCH
 * 0 (None) < 10,000 $FLETCH
 */
export async function getUserTier(walletAddress: string): Promise<number> {
  if (!walletAddress) return 0;
  
  const normalizedAddress = walletAddress.toLowerCase();
  const cached = tierCache.get(normalizedAddress);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.tier;
  }

  const fletchAddress = process.env.FLETCH_TOKEN_ADDRESS as `0x${string}`;
  
  if (!fletchAddress || fletchAddress === '0x0000000000000000000000000000000000000000') {
    // Development bypass
    console.log(`[TierGate] Development Bypass: Assigning Tier 3 to ${walletAddress}`);
    tierCache.set(normalizedAddress, { tier: 3, timestamp: Date.now() });
    return 3;
  }

  try {
    const balanceWei = await publicClient.readContract({
      address: fletchAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress as `0x${string}`],
    });

    const balance = Number(balanceWei) / 1e18; // Assuming 18 decimals
    let tier = 0;

    if (balance >= 100000) {
      tier = 3;
    } else if (balance >= 50000) {
      tier = 2;
    } else if (balance >= 10000) {
      tier = 1;
    }

    tierCache.set(normalizedAddress, { tier, timestamp: Date.now() });
    return tier;
  } catch (error) {
    console.error(`[TierGate] Error fetching tier for ${walletAddress}:`, error);
    return 0; // Default to 0 on failure
  }
}

export function clearTierCache(walletAddress: string) {
  tierCache.delete(walletAddress.toLowerCase());
}

export function getTierLimits(tier: number) {
  switch (tier) {
    case 3: 
      return { maxPositions: Infinity, allowedModes: ['MANUAL', 'SEMI', 'FULL'], sponsoredGas: true };
    case 2: 
      return { maxPositions: 3, allowedModes: ['MANUAL', 'SEMI'], sponsoredGas: false };
    case 1: 
      return { maxPositions: 1, allowedModes: ['MANUAL'], sponsoredGas: false };
    default: 
      return { maxPositions: 0, allowedModes: [], sponsoredGas: false };
  }
}
