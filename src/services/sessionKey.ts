import { type Address, type Hex, parseAbi, custom } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
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
 * This generates a soft session key (local wallet) and stores it in the database.
 * In a native ERC-6900 implementation, this would also broadcast a UserOp to install the plugin.
 */
export async function grantSessionKey(
  client: any, 
  mode: "SEMI" | "FULL",
  swapScope: boolean = false
): Promise<SessionKeyData> {
  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // default 24 hours
  
  // Generate a new soft session key
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  // Store in database
  const sessionKeyRecord = await prisma.sessionKey.create({
    data: {
      userId: client.account.address,
      keyAddress: account.address,
      expiry: expiryDate,
      scope: { mode },
      status: 'ACTIVE'
    }
  });

  console.log(`[SessionKey] 🔑 Granted ${mode} simulated session key: ${account.address}`);

  return {
    keyAddress: account.address,
    expiry: expiryDate.getTime()
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
  const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
  const tradingMode = config?.value || 'LIVE';

  if (tradingMode === 'DRY_RUN') {
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

/**
 * Get a Smart Account Client authorized by a valid simulated Session Key.
 * For this simulated version, it verifies the session key exists and is valid in DB,
 * then returns a client signed by the master PRIVATE_KEY (since we aren't using the on-chain plugin yet).
 */
export async function getSessionKeyClient(modeRequired: 'SEMI' | 'FULL', tier: number) {
  // Check for active session key in the database
  const validKeys = await prisma.sessionKey.findMany({
    where: {
      status: 'ACTIVE',
      expiry: { gt: new Date() }
    }
  });

  const validKey = validKeys.find(k => {
    const scope = k.scope as any;
    return scope && (scope.mode === modeRequired || scope.mode === 'FULL');
  });

  if (!validKey) {
    throw new Error(`No valid SessionKey found for mode ${modeRequired}`);
  }

  // Simulated: We use the master PRIVATE_KEY to act on behalf of the smart account
  const pk = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
  if (!pk) throw new Error('PRIVATE_KEY not found in .env');
  
  return await createSmartAccount(pk, tier);
}
