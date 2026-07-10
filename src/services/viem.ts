import { createPublicClient, http, defineChain } from 'viem';
import * as dotenv from "dotenv";

dotenv.config();

const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

// Define custom Robinhood Chain configuration
export const robinhoodChain = defineChain({
  id: 4663, // Placeholder chain ID, adjust if necessary
  name: 'Robinhood Chain',
  network: 'robinhood',
  nativeCurrency: {
    decimals: 18,
    name: 'Robinhood',
    symbol: 'RHD', // Using RHD or native gas token for Robinhood
  },
  rpcUrls: {
    default: {
      http: [rpcUrl],
    },
    public: {
      http: [rpcUrl],
    },
  },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(),
});

console.log("🔌 Viem Client: Connected to Robinhood Chain RPC");
