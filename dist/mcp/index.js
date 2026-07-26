import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recommendTopPools, buildLpTransaction } from './tools.js';
export const mcpServer = new McpServer({
    name: "fletcher-mcp",
    version: "1.0.0"
});
// Tool 1: recommend_top_pools
mcpServer.tool("recommend_top_pools", "Get the top 5 trending LP pools on Robinhood chain with highest APR/Volume", {}, async () => {
    const result = await recommendTopPools();
    return {
        content: [{ type: "text", text: result }]
    };
});
// Tool 2: build_lp_transaction
mcpServer.tool("build_lp_transaction", "Build an unsigned transaction payload for the user to open an LP position. The result contains an executeUrl that the AI should provide to the user as a clickable link.", {
    token0: z.string().describe("Address of token0"),
    token1: z.string().describe("Address of token1"),
    feeTier: z.number().describe("Fee tier (e.g. 10000 for 1%, 3000 for 0.3%)"),
    tickLower: z.number().describe("Lower tick bound"),
    tickUpper: z.number().describe("Upper tick bound"),
    amount0Desired: z.string().describe("Amount of token0 to provide (e.g. '1.5')"),
    amount1Desired: z.string().describe("Amount of token1 to provide (e.g. '0.5')"),
    userAddress: z.string().describe("The wallet address of the user who will sign the tx")
}, async (args) => {
    const result = await buildLpTransaction({
        ...args,
        token0: args.token0,
        token1: args.token1,
        userAddress: args.userAddress
    });
    return {
        content: [{ type: "text", text: result }]
    };
});
