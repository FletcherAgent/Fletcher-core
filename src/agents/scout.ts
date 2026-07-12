import { publicClient, wssClient } from '../services/viem.js';
import { parseAbiItem, parseAbi } from 'viem';
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
    const NOXA_FACTORY = (process.env.NOXA_FACTORY_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;

    try {
      // Setup listener for NOXA TokenCreated events (Mock ABI)
      if (NOXA_FACTORY !== '0x0000000000000000000000000000000000000000') {
        wssClient.watchEvent({
          address: NOXA_FACTORY,
          event: parseAbiItem('event TokenCreated(address indexed token)'),
          onLogs: (logs) => {
            for (const log of logs) {
              console.log(`[Scout] 🆕 NOXA TokenCreated Detected! Token: ${log.args.token}`);
              if (log.args.token) this.scoreLaunch(log.args.token, false);
            }
          },
          onError: (error) => {
            console.error("[Scout] ❌ NOXA TokenCreated watchEvent Error:", error.message);
          }
        });

        // Setup listener for NOXA TokenGraduated events
        wssClient.watchEvent({
          address: NOXA_FACTORY,
          event: parseAbiItem('event TokenGraduated(address indexed token)'),
          onLogs: (logs) => {
            for (const log of logs) {
              console.log(`[Scout] 🎓 NOXA TokenGraduated Detected! Token: ${log.args.token}`);
              if (log.args.token) this.scoreLaunch(log.args.token, true);
            }
          },
          onError: (error) => {
            console.error("[Scout] ❌ NOXA TokenGraduated watchEvent Error:", error.message);
          }
        });
      }

      // Setup listener for PoolCreated events (Uniswap V3)
      wssClient.watchEvent({
        address: UNISWAP_V3_FACTORY,
        event: parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool)'),
        onLogs: (logs) => {
          for (const log of logs) {
            console.log(`[Scout] New Pool Detected! Token0: ${log.args.token0}, Token1: ${log.args.token1}`);
            // Call scoring function here
            if (log.args.token0) this.scoreLaunch(log.args.token0, false);
          }
        },
        onError: (error) => {
          console.error("[Scout] ❌ Uniswap V3 PoolCreated watchEvent Error:", error.message);
        }
      });
    } catch (error) {
      console.error("🔴 Scout Agent: Failed to start watchEvent", error);
    }
  }

  private async checkLiquidityLock(tokenAddress: string): Promise<boolean> {
    console.log(`[Scout] 🔒 Checking if token supply is burned to Dead Address for ${tokenAddress}...`);
    try {
      const deadAddress = '0x000000000000000000000000000000000000dEaD';
      const balance = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [deadAddress]
      });

      if (balance > 0n) {
        console.log(`[Scout] ✅ Liquidity/Tokens burned detected: ${balance.toString()}`);
        return true;
      }
      
      console.warn(`[Scout] ⚠️ No tokens burned to dead address.`);
      return false;
    } catch (e) {
      console.error(`[Scout] ❌ Failed to check dead address balance`, e);
      return false;
    }
  }



  private async scoreLaunch(tokenAddress: string, isGraduated: boolean = false) {
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

      // 3. Security Checks (Liquidity Lock)
      const isLocked = await this.checkLiquidityLock(tokenAddress);

      // 4. Composite Heuristic Score
      let score = 50;

      // Graduation bonus
      if (isGraduated) {
        console.log(`[Scout] 🎓 Token is Graduated. Applying massive conviction bonus.`);
        score += 30;
      }

      if (!isLocked) {
        console.warn(`[Scout] 🚨 Liquidity is not locked! Instant fail.`);
        score -= 100;
      }
      
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
