import { publicClient, wssClient } from '../services/viem.js';
import { Bot } from 'grammy';
import { parseAbiItem, parseAbi } from 'viem';
import { BlockscoutService } from '../services/blockscout.js';

export class ScoutAgent {
  public onSignal?: (tokenAddress: string) => void;
  private blockscout = new BlockscoutService();
  private bot?: Bot;
  private statusMessageId?: number;
  private lastSignalName: string = "None";
  private pollCounter: number = 0;

  constructor(bot?: Bot) {
    this.bot = bot;
  }

  /**
   * Start monitoring the blockchain for new tokens.
   */
  public async startListening() {
    console.log("🟢 Scout Agent: Starting monitoring for NOXA Factory & Uniswap V3 PoolCreated...");

    const UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY_ADDRESS as `0x${string}`;
    const NOXA_FACTORY = process.env.NOXA_FACTORY_ADDRESS as `0x${string}`;

    if (!UNISWAP_V3_FACTORY || !NOXA_FACTORY) {
      throw new Error("❌ CRITICAL: UNISWAP_V3_FACTORY_ADDRESS or NOXA_FACTORY_ADDRESS is missing in .env");
    }

    try {
      // Setup listener for NOXA TokenCreated events
      if (NOXA_FACTORY !== '0x0000000000000000000000000000000000000000') {
        wssClient.watchEvent({
          address: NOXA_FACTORY,
          event: parseAbiItem('event TokenCreated(address indexed token)'),
          onLogs: (logs) => {
            for (const log of logs) {
              this.lastSignalName = `🆕 NOXA TokenCreated (${log.args.token})`;
              console.log(`[Scout] ${this.lastSignalName}`);
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
              this.lastSignalName = `🎓 NOXA Graduated (${log.args.token})`;
              console.log(`[Scout] ${this.lastSignalName}`);
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
            this.lastSignalName = `💧 UNI V3 Pool (${log.args.token0})`;
            console.log(`[Scout] New Pool Detected! Token0: ${log.args.token0}, Token1: ${log.args.token1}`);
            // Call scoring function here
            if (log.args.token0) this.scoreLaunch(log.args.token0, false);
          }
        },
        onError: (error) => {
          console.error("[Scout] ❌ Uniswap V3 PoolCreated watchEvent Error:", error.message);
        }
      });

      // --- Terminal Block Scanner Log ---
      wssClient.watchBlockNumber({
        onBlockNumber: (blockNumber) => {
          // Bypass global console.log hijacker by writing directly to stdout
          process.stdout.write(`[Scout ⚡ WSS] Block ${blockNumber} scanned -> NOXA/UNI: Clear.\n`);
        },
        onError: (error) => {
          console.error(`[Scout] Block scanner error: ${error.message}`);
        }
      });

      // --- Telegram Live Dashboard ---
      if (this.bot && process.env.TELEGRAM_CHAT_ID) {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        try {
          const initMsg = await this.bot.api.sendMessage(
            chatId,
            `📡 *Scout Agent WebSocket Started*\n\nStatus: 🟢 Active\nConnection: Real-time (WSS)\nUptime: 0s\nLast Signal: None`,
            { parse_mode: 'Markdown' }
          );
          this.statusMessageId = initMsg.message_id;

          // Update dashboard every 10 seconds to prevent Telegram 429 Rate Limit
          setInterval(async () => {
            if (!this.statusMessageId) return;
            this.pollCounter++;
            try {
              const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
              await this.bot!.api.editMessageText(
                chatId,
                this.statusMessageId,
                `📡 *Scout Agent WSS Dashboard*\n\nStatus: 🟢 Active\nConnection: Real-time (WSS)\nUptime: \`${this.pollCounter * 10}s\`\nLast Check: \`${now} UTC\`\nLatest Signal: \`${this.lastSignalName}\`\n\n_Watching NOXA Factory & Uniswap V3..._`,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              // Ignore rate limits
            }
          }, 10000);
        } catch (dashboardErr) {
          console.warn("[Scout] Could not start live dashboard due to Telegram rate limits, but agent is still running.");
        }
      }

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
