import { createPublicClient, createWalletClient, http, webSocket, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as dotenv from "dotenv";

dotenv.config();

const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const wssUrl = process.env.ROBINHOOD_WSS_URL || 'wss://rpc.mainnet.chain.robinhood.com';

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
      webSocket: [wssUrl]
    },
    public: {
      http: [rpcUrl],
      webSocket: [wssUrl]
    },
  },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(rpcUrl),
});

export const wssClient = createPublicClient({
  chain: robinhoodChain,
  transport: webSocket(wssUrl),
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
