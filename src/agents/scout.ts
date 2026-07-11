import { publicClient } from '../services/viem.js';
import { parseAbiItem } from 'viem';
import { BlockscoutService } from '../services/blockscout.js';

export class ScoutAgent {
  public onSignal?: (tokenAddress: string) => void;
  private blockscout = new BlockscoutService();

  constructor() {}

  /**
   * Start monitoring the blockchain for new tokens.
   */
  public async startListening() {
    console.log("🟢 Scout Agent: Starting monitoring for NOXA Factory & Uniswap V3 PoolCreated...");

    const UNISWAP_V3_FACTORY = (process.env.UNISWAP_V3_FACTORY_ADDRESS || '0x1F98431c8aD98523631AE4a59f267346ea31F984') as `0x${string}`;

    try {
      // Setup listener for PoolCreated events (Uniswap V3)
      publicClient.watchEvent({
        address: UNISWAP_V3_FACTORY,
        event: parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'),
        onLogs: (logs) => {
          for (const log of logs) {
            console.log(`[Scout] New Pool Detected! Token0: ${log.args.token0}, Token1: ${log.args.token1}`);
            // Call scoring function here
            if (log.args.token0) this.scoreLaunch(log.args.token0);
          }
        },
      });
    } catch (error) {
      console.error("🔴 Scout Agent: Failed to start watchEvent", error);
    }
  }

  private async scoreLaunch(tokenAddress: string) {
    console.log(`[Scout] Scoring launch for token: ${tokenAddress}`);
    
    const apiUrl = process.env.BLOCKSCOUT_API_URL;
    const apiKey = process.env.BLOCKSCOUT_API_KEY;

    if (!apiUrl) {
      console.warn("[Scout] Missing Blockscout API credentials in .env. Skipping scoring.");
      return;
    }

    try {
      // 1. Fetch smart contract creator
      const contractRes = await fetch(`${apiUrl}/v2/smart-contracts/${tokenAddress}${apiKey ? `?apikey=${apiKey}` : ''}`);
      if (!contractRes.ok) {
        throw new Error(`Blockscout API failed: ${contractRes.status}`);
      }
      
      const contractData = await contractRes.json();
      const deployer = contractData.creator_address;

      if (!deployer) {
        console.warn(`[Scout] Could not find deployer for token ${tokenAddress}`);
        return;
      }

      console.log(`[Scout] Deployer identified: ${deployer}`);

      // 2. Evaluate using Blockscout Service
      const deployerHistory = await this.blockscout.getDeployerHistory(deployer);
      const holdersData = await this.blockscout.getTokenHolders(tokenAddress);

      // 3. Composite Heuristic Score
      let score = 50;
      
      if (deployerHistory) {
        if (deployerHistory.riskScore === 'LOW') score += 20;
        else if (deployerHistory.riskScore === 'MEDIUM') score -= 10;
        else if (deployerHistory.riskScore === 'HIGH') score -= 50; // High risk
      }

      if (holdersData) {
        // If top holder has more than 50% supply, flag it
        if (holdersData.topHolderPercentage > 50) {
          console.warn(`[Scout] 🚨 Top holder owns ${holdersData.topHolderPercentage}% of supply!`);
          score -= 40;
        } else if (holdersData.topHolderPercentage < 20 && holdersData.totalHolders > 10) {
          score += 20; // Healthy distribution
        }
      }

      console.log(`[Scout] Calculated composite score: ${score}/100`);

      // 4. Threshold evaluation
      if (score >= 70) {
        console.log(`[Scout] ✅ Token ${tokenAddress} PASSED! Emitting signal...`);
        if (this.onSignal) {
          this.onSignal(tokenAddress);
        }
      } else {
        console.log(`[Scout] ❌ Token ${tokenAddress} REJECTED. Score too low.`);
      }

    } catch (error) {
      console.error(`[Scout] Error during scoring for ${tokenAddress}:`, error);
    }
  }
}
