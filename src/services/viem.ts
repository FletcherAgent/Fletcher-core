import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
    name: 'Ether',
    symbol: 'ETH',
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

export const account = process.env.PRIVATE_KEY 
  ? privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`) 
  : null;

export const walletClient = account ? createWalletClient({
  account,
  chain: robinhoodChain,
  transport: http(),
}) : null;

console.log("🔌 Viem Client: Connected to Robinhood Chain RPC");
if (walletClient) {
  console.log("🔐 Wallet Client: Auto-Trading Enabled (Private Key Loaded)");
} else {
  console.warn("⚠️ Wallet Client: PRIVATE_KEY missing! Auto-trading disabled.");
}
