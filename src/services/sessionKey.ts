import { type Address, type Hex, parseAbi, custom } from 'viem';
import { prisma } from '../core/db.js';
import { createMultiOwnerModularAccount } from "@alchemy/aa-accounts";
import { LocalAccountSigner, createSmartAccountClient } from "@alchemy/aa-core";
import { alchemyGasManagerMiddleware } from "@alchemy/aa-alchemy";
import { http } from "viem";



/**
 * Initialize Alchemy Smart Account Client (MultiOwnerModularAccount)
 */
import { getTierLimits } from "./tierGate.js";

export async function createSmartAccount(privateKeyHex: Hex, tier: number) {
  if (!process.env.ALCHEMY_API_KEY) throw new Error("Missing ALCHEMY_API_KEY");
  
  const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  
  const robinhoodChain = {
    id: 4663, 
    name: 'Robinhood',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'] },
      alchemy: { http: [rpcUrl] }
    }
  } as any;

  const signer = LocalAccountSigner.privateKeyToAccountSigner(privateKeyHex);
  const transport = http(rpcUrl);

  const account = await createMultiOwnerModularAccount({
    transport: transport as any,
    chain: robinhoodChain,
    signer,
  });
  
  const limits = getTierLimits(tier);

  const alchemyClient = createSmartAccountClient({
    transport: transport as any,
    chain: robinhoodChain,
    account,
    ...(process.env.ALCHEMY_GAS_POLICY_ID && limits.sponsoredGas
      ? alchemyGasManagerMiddleware(
          { transport: transport as any, chain: robinhoodChain } as any,
          {
            policyId: process.env.ALCHEMY_GAS_POLICY_ID,
          }
        )
      : {}),
  });

  return alchemyClient;
}

export type SessionKeyData = {
  keyAddress: string;
  expiry: number;
};

/**
 * Grant a Session Key for the user's Smart Account
 * For now, this is a placeholder that returns a dummy session key.
 * In a full production environment, this would sign a UserOp to add a session key plugin.
 */
export async function grantSessionKey(
  client: any, 
  mode: "SEMI" | "FULL",
  swapScope: boolean = false
): Promise<SessionKeyData> {
  const expiry = Date.now() + 24 * 60 * 60 * 1000; // default 24 hours
  // Dummy return to simulate session key creation
  return {
    keyAddress: "0xSessionKeySimulated..." as Hex,
    expiry
  };
}

export type UserOpCall = {
  target: Address;
  data: Hex;
  value?: bigint;
};

/**
 * Build and Send a UserOperation for LP actions
 */
export async function buildAndSendLPUserOperation(
  client: any,
  calls: UserOpCall[]
): Promise<Hex> {
  if (process.env.TRADING_MODE === 'DRY_RUN') {
    console.log("[Alchemy DRY_RUN] Simulating UserOperation calls:");
    calls.forEach((c, i) => console.log(`  [${i}] Target: ${c.target} | Data: ${c.data.substring(0, 15)}...`));
    return `0xSimulatedTxHash_${Date.now()}` as Hex;
  }

  // Convert to alchemy's SendUserOperationParams
  const userOpResult = await client.sendUserOperation({
    uo: calls.map(c => ({
      target: c.target,
      data: c.data,
      value: c.value ?? 0n,
    }))
  });

  console.log(`[Alchemy] UserOp submitted. Hash: ${userOpResult.hash}`);
  
  // Wait for the tx to be mined
  const txHash = await client.waitForUserOperationTransaction({
    hash: userOpResult.hash,
  });
  
  console.log(`[Alchemy] UserOp mined! Tx Hash: ${txHash}`);
  return txHash;
}
