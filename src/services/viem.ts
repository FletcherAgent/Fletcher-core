import { createPublicClient, createWalletClient, http, defineChain, webSocket } from 'viem';
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
  transport: http(rpcUrl, {
    batch: true,
    onFetchResponse: (res) => {
      if (res.status === 429) {
        console.warn(`[Viem] 🚨 RPC RATE LIMIT REACHED (HTTP 429 Too Many Requests) on publicClient! Alchemy limit exceeded.`);
      }
    }
  }),
  // TODO: Once you upgrade to a premium RPC (like Alchemy), remove or reduce this interval (default is 4000)
  // so the Scout agent can detect events much faster (real-time).
  pollingInterval: 15_000,
});

const wssUrl = process.env.ROBINHOOD_WSS_URL;
const isWs = wssUrl && (wssUrl.startsWith('ws://') || wssUrl.startsWith('wss://'));

export const wssClient = createPublicClient({
  chain: robinhoodChain,
  transport: isWs ? webSocket(wssUrl, {
    keepAlive: true,
    reconnect: true,
  }) : http(rpcUrl, {
    onFetchResponse: (res) => {
      if (res.status === 429) {
        console.warn(`[Viem] 🚨 RPC RATE LIMIT REACHED (HTTP 429 Too Many Requests) on wssClient fallback!`);
      }
    }
  }),
  // TODO: Same as above. If using a premium RPC or true WSS, remove this pollingInterval.
  pollingInterval: 15_000,
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
