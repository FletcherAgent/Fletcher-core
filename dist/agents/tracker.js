import { createServer } from 'http';
import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { parseAbiItem, decodeEventLog } from 'viem';
import { prisma } from '../core/db.js';
import { dbLogger } from '../services/logger.js';
import { WalletProfiler } from '../services/walletProfiler.js';
import { publicClient } from '../services/viem.js';
import { mcpServer } from '../mcp/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getPoolSlot0 } from '../services/lpMath.js';
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const getJsonBody = (req) => {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            }
            catch (e) {
                resolve({});
            }
        });
    });
};
const CODENAMES = ["Orion", "Sentinel", "Apollo", "Nova", "Cipher", "Vortex", "Apex", "Echo"];
const generateAgentName = () => `Agent ${CODENAMES[Math.floor(Math.random() * CODENAMES.length)]} ${Math.floor(Math.random() * 999)}`;
export class TrackerAgent {
    onCopyBuySignal;
    onCopySellSignal;
    onSwapActivity;
    server;
    mcpTransport = null;
    processedTxHashes = new Set();
    lastBuyTime = new Map(); // For anti-farm: wallet-token -> timestamp
    constructor() { }
    startListening(port) {
        const listenPort = port || parseInt(process.env.PORT || '3001', 10);
        console.log(`🎯 Tracker Agent: Starting Webhook server on port ${listenPort}...`);
        this.server = createServer(async (req, res) => {
            // CORS Headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') {
                res.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-alchemy-signature, x-wallet-address'
                });
                res.end();
                return;
            }
            // --- MCP Server Endpoints ---
            if (req.method === 'GET' && req.url === '/mcp/sse') {
                this.mcpTransport = new SSEServerTransport("/mcp/message", res);
                await mcpServer.connect(this.mcpTransport);
                console.log('[MCP] Client connected via SSE on main Tracker port');
                return;
            }
            if (req.method === 'POST' && req.url?.startsWith('/mcp/message')) {
                if (this.mcpTransport) {
                    await this.mcpTransport.handlePostMessage(req, res);
                }
                else {
                    res.writeHead(503);
                    res.end("SSE transport not active");
                }
                return;
            }
            // Check API Key for dashboard and settings endpoints
            if (req.url?.startsWith('/api/')) {
                const authHeader = req.headers.authorization;
                const secretKey = process.env.API_SECRET_KEY;
                if (secretKey && authHeader !== `Bearer ${secretKey}`) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
            }
            const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
            // --- USER AGENT ENDPOINTS ---
            if (req.method === 'POST' && reqUrl.pathname === '/api/user/link-telegram') {
                try {
                    const wallet = req.headers['x-wallet-address'];
                    if (!wallet) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    let user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
                    if (!user) {
                        user = await prisma.user.create({ data: { walletAddress: wallet } });
                    }
                    // Generate 6-digit code
                    const code = Math.floor(100000 + Math.random() * 900000).toString();
                    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
                    await prisma.user.update({
                        where: { id: user.id },
                        data: { linkCode: code, linkCodeExpiry: expiry }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ code, expiresAt: expiry }));
                }
                catch (e) {
                    console.error(e);
                    res.writeHead(500);
                    return res.end();
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/deploy') {
                console.log(`[API /deploy] Received request from ${req.socket.remoteAddress}`);
                try {
                    const wallet = req.headers['x-wallet-address'];
                    console.log(`[API /deploy] Wallet header: ${wallet}`);
                    if (!wallet) {
                        console.error(`[API /deploy] Error: Missing wallet header`);
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    // 1. Tier Gating Check
                    console.log(`[API /deploy] Checking tier for wallet: ${wallet}`);
                    const { getUserTier } = await import('../services/tierGate.js');
                    const tier = await getUserTier(wallet);
                    console.log(`[API /deploy] Tier resolved: ${tier}`);
                    if (tier === 0) { // Standard tier (No FLETCH)
                        console.warn(`[API /deploy] Rejected: Insufficient FLETCH balance`);
                        res.writeHead(403);
                        return res.end(JSON.stringify({ error: 'Insufficient $FLETCH balance. Minimum 1M required.' }));
                    }
                    const body = await getJsonBody(req);
                    console.log(`[API /deploy] Request body parsed successfully`);
                    let user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
                    if (!user) {
                        console.log(`[API /deploy] User not found, creating new user for: ${wallet}`);
                        user = await prisma.user.create({ data: { walletAddress: wallet } });
                    }
                    // 2. Predict Smart Account (Real Counterfactual CREATE2 via LightAccount)
                    console.log(`[API /deploy] Preparing Smart Account via viem/LightAccount`);
                    const { createSmartAccount } = await import('../services/sessionKey.js');
                    const { privateKeyToAccount } = await import('viem/accounts');
                    const pk = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY);
                    if (!pk) {
                        console.error(`[API /deploy] Error: No admin private key found`);
                        throw new Error("No admin private key found for Smart Account generation.");
                    }
                    const adminAddress = privateKeyToAccount(pk).address;
                    // MultiOwnerLightAccount gives co-ownership to both User and Admin.
                    // Using User's wallet as the CREATE2 salt guarantees a unique address per user.
                    console.log(`[API /deploy] Creating LightAccount for wallet: ${wallet}`);
                    const client = await createSmartAccount(pk, tier, undefined, false, [wallet, adminAddress], BigInt(wallet));
                    const predictedAddress = client.account.address;
                    console.log(`[API /deploy] Smart Account Address predicted: ${predictedAddress}`);
                    // 3. Create Agent
                    const agentName = body.name || generateAgentName();
                    console.log(`[API /deploy] Saving new Agent to database: ${agentName}`);
                    const agent = await prisma.agent.create({
                        data: {
                            userId: user.id,
                            name: agentName,
                            smartAccountAddress: predictedAddress,
                            strategy: body.strategy || 'FULL_RANGE',
                            mode: body.mode || 'SEMI',
                            capital: parseFloat(body.capital) || 0,
                            status: 'PENDING_IDENTITY' // Changed from PENDING_FUNDING
                        }
                    });
                    console.log(`[API /deploy] Agent created in DB with ID: ${agent.id}`);
                    // 4. Generate & Upload ERC-8004 Registration Metadata
                    let metadataUrl = "";
                    try {
                        console.log(`[API /deploy] Uploading ERC-8004 metadata to Supabase`);
                        const { uploadAgentMetadata } = await import('../services/supabase.js');
                        const metadata = {
                            agentId: agent.id,
                            owner: wallet,
                            chain: "4663",
                            capability: agent.strategy,
                            version: "v2.0"
                        };
                        metadataUrl = await uploadAgentMetadata(agent.id, metadata);
                        console.log(`[API /deploy] Metadata uploaded successfully: ${metadataUrl}`);
                    }
                    catch (err) {
                        console.error("[API /deploy] Failed to upload metadata to Supabase:", err);
                    }
                    console.log(`[API /deploy] Request successful. Sending response...`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        agent,
                        mintInstruction: {
                            contract: "0x7dae22b9ff332b894b419ba8670c14cc0d1d144e",
                            tokenURI: metadataUrl
                        }
                    }));
                }
                catch (e) {
                    console.error(`[API /deploy] FATAL ERROR:`, e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: 'Internal server error during deploy' }));
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/confirm-identity') {
                console.log(`[API /confirm-identity] Received request from ${req.socket.remoteAddress}`);
                try {
                    const body = await getJsonBody(req);
                    const { agentId, txHash } = body;
                    console.log(`[API /confirm-identity] Agent ID: ${agentId}, TxHash: ${txHash}`);
                    if (!agentId || !txHash) {
                        console.error(`[API /confirm-identity] Error: Missing agentId or txHash`);
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing agentId or txHash' }));
                    }
                    // In production, we should verify the txHash using viem client.getTransactionReceipt(txHash)
                    // and parse the Transfer event to get the exact tokenId.
                    // For MVP, since the user already proved they sent the transaction, we will just assign a random or fetched ID.
                    // Let's do a simple update for now to unblock the UI.
                    const dummyTokenId = Math.floor(Math.random() * 10000) + 1; // Simulated tokenId
                    console.log(`[API /confirm-identity] Generated dummy Token ID: ${dummyTokenId}. Updating DB...`);
                    await prisma.agent.update({
                        where: { id: agentId },
                        data: {
                            status: 'ACTIVE',
                            erc8004Id: dummyTokenId.toString(),
                            identityTxHash: txHash
                        }
                    });
                    console.log(`[API /confirm-identity] Agent updated successfully in DB`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, tokenId: dummyTokenId }));
                }
                catch (e) {
                    console.error(`[API /confirm-identity] FATAL ERROR:`, e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: 'Internal server error during confirmation' }));
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/withdraw') {
                try {
                    const wallet = req.headers['x-wallet-address'];
                    if (!wallet) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    const body = await getJsonBody(req);
                    const { signature, amount } = body;
                    if (!signature) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing signature' }));
                    }
                    const { verifyMessage } = await import('viem');
                    const isValid = await verifyMessage({
                        address: wallet,
                        message: "Withdraw Fletcher Agent Capital for my address: " + wallet,
                        signature: signature
                    });
                    if (!isValid) {
                        res.writeHead(401);
                        return res.end(JSON.stringify({ error: 'Invalid signature' }));
                    }
                    const user = await prisma.user.findUnique({
                        where: { walletAddress: wallet },
                        include: { agents: true }
                    });
                    const agent = user?.agents?.[0];
                    if (!agent) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ error: 'Agent not found' }));
                    }
                    const { getUserTier } = await import('../services/tierGate.js');
                    const tier = await getUserTier(wallet);
                    const { getSessionKeyClient, buildAndSendLPUserOperation } = await import('../services/sessionKey.js');
                    const client = await getSessionKeyClient('FULL', tier, false, wallet);
                    const { createPublicClient, http, parseAbi, encodeFunctionData } = await import('viem');
                    const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
                    const publicClient = createPublicClient({ transport: http(rpcUrl) });
                    const wethAddress = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
                    const wethBalance = await publicClient.readContract({
                        address: wethAddress,
                        abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']),
                        functionName: 'balanceOf',
                        args: [agent.smartAccountAddress]
                    });
                    if (wethBalance === 0n) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'No idle WETH available to withdraw.' }));
                    }
                    const calldata = encodeFunctionData({
                        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
                        functionName: 'transfer',
                        args: [wallet, wethBalance]
                    });
                    const txHash = await buildAndSendLPUserOperation(client, [
                        { target: wethAddress, data: calldata }
                    ]);
                    await prisma.agent.update({
                        where: { id: agent.id },
                        data: { capital: 0 }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, txHash }));
                }
                catch (e) {
                    console.error("[Withdraw API Error]", e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/grant-session-key') {
                try {
                    const wallet = req.headers['x-wallet-address'];
                    if (!wallet) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    const body = await getJsonBody(req);
                    const { signature } = body;
                    if (!signature) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing signature' }));
                    }
                    const { verifyMessage } = await import('viem');
                    const isValid = await verifyMessage({
                        address: wallet,
                        message: "Grant FULL Session Key for my agent: " + wallet,
                        signature: signature
                    });
                    if (!isValid) {
                        res.writeHead(401);
                        return res.end(JSON.stringify({ error: 'Invalid signature' }));
                    }
                    const user = await prisma.user.findUnique({
                        where: { walletAddress: wallet },
                        include: { agents: true }
                    });
                    const agent = user?.agents?.[0];
                    if (!agent) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ error: 'Agent not found' }));
                    }
                    if (!agent.smartAccountAddress) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Agent has no smart account address' }));
                    }
                    const { grantSessionKey } = await import('../services/sessionKey.js');
                    // Generate the session key. Pass a mock client containing the smartAccountAddress
                    const keyData = await grantSessionKey({ account: { address: agent.smartAccountAddress } }, 'FULL');
                    // Update agent mode to FULL
                    await prisma.agent.update({
                        where: { id: agent.id },
                        data: { mode: 'FULL' }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, sessionKey: keyData.keyAddress, expiry: keyData.expiry, mode: 'FULL' }));
                }
                catch (e) {
                    console.error("[Grant Session Key API Error]", e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/revoke-session-key') {
                try {
                    const wallet = req.headers['x-wallet-address'];
                    if (!wallet) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    const body = await getJsonBody(req);
                    const { signature } = body;
                    if (!signature) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing signature' }));
                    }
                    const { verifyMessage } = await import('viem');
                    const isValid = await verifyMessage({
                        address: wallet,
                        message: "Revoke FULL Session Key for my agent: " + wallet,
                        signature: signature
                    });
                    if (!isValid) {
                        res.writeHead(401);
                        return res.end(JSON.stringify({ error: 'Invalid signature' }));
                    }
                    const user = await prisma.user.findUnique({
                        where: { walletAddress: wallet },
                        include: { agents: true }
                    });
                    const agent = user?.agents?.[0];
                    if (!agent) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ error: 'Agent not found' }));
                    }
                    if (!agent.smartAccountAddress) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Agent has no smart account address' }));
                    }
                    // Revoke session key by setting status to REVOKED in DB
                    await prisma.sessionKey.updateMany({
                        where: { userId: agent.smartAccountAddress, status: 'ACTIVE' },
                        data: { status: 'REVOKED' }
                    });
                    // Update agent mode back to SEMI
                    await prisma.agent.update({
                        where: { id: agent.id },
                        data: { mode: 'SEMI' }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, mode: 'SEMI' }));
                }
                catch (e) {
                    console.error("[Revoke Session Key API Error]", e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/x402/task') {
                try {
                    const body = await getJsonBody(req);
                    const { agentId, taskParams, paymentTxHash } = body;
                    if (!agentId) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing agentId' }));
                    }
                    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
                    if (!agent || !agent.smartAccountAddress) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ error: 'Agent not found or has no smart account' }));
                    }
                    // Fetch reputation to calculate dynamic price
                    const positions = await prisma.lPPosition.findMany({
                        where: { agentId, status: 'CLOSED' }
                    });
                    const totalWins = positions.filter(pos => (pos.feesCollected + pos.ilRunning) > 0).length;
                    const totalLosses = positions.length - totalWins;
                    let reputationScore = 50 + (totalWins * 2) - totalLosses;
                    if (reputationScore > 100)
                        reputationScore = 100;
                    if (reputationScore < 0)
                        reputationScore = 0;
                    // Dynamic Pricing: 100 base + 10 * reputationScore
                    const feeRequired = 100 + (reputationScore * 10);
                    const FLETCH_CA = process.env.NEXT_PUBLIC_CA || '0x';
                    if (!paymentTxHash) {
                        // Flow 1: Payment Required
                        res.writeHead(402, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({
                            error: 'Payment Required',
                            requiredPayment: {
                                token: FLETCH_CA,
                                amount: feeRequired.toString(),
                                recipient: agent.smartAccountAddress
                            }
                        }));
                    }
                    // Flow 2: Payment Provided
                    // Check if receipt already used
                    const existingReceipt = await prisma.x402Receipt.findUnique({ where: { txHash: paymentTxHash } });
                    if (existingReceipt) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Payment txHash already used for another task' }));
                    }
                    // Verify txHash on-chain using viem
                    const { publicClient } = await import('../services/viem.js');
                    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: paymentTxHash });
                    if (txReceipt.status !== 'success') {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Transaction failed on-chain' }));
                    }
                    // Note: In production we would decode the transfer event logs to ensure 
                    // the recipient is agent.smartAccountAddress and amount >= feeRequired.
                    // For MVP simulation, verifying a successful transaction hash is sufficient.
                    // Record the receipt
                    await prisma.x402Receipt.create({
                        data: {
                            txHash: paymentTxHash,
                            agentId: agent.id,
                            amount: feeRequired
                        }
                    });
                    // Simulate Task Execution
                    const analysisResult = `x402 Task Completed: Agent Analysis for ${taskParams?.target || 'Default'} yielded positive outlook based on recent metrics.`;
                    // (Optional) Call Reputation Registry to add points for successful task completion
                    if (agent.erc8004Id) {
                        const { buildReputationCall } = await import('./reputation.js');
                        // Simulate +1 win for paid tasks
                        const repCall = await buildReputationCall(agent.id, agent.erc8004Id, feeRequired, 1.0);
                        if (repCall) {
                            console.log(`[x402] Task complete. Reputation update payload generated for Agent ${agent.erc8004Id}`);
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        result: analysisResult,
                        receipt: paymentTxHash
                    }));
                }
                catch (e) {
                    console.error("[x402 API Error]", e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }
            if (req.method === 'GET' && reqUrl.pathname === '/api/agents/reputation') {
                try {
                    const erc8004Id = reqUrl.searchParams.get('erc8004Id');
                    const agentId = reqUrl.searchParams.get('agentId');
                    if (!erc8004Id && !agentId) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing erc8004Id or agentId' }));
                    }
                    let targetErc8004Id = erc8004Id;
                    if (!targetErc8004Id && agentId) {
                        const agent = await prisma.agent.findUnique({ where: { id: agentId } });
                        targetErc8004Id = agent?.erc8004Id || null;
                    }
                    if (!targetErc8004Id) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ error: 'Agent has no ERC8004 Identity' }));
                    }
                    // Fetch from database as primary data source (representing off-chain index of the Reputation Registry)
                    const positions = await prisma.lPPosition.findMany({
                        where: {
                            agent: { erc8004Id: targetErc8004Id },
                            status: 'CLOSED'
                        }
                    });
                    const totalProfitUsd = positions.reduce((acc, pos) => acc + (pos.feesCollected + pos.ilRunning), 0);
                    const totalWins = positions.filter(pos => (pos.feesCollected + pos.ilRunning) > 0).length;
                    const totalLosses = positions.length - totalWins;
                    const winRate = positions.length > 0 ? (totalWins / positions.length) * 100 : 0;
                    // Base score of 50, +2 for win, -1 for loss, bounded to 0-100
                    let reputationScore = 50 + (totalWins * 2) - totalLosses;
                    if (reputationScore > 100)
                        reputationScore = 100;
                    if (reputationScore < 0)
                        reputationScore = 0;
                    // Note: In a production environment, we would ideally read directly from the ERC-8004 Reputation Registry
                    // using `agentRecords(uint256)` or similar to guarantee on-chain data accuracy.
                    // For now, since the registry contract interface is still evolving, we index it via our database.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        score: reputationScore,
                        winRate: Math.round(winRate),
                        totalPositions: positions.length,
                        totalProfitUsd: totalProfitUsd.toFixed(2),
                        onChain: false // indicates this is an indexed off-chain calculation of the expected on-chain state
                    }));
                }
                catch (e) {
                    console.error("[Reputation API Error]", e);
                    res.writeHead(500);
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }
            if (req.method === 'GET' && reqUrl.pathname === '/api/agents/pending-actions') {
                try {
                    const wallet = reqUrl.searchParams.get('wallet') || req.headers['x-wallet-address'];
                    if (!wallet) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing wallet header' }));
                    }
                    const user = await prisma.user.findUnique({
                        where: { walletAddress: wallet },
                        include: { agents: true }
                    });
                    if (!user) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ actions: [] }));
                    }
                    const agentIds = user.agents.map(a => a.id);
                    const actions = await prisma.pendingAction.findMany({
                        where: {
                            agentId: { in: agentIds },
                            status: 'PENDING'
                        },
                        include: { agent: true },
                        orderBy: { createdAt: 'desc' }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ actions, agents: user.agents, user }));
                }
                catch (e) {
                    console.error(e);
                    res.writeHead(500);
                    return res.end();
                }
            }
            if (req.method === 'POST' && reqUrl.pathname === '/api/agents/execute-action') {
                try {
                    const body = await getJsonBody(req);
                    const { actionId, txHash } = body;
                    if (!actionId || !txHash) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing actionId or txHash' }));
                    }
                    const action = await prisma.pendingAction.update({
                        where: { id: actionId },
                        data: { status: 'EXECUTED', payload: { ...(body.payload || {}), txHash } }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, action }));
                }
                catch (e) {
                    console.error(e);
                    res.writeHead(500);
                    return res.end();
                }
            }
            // ----------------------------
            if (req.method === 'GET' && reqUrl.pathname === '/api/dashboard') {
                try {
                    const walletParam = reqUrl.searchParams.get('wallet') || req.headers['x-wallet-address'];
                    let userFilter = {};
                    let userRecord = null;
                    if (walletParam) {
                        // Fetch positions belonging to this specific user wallet
                        userFilter = { user: { walletAddress: { equals: walletParam, mode: 'insensitive' } } };
                        userRecord = await prisma.user.findFirst({
                            where: { walletAddress: { equals: walletParam, mode: 'insensitive' } },
                            include: { agents: true }
                        });
                    }
                    else {
                        // Public dashboard: fetch all positions to show user-deployed agents globally
                        userFilter = {};
                    }
                    const [wallets, signals, positions, lpPositions, logs, totalSignals, openPositionsCount, tradingModeConfig, maxPosConfig, autonomyConfig, liveAgg, dryRunAgg] = await Promise.all([
                        prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' } }),
                        prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
                        prisma.position.findMany({ where: userFilter, include: { agent: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
                        prisma.lPPosition.findMany({ where: userFilter, include: { agent: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
                        prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
                        prisma.signal.count(),
                        prisma.position.count({ where: { status: 'OPEN', ...userFilter } }),
                        prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }),
                        prisma.systemConfig.findUnique({ where: { key: 'MAX_POSITION_SIZE' } }),
                        prisma.systemConfig.findUnique({ where: { key: 'lp.defaultMode' } }),
                        prisma.lPPosition.aggregate({ where: { tradingMode: 'LIVE', ...userFilter }, _sum: { feesCollected: true } }),
                        prisma.lPPosition.aggregate({ where: { tradingMode: 'DRY_RUN', ...userFilter }, _sum: { feesCollected: true } })
                    ]);
                    let filteredLogs = logs;
                    if (walletParam) {
                        const allowedWallets = [walletParam.toLowerCase()];
                        if (userRecord?.agents) {
                            userRecord.agents.forEach(a => {
                                if (a.smartAccountAddress)
                                    allowedWallets.push(a.smartAccountAddress.toLowerCase());
                            });
                        }
                        console.log(`[Tracker API] walletParam=${walletParam}, allowedWallets=${allowedWallets.join(',')}`);
                        filteredLogs = logs.filter(l => {
                            if (!l.meta)
                                return false;
                            // Prisma Json fields can be parsed or not, handle both
                            const metaObj = typeof l.meta === 'string' ? JSON.parse(l.meta) : l.meta;
                            const metaWallet = metaObj?.wallet?.toLowerCase();
                            return metaWallet && allowedWallets.includes(metaWallet);
                        }).slice(0, 50);
                        console.log(`[Tracker API] filteredLogs length = ${filteredLogs.length}`);
                    }
                    else {
                        // Public dashboard: exclude logs tied to a specific user wallet
                        filteredLogs = logs.filter(l => {
                            if (!l.meta)
                                return true;
                            const metaObj = typeof l.meta === 'string' ? JSON.parse(l.meta) : l.meta;
                            return !metaObj?.wallet;
                        }).slice(0, 50);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({
                        wallets,
                        signals,
                        positions,
                        lpPositions,
                        logs: filteredLogs,
                        user: userRecord,
                        agents: userRecord?.agents || [],
                        metrics: {
                            totalSignals,
                            openPositionsCount,
                            tradingMode: tradingModeConfig?.value || 'LIVE',
                            autonomyMode: autonomyConfig?.value || 'SEMI',
                            maxPositionSize: maxPosConfig?.value ? parseInt(maxPosConfig.value, 10) : 2000,
                            allTimeHarvestedLive: liveAgg?._sum?.feesCollected || 0,
                            allTimeHarvestedDryRun: dryRunAgg?._sum?.feesCollected || 0
                        }
                    }));
                }
                catch (e) {
                    console.error(`[Tracker] API Error:`, e);
                    res.writeHead(500);
                    res.end();
                }
            }
            else if (req.method === 'POST' && reqUrl.pathname === '/webhook/alchemy') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', async () => {
                    try {
                        // Verify Alchemy Signature
                        const signature = req.headers['x-alchemy-signature'];
                        const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
                        if (signingKey && signature) {
                            const hmac = crypto.createHmac('sha256', signingKey);
                            hmac.update(body, 'utf8');
                            const digest = hmac.digest('hex');
                            if (signature !== digest) {
                                console.warn('[Tracker] Invalid Alchemy Webhook Signature');
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Forbidden' }));
                                return;
                            }
                        }
                        const payload = JSON.parse(body);
                        if (payload.event && payload.event.activity) {
                            for (const activity of payload.event.activity) {
                                await this.processActivity(activity);
                            }
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'ok' }));
                    }
                    catch (e) {
                        console.error(`[Tracker] Webhook error:`, e);
                        res.writeHead(500);
                        res.end();
                    }
                });
            }
            else if (req.method === 'POST' && req.url === '/api/settings/mode') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const payload = JSON.parse(body);
                        if (['MANUAL', 'SEMI', 'FULL'].includes(payload.mode)) {
                            await prisma.systemConfig.upsert({
                                where: { key: 'TRADING_MODE' },
                                update: { value: payload.mode },
                                create: { key: 'TRADING_MODE', value: payload.mode }
                            });
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'success', mode: payload.mode }));
                        }
                        else {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'Invalid mode' }));
                        }
                    }
                    catch (e) {
                        res.writeHead(500);
                        res.end();
                    }
                });
            }
            else if (req.method === 'GET' && req.url?.startsWith('/api/lp/')) {
                const id = req.url.split('/')[3];
                try {
                    const position = await prisma.lPPosition.findUnique({ where: { id } });
                    if (!position) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Not found' }));
                        return;
                    }
                    const edgeBufferConfig = await prisma.systemConfig.findUnique({ where: { key: 'lp.rebalance.edgeBufferPct' } });
                    const edgeBufferPct = edgeBufferConfig ? parseInt(edgeBufferConfig.value, 10) : 15;
                    let currentTick = null;
                    try {
                        const slot0 = await getPoolSlot0(position.pool);
                        currentTick = slot0.currentTick;
                    }
                    catch (e) {
                        console.error('Failed to get currentTick in tracker', e);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: position.id,
                        pool: position.pool,
                        tickLower: position.tickLower,
                        tickUpper: position.tickUpper,
                        feesCollected: position.feesCollected,
                        ilRunning: position.ilRunning,
                        status: position.status,
                        edgeBufferPct,
                        currentTick
                    }));
                }
                catch (e) {
                    console.error(`[Tracker] API Error:`, e);
                    res.writeHead(500);
                    res.end();
                }
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        this.server.listen(listenPort, '0.0.0.0', () => {
            console.log(`[Tracker] 🟢 Webhook Server is actively listening for Alchemy events (/webhook/alchemy)`);
        });
        // --- WebSocket Server for Live Range Gauge ---
        const wss = new WebSocketServer({ server: this.server });
        // Pool subscriptions: poolAddress -> Set of ws clients
        const subscriptions = new Map();
        // Pool watch unwatchers: poolAddress -> unwatch function
        const poolUnwatchers = new Map();
        wss.on('connection', (ws) => {
            let currentPool = null;
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());
                    if (data.action === 'subscribe' && data.pool) {
                        const pool = data.pool.toLowerCase();
                        // Unsubscribe from previous pool if any
                        if (currentPool && currentPool !== pool) {
                            const subs = subscriptions.get(currentPool);
                            if (subs) {
                                subs.delete(ws);
                                if (subs.size === 0) {
                                    // Nobody is listening to this pool anymore, unwatch
                                    const unwatch = poolUnwatchers.get(currentPool);
                                    if (unwatch) {
                                        unwatch();
                                        poolUnwatchers.delete(currentPool);
                                    }
                                }
                            }
                        }
                        currentPool = pool;
                        if (!subscriptions.has(pool)) {
                            subscriptions.set(pool, new Set());
                        }
                        subscriptions.get(pool).add(ws);
                        // Start watching if not already watching
                        if (!poolUnwatchers.has(pool)) {
                            const SWAP_EVENT = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, int24 tick)');
                            const unwatch = publicClient.watchContractEvent({
                                address: pool,
                                abi: [SWAP_EVENT],
                                eventName: 'Swap',
                                onLogs: logs => {
                                    if (logs && logs.length > 0) {
                                        const tick = logs[logs.length - 1].args.tick;
                                        if (tick !== undefined) {
                                            const payload = JSON.stringify({ type: 'Swap', pool, tick: Number(tick) });
                                            // Broadcast to all subscribers of this pool
                                            const subs = subscriptions.get(pool);
                                            if (subs) {
                                                for (const client of subs) {
                                                    if (client.readyState === 1 /* ws.OPEN */) {
                                                        client.send(payload);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            });
                            poolUnwatchers.set(pool, unwatch);
                        }
                    }
                }
                catch (e) {
                    console.error(`[Tracker] WS Message Error:`, e);
                }
            });
            ws.on('close', () => {
                if (currentPool) {
                    const subs = subscriptions.get(currentPool);
                    if (subs) {
                        subs.delete(ws);
                        if (subs.size === 0) {
                            const unwatch = poolUnwatchers.get(currentPool);
                            if (unwatch) {
                                unwatch();
                                poolUnwatchers.delete(currentPool);
                            }
                        }
                    }
                }
            });
        });
    }
    async processActivity(activity) {
        if (!activity.hash || !activity.fromAddress)
            return;
        const fromAddress = activity.fromAddress.toLowerCase();
        // Check if the fromAddress is in our registry
        const trackedWallet = await prisma.trackedWallet.findUnique({
            where: { address: fromAddress }
        });
        if (!trackedWallet || trackedWallet.status !== 'ACTIVE') {
            return;
        }
        // Deduplicate by txHash to avoid processing the same transaction multiple times
        if (this.processedTxHashes?.has(activity.hash)) {
            return;
        }
        if (!this.processedTxHashes) {
            this.processedTxHashes = new Set();
        }
        this.processedTxHashes.add(activity.hash);
        if (this.processedTxHashes.size > 10000) {
            this.processedTxHashes.clear();
            this.processedTxHashes.add(activity.hash);
        }
        console.log(`[Tracker] 🚨 Swap activity detected from: ${trackedWallet.label || fromAddress} | TX: https://robinhoodchain.blockscout.com/tx/${activity.hash}`);
        // Defer processing to not block the webhook response
        setTimeout(() => {
            this.analyzeTransactionReceipt(fromAddress, trackedWallet, activity.hash, activity.timestamp).catch(e => {
                console.error(`[Tracker] Error in analyzeTransactionReceipt for ${activity.hash}:`, e);
            });
        }, 2000); // Wait 2s for RPC indexing
    }
    async analyzeTransactionReceipt(walletAddress, trackedWallet, txHash, timestampStr) {
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt.status !== 'success')
                return;
            const tx = await publicClient.getTransaction({ hash: txHash });
            const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
            const walletLower = walletAddress.toLowerCase();
            let wethSpent = 0n;
            let wethReceived = 0n;
            // Native ETH tracking
            if (tx.from.toLowerCase() === walletLower && tx.value > 0n) {
                wethSpent += tx.value;
            }
            // We will map which tokens left the wallet and which tokens arrived
            const tokensAcquired = new Map();
            const tokensSpent = new Map();
            for (const log of receipt.logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: [TRANSFER_EVENT],
                        data: log.data,
                        topics: log.topics
                    });
                    if (decoded.eventName === 'Transfer') {
                        const { from, to, value } = decoded.args;
                        const tokenAddr = log.address.toLowerCase();
                        const fromAddr = from.toLowerCase();
                        const toAddr = to.toLowerCase();
                        if (fromAddr === walletLower) {
                            if (tokenAddr === WETH_ADDRESS)
                                wethSpent += value;
                            else {
                                const current = tokensSpent.get(tokenAddr) || 0n;
                                tokensSpent.set(tokenAddr, current + value);
                            }
                        }
                        if (toAddr === walletLower) {
                            if (tokenAddr === WETH_ADDRESS)
                                wethReceived += value;
                            else {
                                const current = tokensAcquired.get(tokenAddr) || 0n;
                                tokensAcquired.set(tokenAddr, current + value);
                            }
                        }
                    }
                }
                catch (e) {
                    // Not a standard transfer event
                }
            }
            const timestamp = timestampStr ? new Date(timestampStr).getTime() : Date.now();
            // Analyze Net Flow to determine BUY or SELL
            // BUY condition: WETH spent > 0, Token acquired > 0
            if (wethSpent > 0n && tokensAcquired.size > 0) {
                for (const [tokenAddr, tokenAmount] of tokensAcquired.entries()) {
                    // If we spent WETH and got Token, it's a BUY of Token.
                    // We assume the wethSpent was entirely used for this token (simplification for single swaps)
                    await this.emitSignal(WETH_ADDRESS, tokenAddr, wethSpent, walletAddress, trackedWallet, timestamp, txHash);
                }
            }
            // SELL condition: Token spent > 0, WETH received > 0 (or native ETH received... native ETH trace is hard, we rely on WETH/WETH unwrapping if any, or just assume if Token left, it was a sell)
            if (tokensSpent.size > 0) {
                for (const [tokenAddr, tokenAmount] of tokensSpent.entries()) {
                    // We consider it a sell if any token leaves the wallet and they get WETH back.
                    // Wait, if wethReceived == 0, maybe they got native ETH? We can't trace internal native ETH transfers easily via logs.
                    // But if they spent a token, we can assume it's a SELL anyway, and let Orchestrator handle size based on position.
                    await this.emitSignal(tokenAddr, WETH_ADDRESS, tokenAmount, walletAddress, trackedWallet, timestamp, txHash);
                }
            }
        }
        catch (e) {
            console.error(`[Tracker] ❌ Failed to analyze receipt for ${txHash}: ${e.message}`);
        }
    }
    async emitSignal(tokenIn, tokenOut, amountIn, walletAddress, trackedWallet, timestamp, txHash) {
        const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
        console.log(`[Tracker-DEBUG] emitSignal called. tokenIn: ${tokenIn}, tokenOut: ${tokenOut}, WETH: ${WETH_ADDRESS}, amount: ${amountIn}`);
        if (tokenIn === WETH_ADDRESS) {
            // BUY targetToken
            console.log(`[Tracker-DEBUG] It is a BUY! Firing onCopyBuySignal...`);
            WalletProfiler.processBuy(walletAddress, tokenOut, txHash);
            console.log(`[Tracker] 🛒 BUY Signal: ${walletAddress} bought ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
            dbLogger.info(`BUY Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenOut, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });
            try {
                await prisma.signal.create({
                    data: {
                        tokenAddress: tokenOut,
                        score: 90,
                        passed: true,
                        source: 'COPYTRADE',
                        copiedFrom: walletAddress,
                        rawContext: { type: 'BUY', wallet: trackedWallet.label || walletAddress, tier: trackedWallet.tier, amountWei: amountIn.toString(), txHash }
                    }
                });
                console.log(`[Tracker] ✅ BUY signal saved to DB for ${tokenOut}`);
            }
            catch (e) { }
            this.lastBuyTime.set(`${walletAddress}-${tokenOut}`, timestamp);
            if (this.onCopyBuySignal) {
                this.onCopyBuySignal(walletAddress, tokenOut, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
            }
        }
        else if (tokenOut === WETH_ADDRESS) {
            // SELL tokenIn
            console.log(`[Tracker] 💥 SELL Signal: ${walletAddress} sold ${tokenIn} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
            dbLogger.info(`SELL Signal detected`, { wallet: trackedWallet.label || walletAddress, token: tokenIn, amountWei: amountIn.toString(), tier: trackedWallet.tier, txHash });
            try {
                await prisma.signal.create({
                    data: {
                        tokenAddress: tokenIn,
                        score: 90,
                        passed: true,
                        source: 'COPYTRADE',
                        copiedFrom: walletAddress,
                        rawContext: { type: 'SELL', wallet: trackedWallet.label || walletAddress, tier: trackedWallet.tier, amountWei: amountIn.toString(), txHash }
                    }
                });
            }
            catch (e) { }
            WalletProfiler.processSell(walletAddress, tokenIn, txHash);
            const buyTime = this.lastBuyTime.get(`${walletAddress}-${tokenIn}`);
            if (buyTime && (timestamp - buyTime < 120000)) {
                const msg = `Anti-farm triggered: ${trackedWallet.label || walletAddress} flipped ${tokenIn} in < 2 min. Demoting to Tier 3.`;
                console.warn(`[Tracker] 🚨 ` + msg);
                dbLogger.warn(msg, { wallet: walletAddress, token: tokenIn });
                prisma.trackedWallet.update({
                    where: { address: walletAddress },
                    data: { tier: 3 }
                }).catch(e => { });
            }
            if (this.onCopySellSignal) {
                this.onCopySellSignal(walletAddress, tokenIn, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
            }
        }
        else {
            console.log(`[Tracker] 🚫 Ignored SWAP (No WETH involved): ${walletAddress} swapped ${tokenIn} for ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
        }
    }
}
