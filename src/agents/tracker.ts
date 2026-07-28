import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { parseAbiItem, decodeEventLog, Hex } from 'viem';
import { prisma } from '../core/db.js';
import { dbLogger } from '../services/logger.js';
import { WalletProfiler } from '../services/walletProfiler.js';
import { publicClient } from '../services/viem.js';
import { mcpServer } from '../mcp/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getPoolSlot0 } from '../services/lpMath.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const getJsonBody = (req: IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
  });
};

const CODENAMES = ["Orion", "Sentinel", "Apollo", "Nova", "Cipher", "Vortex", "Apex", "Echo"];
const generateAgentName = () => `Agent ${CODENAMES[Math.floor(Math.random() * CODENAMES.length)]} ${Math.floor(Math.random() * 999)}`;

export class TrackerAgent {
  public onCopyBuySignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number, txHash: string) => void;
  public onCopySellSignal?: (wallet: string, token: string, amount: bigint, tier: number, bundleId: string | null, timestamp: number, txHash: string) => void;
  public onSwapActivity?: (walletLabel: string, txHash: string, toAddress: string, value: number) => void;

  private server: any;
  private mcpTransport: SSEServerTransport | null = null;
  private processedTxHashes: Set<string> = new Set<string>();
  private lastBuyTime: Map<string, number> = new Map(); // For anti-farm: wallet-token -> timestamp

  constructor() {}

  public startListening(port?: number) {
    const listenPort = port || parseInt(process.env.PORT || '3001', 10);
    console.log(`🎯 Tracker Agent: Starting Webhook server on port ${listenPort}...`);

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
        this.mcpTransport = new SSEServerTransport("/mcp/message", res as any);
        await mcpServer.connect(this.mcpTransport);
        console.log('[MCP] Client connected via SSE on main Tracker port');
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/mcp/message')) {
        if (this.mcpTransport) {
          await this.mcpTransport.handlePostMessage(req as any, res as any);
        } else {
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
          const wallet = req.headers['x-wallet-address'] as string;
          if (!wallet) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing wallet header' }));
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
        } catch (e) {
          console.error(e);
          res.writeHead(500); return res.end();
        }
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/agents/deploy') {
        try {
          const wallet = req.headers['x-wallet-address'] as string;
          if (!wallet) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing wallet header' }));
          }

          // 1. Tier Gating Check
          const { getUserTier } = await import('../services/tierGate.js');
          const tier = await getUserTier(wallet);
          if (tier === 0) { // Standard tier (No FLETCH)
            res.writeHead(403); 
            return res.end(JSON.stringify({ error: 'Insufficient $FLETCH balance. Minimum 1M required.' }));
          }

          const body = await getJsonBody(req);
          
          let user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
          if (!user) {
            user = await prisma.user.create({ data: { walletAddress: wallet } });
          }

          // 2. Predict Smart Account (Real Counterfactual CREATE2 via LightAccount)
          const { createSmartAccount } = await import('../services/sessionKey.js');
          const { privateKeyToAccount } = await import('viem/accounts');
          const pk = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY) as `0x${string}`;
          if (!pk) throw new Error("No admin private key found for Smart Account generation.");
          const adminAddress = privateKeyToAccount(pk).address;
          
          // MultiOwnerLightAccount gives co-ownership to both User and Admin.
          // Using User's wallet as the CREATE2 salt guarantees a unique address per user.
          const client = await createSmartAccount(
            pk, 
            tier, 
            undefined, 
            false, 
            [wallet as `0x${string}`, adminAddress], 
            BigInt(wallet as string)
          );
          const predictedAddress = client.account.address;

          // 3. Create Agent
          const agentName = body.name || generateAgentName();
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

          // 4. Generate & Upload ERC-8004 Registration Metadata
          let metadataUrl = "";
          try {
            const { uploadAgentMetadata } = await import('../services/supabase.js');
            const metadata = {
              agentId: agent.id,
              owner: wallet,
              chain: "4663",
              capability: agent.strategy,
              version: "v2.0"
            };
            metadataUrl = await uploadAgentMetadata(agent.id, metadata);
          } catch (err: any) {
             console.error("Failed to upload metadata to Supabase:", err);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            success: true, 
            agent,
            mintInstruction: {
              contract: "0x7dae22b9ff332b894b419ba8670c14cc0d1d144e",
              tokenURI: metadataUrl
            }
          }));
        } catch (e) {
          console.error(e);
          res.writeHead(500); return res.end();
        }
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/agents/withdraw') {
        try {
          const wallet = req.headers['x-wallet-address'] as string;
          if (!wallet) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing wallet header' }));
          }

          const body = await getJsonBody(req);
          const { signature, amount } = body;
          
          if (!signature) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing signature' }));
          }

          const { verifyMessage } = await import('viem');
          const isValid = await verifyMessage({
            address: wallet as `0x${string}`,
            message: "Withdraw Fletcher Agent Capital for my address: " + wallet,
            signature: signature as `0x${string}`
          });

          if (!isValid) {
            res.writeHead(401); return res.end(JSON.stringify({ error: 'Invalid signature' }));
          }

          const user = await prisma.user.findUnique({
            where: { walletAddress: wallet },
            include: { agents: true }
          });

          const agent = user?.agents?.[0];
          if (!agent) {
            res.writeHead(404); return res.end(JSON.stringify({ error: 'Agent not found' }));
          }

          const { getUserTier } = await import('../services/tierGate.js');
          const tier = await getUserTier(wallet);

          const { getSessionKeyClient, buildAndSendLPUserOperation } = await import('../services/sessionKey.js');
          const client = await getSessionKeyClient('FULL', tier, false, wallet); 

          const { createPublicClient, http, parseAbi, encodeFunctionData } = await import('viem');
          const rpcUrl = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
          const publicClient = createPublicClient({ transport: http(rpcUrl) });
          const wethAddress = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2') as `0x${string}`;

          const wethBalance = await publicClient.readContract({
            address: wethAddress,
            abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']),
            functionName: 'balanceOf',
            args: [agent.smartAccountAddress as `0x${string}`]
          }) as bigint;

          if (wethBalance === 0n) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'No idle WETH available to withdraw.' }));
          }

          const calldata = encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
            functionName: 'transfer',
            args: [wallet as `0x${string}`, wethBalance]
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

        } catch (e: any) {
          console.error("[Withdraw API Error]", e);
          res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
        }
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/agents/pending-actions') {
        try {
          const wallet = reqUrl.searchParams.get('wallet') || req.headers['x-wallet-address'] as string;
          if (!wallet) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing wallet header' }));
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
        } catch (e) {
          console.error(e);
          res.writeHead(500); return res.end();
        }
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/agents/execute-action') {
        try {
          const body = await getJsonBody(req);
          const { actionId, txHash } = body;
          
          if (!actionId || !txHash) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing actionId or txHash' }));
          }

          const action = await prisma.pendingAction.update({
            where: { id: actionId },
            data: { status: 'EXECUTED', payload: { ...(body.payload || {}), txHash } }
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, action }));
        } catch (e) {
          console.error(e);
          res.writeHead(500); return res.end();
        }
      }
      // ----------------------------
      
      if (req.method === 'GET' && reqUrl.pathname === '/api/dashboard') {
        try {
          const walletParam = reqUrl.searchParams.get('wallet') || req.headers['x-wallet-address'] as string;
          let userFilter: any = {};
          let userRecord = null;
          if (walletParam) {
            // Fetch positions belonging to this specific user wallet
            userFilter = { user: { walletAddress: { equals: walletParam, mode: 'insensitive' } } };
            userRecord = await prisma.user.findFirst({ 
              where: { walletAddress: { equals: walletParam, mode: 'insensitive' } },
              include: { agents: true }
            });
          } else {
            // Public dashboard: fetch only positions where userId is null (system/flagship)
            userFilter = { userId: null };
          }

          const [wallets, signals, positions, lpPositions, logs, totalSignals, openPositionsCount, tradingModeConfig, maxPosConfig, autonomyConfig, liveAgg, dryRunAgg] = await Promise.all([
            prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' } }),
            prisma.signal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.position.findMany({ where: userFilter, orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.lPPosition.findMany({ where: userFilter, orderBy: { createdAt: 'desc' }, take: 20 }),
            prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
            prisma.signal.count(),
            prisma.position.count({ where: { status: 'OPEN', ...userFilter } }),
            prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } }),
            prisma.systemConfig.findUnique({ where: { key: 'MAX_POSITION_SIZE' } }),
            prisma.systemConfig.findUnique({ where: { key: 'lp.defaultMode' } }),
            prisma.lPPosition.aggregate({ where: { tradingMode: 'LIVE', ...userFilter }, _sum: { feesCollected: true } }),
            prisma.lPPosition.aggregate({ where: { tradingMode: 'DRY_RUN', ...userFilter }, _sum: { feesCollected: true } })
          ]);
          // Filter logs in memory
          let filteredLogs = logs;
          if (walletParam) {
            filteredLogs = logs.filter(l => (l.meta as any)?.wallet === walletParam).slice(0, 50);
          } else {
            // Public dashboard: exclude logs tied to a specific user wallet
            filteredLogs = logs.filter(l => !(l.meta as any)?.wallet).slice(0, 50);
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
        } catch (e) {
          console.error(`[Tracker] API Error:`, e);
          res.writeHead(500);
          res.end();
        }
      } else if (req.method === 'POST' && reqUrl.pathname === '/webhook/alchemy') {
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
          } catch (e) {
            console.error(`[Tracker] Webhook error:`, e);
            res.writeHead(500);
            res.end();
          }
        });
      } else if (req.method === 'POST' && req.url === '/api/settings/mode') {
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
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Invalid mode' }));
            }
          } catch (e) {
            res.writeHead(500);
            res.end();
          }
        });
      } else if (req.method === 'GET' && req.url?.startsWith('/api/lp/')) {
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
          
          let currentTick: number | null = null;
          try {
            const slot0 = await getPoolSlot0(position.pool);
            currentTick = slot0.currentTick;
          } catch(e) { console.error('Failed to get currentTick in tracker', e); }
          
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
        } catch (e) {
          console.error(`[Tracker] API Error:`, e);
          res.writeHead(500);
          res.end();
        }
      } else {
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
    const subscriptions = new Map<string, Set<any>>();
    // Pool watch unwatchers: poolAddress -> unwatch function
    const poolUnwatchers = new Map<string, () => void>();

    wss.on('connection', (ws) => {
      let currentPool: string | null = null;

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
                  if (unwatch) { unwatch(); poolUnwatchers.delete(currentPool); }
                }
              }
            }

            currentPool = pool;
            if (!subscriptions.has(pool)) {
              subscriptions.set(pool, new Set());
            }
            subscriptions.get(pool)!.add(ws);

            // Start watching if not already watching
            if (!poolUnwatchers.has(pool)) {
              const SWAP_EVENT = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, int24 tick)');
              const unwatch = publicClient.watchContractEvent({
                address: pool as Hex,
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
        } catch (e) {
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
              if (unwatch) { unwatch(); poolUnwatchers.delete(currentPool); }
            }
          }
        }
      });
    });
  }

  private async processActivity(activity: any) {
    if (!activity.hash || !activity.fromAddress) return;

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
      this.processedTxHashes = new Set<string>();
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

  private async analyzeTransactionReceipt(walletAddress: string, trackedWallet: any, txHash: string, timestampStr: string) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      if (receipt.status !== 'success') return;

      const tx = await publicClient.getTransaction({ hash: txHash as Hex });
      
      const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
      const walletLower = walletAddress.toLowerCase();
      
      let wethSpent = 0n;
      let wethReceived = 0n;
      
      // Native ETH tracking
      if (tx.from.toLowerCase() === walletLower && tx.value > 0n) {
        wethSpent += tx.value;
      }
      
      // We will map which tokens left the wallet and which tokens arrived
      const tokensAcquired = new Map<string, bigint>();
      const tokensSpent = new Map<string, bigint>();

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
              if (tokenAddr === WETH_ADDRESS) wethSpent += value;
              else {
                const current = tokensSpent.get(tokenAddr) || 0n;
                tokensSpent.set(tokenAddr, current + value);
              }
            }
            
            if (toAddr === walletLower) {
              if (tokenAddr === WETH_ADDRESS) wethReceived += value;
              else {
                const current = tokensAcquired.get(tokenAddr) || 0n;
                tokensAcquired.set(tokenAddr, current + value);
              }
            }
          }
        } catch (e) {
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

    } catch (e: any) {
      console.error(`[Tracker] ❌ Failed to analyze receipt for ${txHash}: ${e.message}`);
    }
  }

  private async emitSignal(tokenIn: string, tokenOut: string, amountIn: bigint, walletAddress: string, trackedWallet: any, timestamp: number, txHash: string) {
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
      } catch (e: any) {}
      
      this.lastBuyTime.set(`${walletAddress}-${tokenOut}`, timestamp);

      if (this.onCopyBuySignal) {
        this.onCopyBuySignal(walletAddress, tokenOut, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
      }
    } else if (tokenOut === WETH_ADDRESS) {
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
      } catch (e: any) {}
      
      WalletProfiler.processSell(walletAddress, tokenIn, txHash);

      const buyTime = this.lastBuyTime.get(`${walletAddress}-${tokenIn}`);
      if (buyTime && (timestamp - buyTime < 120000)) {
        const msg = `Anti-farm triggered: ${trackedWallet.label || walletAddress} flipped ${tokenIn} in < 2 min. Demoting to Tier 3.`;
        console.warn(`[Tracker] 🚨 ` + msg);
        dbLogger.warn(msg, { wallet: walletAddress, token: tokenIn });
        prisma.trackedWallet.update({
          where: { address: walletAddress },
          data: { tier: 3 }
        }).catch(e => {});
      }

      if (this.onCopySellSignal) {
        this.onCopySellSignal(walletAddress, tokenIn, amountIn, trackedWallet.tier, trackedWallet.bundleId, timestamp, txHash);
      }
    } else {
      console.log(`[Tracker] 🚫 Ignored SWAP (No WETH involved): ${walletAddress} swapped ${tokenIn} for ${tokenOut} | TX: https://robinhoodchain.blockscout.com/tx/${txHash}`);
    }
  }
}
