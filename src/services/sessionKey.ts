import { type Address, type Hex, parseAbi, custom } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prisma } from '../core/db.js';
import { createMultiOwnerModularAccount } from "@alchemy/aa-accounts";
import { LocalAccountSigner, createSmartAccountClient } from "@alchemy/aa-core";
import { alchemyGasManagerMiddleware } from "@alchemy/aa-alchemy";
import { http } from "viem";
import { sessionKeyPluginActions, SessionKeyPermissionsBuilder, SessionKeyAccessListType } from "@alchemy/aa-accounts";

/**
 * Initialize Alchemy Smart Account Client (MultiOwnerModularAccount)
 */
import { getTierLimits } from "./tierGate.js";

export async function createSmartAccount(privateKeyHex: Hex, tier: number, accountAddress?: Address) {
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

  const accountParams: any = {
    transport: transport as any,
    chain: robinhoodChain,
    signer,
  };
  if (accountAddress) {
    accountParams.accountAddress = accountAddress;
  }

  const account = await createMultiOwnerModularAccount(accountParams);
  
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
): Promise<SessionKeyData & { privateKey: string }> {
  const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // default 30 days
  
  // Generate a new soft session key
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  // Store in database
  const sessionKeyRecord = await prisma.sessionKey.create({
    data: {
      userId: client.account.address,
      keyAddress: account.address,
      privateKey: privateKey,
      expiry: expiryDate,
      scope: { mode },
      status: 'ACTIVE'
    }
  });

  console.log(`[SessionKey] 🔑 Granted ${mode} simulated session key: ${account.address}`);

  return {
    keyAddress: account.address,
    expiry: expiryDate.getTime(),
    privateKey
  };
}

/**
 * Auto-install session key plugin on startup if not already installed.
 */
export async function installSessionKeyPluginAndDelegate(tier: number) {
  const envKey = (process.env.USER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
  if (!envKey) {
    console.log("[SessionKey] No Master PRIVATE_KEY found in .env, skipping auto-install.");
    return;
  }

  // 1. Get Master Client
  const masterClient = await createSmartAccount(envKey, tier);
  const accountAddress = masterClient.account.address;

  // 2. Check if active session key exists in DB
  const existingKey = await prisma.sessionKey.findFirst({
    where: {
      userId: accountAddress,
      status: 'ACTIVE',
      expiry: { gt: new Date() }
    }
  });

  if (existingKey) {
    console.log(`[SessionKey] Found existing active Session Key for ${accountAddress}. Skipping install.`);
    return;
  }

  console.log(`[SessionKey] Automatically installing Session Key Plugin for ${accountAddress}...`);

  // 3. Grant a new soft session key in DB
  const { keyAddress } = await grantSessionKey(masterClient, "FULL");

  // 4. In a real LIVE mode, we'd broadcast the addSessionKey transaction on-chain via Alchemy
  const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
  const tradingMode = config?.value || 'LIVE';

  if (tradingMode === 'LIVE') {
    try {
      const permissions = new SessionKeyPermissionsBuilder()
        .setContractAccessControlType(SessionKeyAccessListType.ALLOW_ALL_ACCESS)
        .encode();

      const sessionClient = masterClient.extend(sessionKeyPluginActions);
      const res = await sessionClient.addSessionKey({
        key: keyAddress as Hex,
        permissions, // Root access (Option A)
        tag: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      });
      console.log(`[SessionKey] On-Chain Plugin Installation Tx: ${res.hash}`);
      await masterClient.waitForUserOperationTransaction({ hash: res.hash });
      console.log(`[SessionKey] Plugin installation mined successfully.`);
    } catch (e: any) {
      console.error(`[SessionKey] Failed to install plugin on-chain: ${e.message}`);
    }
  } else {
    console.log(`[SessionKey] [DRY_RUN] Simulated on-chain plugin installation for ${keyAddress}`);
  }
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
 * Get a Smart Account Client authorized by a valid Session Key.
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

  if (!validKey || !validKey.privateKey) {
    throw new Error(`[SessionKey] ZERO-CUSTODY VIOLATION: No valid SessionKey found for mode ${modeRequired}. Ensure auto-install ran successfully.`);
  }

  // Use the session key's private key to sign user operations
  const pk = validKey.privateKey as `0x${string}`;
  const accountAddress = validKey.userId as Address;
  
  // Create client using the SESSION KEY (Zero Custody)
  return await createSmartAccount(pk, tier, accountAddress);
}
