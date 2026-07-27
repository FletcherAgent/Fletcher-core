import { type Address, type Hex, parseAbi, createWalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prisma } from '../core/db.js';
import { createMultiOwnerLightAccount } from "@alchemy/aa-accounts";
import { LocalAccountSigner, createSmartAccountClient } from "@alchemy/aa-core";
import { alchemyGasManagerMiddleware } from "@alchemy/aa-alchemy";
import { http, createPublicClient, parseEther } from "viem";
import { privateKeyToAccount as ethPrivToAccount } from 'viem/accounts';

/**
 * Initialize Alchemy Smart Account Client (MultiOwnerLightAccount)
 */
import { getTierLimits } from "./tierGate.js";

export async function createSmartAccount(privateKeyHex: Hex, tier: number, accountAddress?: Address, selfFunded = false, owners?: Address[], salt?: bigint) {
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
    factoryAddress: '0x000000000019d2Ee9F2729A65AfE20bb0020AefC' as `0x${string}`, // Default MultiOwnerLightAccount v2.0.0 factory
  };
  if (accountAddress) {
    accountParams.accountAddress = accountAddress;
  } else if (owners) {
    accountParams.owners = owners;
    if (salt !== undefined) accountParams.salt = salt;
  }

  const account = await createMultiOwnerLightAccount(accountParams);
  
  const limits = getTierLimits(tier);

  const publicClient = createPublicClient({ transport: transport as any, chain: robinhoodChain });

  // selfFunded = true: no paymaster middleware (used for LP ops to avoid policy restrictions)
  const alchemyClient = createSmartAccountClient({
    transport: transport as any,
    chain: robinhoodChain,
    account,
    ...(!selfFunded && process.env.ALCHEMY_GAS_POLICY_ID && limits.sponsoredGas
      ? alchemyGasManagerMiddleware(
          publicClient as any,
          {
            policyId: process.env.ALCHEMY_GAS_POLICY_ID,
            paymasterAddress: '0x4Fd9098af9ddcB41DA48A1d78F91F1398965addc' as `0x${string}`,
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
 * Session Key functionality is natively handled by MultiOwnerLightAccount now.
 * The backend admin acts as a co-owner, and we no longer need the ERC-6900 session key plugin.
 */
export async function installSessionKeyPluginAndDelegate(tier: number) {
  console.log(`[SessionKey] Skipping Modular Account plugin installation (Using LightAccount)`);
}

export type UserOpCall = {
  target: Address;
  data: Hex;
  value?: bigint;
};

/**
 * Ensure the smart account has enough ETH for gas.
 * If not, transfers from the EOA signer (PRIVATE_KEY env).
 */
export async function ensureSmartAccountFunded(
  accountAddress: Address,
  minEth: bigint = parseEther('0.005')
): Promise<void> {
  const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  const chain = {
    id: 4663, name: 'Robinhood',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  } as any;

  const publicC = createPublicClient({ transport: http(rpcUrl), chain });
  const balance = await publicC.getBalance({ address: accountAddress });
  
  if (balance >= minEth) {
    console.log(`[SessionKey] Smart account ETH sufficient: ${Number(balance)/1e18} ETH`);
    return;
  }

  const eoaKey = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
  if (!eoaKey) throw new Error('[SessionKey] PRIVATE_KEY or LP_PRIVATE_KEY not set — cannot fund smart account');

  const eoaAccount = ethPrivToAccount(eoaKey);
  const walletC = createWalletClient({ account: eoaAccount, transport: http(rpcUrl), chain });
  const needed = minEth - balance;
  console.log(`[SessionKey] 💸 Funding smart account with ${Number(needed)/1e18} ETH for gas...`);
  const hash = await walletC.sendTransaction({ to: accountAddress, value: needed, chain });
  await publicC.waitForTransactionReceipt({ hash });
  console.log(`[SessionKey] ✅ Funded! Tx: ${hash}`);
}

/**
 * Build and Send a UserOperation for LP actions.
 * Uses self-funded mode (no paymaster) to avoid Alchemy policy restrictions.
 * Bypasses eth_estimateUserOperationGas (which fails on approve+swap batches)
 * by using empirically-validated gas limits.
 */
export async function buildAndSendLPUserOperation(client: any, calls: UserOpCall[]): Promise<string> {
  if (process.env.DEBUG_RETURN_CALLS === 'true') {
    (global as any).__capturedCalls = calls;
    return "0x_mocked_tx_hash_to_bypass";
  }

  const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
  const tradingMode = config?.value || 'LIVE';

  if (tradingMode === 'DRY_RUN') {
    console.log("[Alchemy DRY_RUN] Simulating UserOperation calls:");
    calls.forEach((c, i) => console.log(`  [${i}] Target: ${c.target} | Data: ${c.data.substring(0, 15)}...`));
    return `0xSimulatedTxHash_${Date.now()}` as Hex;
  }

  const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

  // Fetch bundler's recommended priority fee and use 3× for fast inclusion
  let maxPriorityFeePerGas: bigint;
  try {
    const feeResp = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'rundler_maxPriorityFeePerGas', params: [], id: 1 })
    });
    const feeJson = await feeResp.json();
    maxPriorityFeePerGas = BigInt(feeJson.result || '0x507159') * 3n;
  } catch {
    maxPriorityFeePerGas = 16000000n; // fallback ~0.016 gwei
  }
  const maxFeePerGas = 200000000n + maxPriorityFeePerGas; // ~0.2 gwei base

  // Get current account nonce from EntryPoint
  const nonceResp = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'eth_call',
      params: [{
        to: ENTRY_POINT,
        data: '0x35567e1a' + // getNonce(address,uint192)
          client.account.address.toLowerCase().slice(2).padStart(64, '0') +
          '0'.repeat(64)
      }, 'latest'],
      id: 1
    })
  });
  const nonceJson = await nonceResp.json();
  const nonce = BigInt(nonceJson.result || '0x0');


  // Prefer encodeBatchExecute for multiple calls
  let encodedCallData: Hex;
  if (calls.length === 1) {
    encodedCallData = await client.account.encodeExecute({
      target: calls[0].target,
      data: calls[0].data,
      value: calls[0].value ?? 0n,
    });
  } else {
    encodedCallData = await client.account.encodeBatchExecute(
      calls.map(c => ({ target: c.target, data: c.data, value: c.value ?? 0n }))
    );
  }

  // Check if account is deployed
  const codeResp = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [client.account.address, 'latest'], id: 1 })
  });
  const codeJson = await codeResp.json();
  const isDeployed = codeJson.result && codeJson.result !== '0x';
  const initCode: Hex = isDeployed ? '0x' : (await client.account.getInitCode() as Hex);

  // Empirically-validated gas limits for LP operations (approve+swap+approveNPM+approveToken+mint)
  // Measured from successful on-chain execution. Using 2× headroom for safety.
  const callGasLimit    = 0x150000n; // ~1.37M (plenty for swap)
  const verifGasLimit   = 0x1B000n;  // ~110k (forces efficiency ratio to ~0.44, above the 0.4 requirement)
  const preVerifGas     = 0x20000n;  // ~131k

  const userOp = {
    sender:                 client.account.address as `0x${string}`,
    nonce:                  `0x${nonce.toString(16)}` as `0x${string}`,
    initCode:               initCode,
    callData:               encodedCallData,
    callGasLimit:           `0x${callGasLimit.toString(16)}` as `0x${string}`,
    verificationGasLimit:   `0x${verifGasLimit.toString(16)}` as `0x${string}`,
    preVerificationGas:     `0x${preVerifGas.toString(16)}` as `0x${string}`,
    maxFeePerGas:           `0x${maxFeePerGas.toString(16)}` as `0x${string}`,
    maxPriorityFeePerGas:   `0x${maxPriorityFeePerGas.toString(16)}` as `0x${string}`,
    paymasterAndData:       '0x' as `0x${string}`,
    signature:              '0x' as `0x${string}`,
  };

  // Sign the UserOp
  const signedUO = await client.signUserOperation({ uoStruct: userOp });

  console.log(`[Alchemy] Sending UserOp: nonce=${nonce}, callGas=0x${callGasLimit.toString(16)}, prio=${maxPriorityFeePerGas}`);

  // Send directly via RPC (self-funded, no paymaster)
  const sendResp = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_sendUserOperation', params: [signedUO, ENTRY_POINT], id: 1 })
  });
  const sendJson = await sendResp.json();
  if (sendJson.error) throw new Error(`[Alchemy] UserOp send failed: ${JSON.stringify(sendJson.error)}`);

  const uoHash: Hex = sendJson.result;
  console.log(`[Alchemy] UserOp submitted. Hash: ${uoHash}`);

  // Poll for receipt with 3-minute timeout
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const rcptResp = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getUserOperationReceipt', params: [uoHash], id: 1 })
    });
    const rcpt = await rcptResp.json();
    if (rcpt.result) {
      const txHash: Hex = rcpt.result.receipt?.transactionHash;
      if (!rcpt.result.success) throw new Error(`[Alchemy] UserOp reverted on-chain. Tx: ${txHash}`);
      console.log(`[Alchemy] UserOp mined! Tx Hash: ${txHash}`);
      return txHash;
    }
  }
  throw new Error('UserOperation Bundler timeout (dropped by mempool)');
}

/**
 * Get a Smart Account Client authorized by the MAIN PRIVATE KEY directly.
 * Bypasses Session Key plugins.
 */
export async function getMainAccountClient(tier: number, selfFunded = false) {
  const pk = process.env.LP_PRIVATE_KEY;
  if (!pk) throw new Error("LP_PRIVATE_KEY not set");
  return await createSmartAccount(pk as `0x${string}`, tier, undefined, selfFunded);
}

export async function getSessionKeyClient(modeRequired: 'SEMI' | 'FULL', tier: number, selfFunded = false, userWalletAddress?: string) {
  const pk = process.env.LP_PRIVATE_KEY;
  if (!pk) throw new Error("LP_PRIVATE_KEY not set");
  
  let accountAddress: `0x${string}` | undefined;
  if (userWalletAddress) {
    const agent = await prisma.agent.findFirst({ 
      where: { user: { walletAddress: userWalletAddress } } 
    });
    if (agent?.smartAccountAddress) {
      accountAddress = agent.smartAccountAddress as `0x${string}`;
    } else {
      // Fallback: If not in DB, recompute it with userWalletAddress as salt.
      const adminAddress = ethPrivToAccount(pk as `0x${string}`).address;
      return await createSmartAccount(
        pk as `0x${string}`, 
        tier, 
        undefined, 
        selfFunded, 
        [userWalletAddress as `0x${string}`, adminAddress],
        BigInt(userWalletAddress)
      );
    }
  }
  
  return await createSmartAccount(pk as `0x${string}`, tier, accountAddress, selfFunded);
}
