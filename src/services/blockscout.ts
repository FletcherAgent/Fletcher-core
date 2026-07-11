import * as dotenv from "dotenv";

dotenv.config();

export class BlockscoutService {
  private baseUrl = process.env.BLOCKSCOUT_API_URL || 'https://explorer.mainnet.chain.robinhood.com/api';
  private apiKey = process.env.BLOCKSCOUT_API_KEY || '';

  /**
   * Fetch transaction history from the deployer's address.
   * Aims to check if this deployer has frequently created rugpull tokens before.
   */
  public async getDeployerHistory(address: string) {
    try {
      console.log(`[Blockscout] Fetching history for deployer: ${address}`);
      const url = new URL(`${this.baseUrl}/v2/addresses/${address}/transactions`);
      if (this.apiKey) url.searchParams.append('apikey', this.apiKey);
      
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Blockscout API failed: ${response.status}`);
      }
      const data = await response.json();
      const txCount = data.items?.length || 0;
      
      // We assume contract creation txs might not be easily filtered without deep parsing,
      // so we use txCount as a proxy for activity level.
      let riskScore = "LOW";
      if (txCount > 200) riskScore = "HIGH";
      else if (txCount < 5) riskScore = "MEDIUM"; // Too new, slightly risky

      return {
        totalTokensDeployed: txCount, // Proxy value
        riskScore
      };
    } catch (error) {
      console.error("[Blockscout] Failed to fetch deployer history", error);
      return null;
    }
  }

  /**
   * Fetch holder distribution data for a token.
   * Ensures no single wallet holds an unnatural percentage of tokens.
   */
  public async getTokenHolders(tokenAddress: string) {
    try {
      console.log(`[Blockscout] Analyzing holder distribution for: ${tokenAddress}`);
      const url = new URL(`${this.baseUrl}/v2/tokens/${tokenAddress}/holders`);
      if (this.apiKey) url.searchParams.append('apikey', this.apiKey);
      
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Blockscout API failed: ${response.status}`);
      }
      
      const data = await response.json();
      const holders = data.items || [];
      const totalHolders = holders.length;
      
      let topHolderPercentage = 0;
      if (totalHolders > 0) {
        // Find the holder with the largest amount (assuming sorted, or we sort it)
        const sortedHolders = holders.sort((a: any, b: any) => Number(b.value) - Number(a.value));
        
        // Sum total supply (if provided, else approximate by sum of top 50 holders)
        // Blockscout v2 /holders sometimes returns percentage directly if supply is known
        if (sortedHolders[0].percentage) {
          topHolderPercentage = Number(sortedHolders[0].percentage);
        } else {
          // Fallback, we might not have total supply easily, we just take the first item
          // This is a naive fallback if the API doesn't give percentages.
          topHolderPercentage = 100; // Force a fail or handle appropriately
        }
      }

      return {
        topHolderPercentage,
        totalHolders
      };
    } catch (error) {
      console.error("[Blockscout] Failed to fetch holder data", error);
      return null;
    }
  }
}
