import { encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as dotenv from 'dotenv';
dotenv.config();
const REPUTATION_REGISTRY_ADDRESS = process.env.REPUTATION_REGISTRY_ADDRESS;
const ORACLE_PRIVATE_KEY = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY);
const reputationAbi = parseAbi([
    'function recordPerformance(uint256 agentId, int256 profitUsd, int256 pnl, bool isWin, bytes signature) external'
]);
export async function buildReputationCall(agentId, erc8004Id, profitUsd, pnlPercentage) {
    if (!REPUTATION_REGISTRY_ADDRESS || !ORACLE_PRIVATE_KEY) {
        console.warn(`[Reputation] Missing REPUTATION_REGISTRY_ADDRESS or private key. Skipping reputation.`);
        return null;
    }
    if (!erc8004Id) {
        console.warn(`[Reputation] Agent ${agentId} has no ERC8004 ID. Skipping reputation.`);
        return null;
    }
    const account = privateKeyToAccount(ORACLE_PRIVATE_KEY);
    const idNum = BigInt(erc8004Id);
    const profitInt = BigInt(Math.floor(profitUsd * 100)); // Scale to cents
    const pnlInt = BigInt(Math.floor(pnlPercentage * 100)); // Scale by 100 (e.g. 5.5% -> 550)
    const isWin = profitUsd > 0;
    // We need the nonce. Since fetching the nonce is async and might race,
    // we could just use a timestamp as nonce, but the contract uses a strict counter.
    // We need to read the nonce from the chain.
    const { publicClient } = await import('../services/viem.js');
    let currentNonce = 0n;
    try {
        currentNonce = await publicClient.readContract({
            address: REPUTATION_REGISTRY_ADDRESS,
            abi: parseAbi(['function nonces(uint256) view returns (uint256)']),
            functionName: 'nonces',
            args: [idNum]
        });
    }
    catch (e) {
        console.error(`[Reputation] Failed to read nonce for agent ${idNum}:`, e);
        return null;
    }
    // Contract expects: keccak256(abi.encodePacked(agentId, profitUsd, pnl, isWin, currentNonce, address(this)))
    // But viem's signMessage handles the Ethereum Signed Message prefix.
    // We need to construct the raw message hash.
    const { keccak256, encodePacked } = await import('viem');
    const messageHash = keccak256(encodePacked(['uint256', 'int256', 'int256', 'bool', 'uint256', 'address'], [idNum, profitInt, pnlInt, isWin, currentNonce, REPUTATION_REGISTRY_ADDRESS]));
    // EIP-191 signature
    const signature = await account.signMessage({ message: { raw: messageHash } });
    const data = encodeFunctionData({
        abi: reputationAbi,
        functionName: 'recordPerformance',
        args: [idNum, profitInt, pnlInt, isWin, signature]
    });
    return { target: REPUTATION_REGISTRY_ADDRESS, data };
}
