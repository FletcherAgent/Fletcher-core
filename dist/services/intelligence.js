import * as dotenv from 'dotenv';
import { prisma } from '../core/db.js';
dotenv.config();
const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
export class IntelligenceLayer {
    static getApiKey() {
        const key = process.env.XAI_API_KEY;
        if (!key)
            throw new Error('XAI_API_KEY is missing in .env');
        return key;
    }
    /**
     * Evaluates the social sentiment of a specific token using Grok.
     */
    static async analyzeSentiment(tokenSymbol, tokenAddress) {
        try {
            const config = await prisma.systemConfig.findUnique({ where: { key: 'GROK_ENABLED' } });
            if (config && config.value === 'false') {
                console.log(`[IntelligenceLayer] GROK_ENABLED is false. Bypassing Grok analysis for ${tokenSymbol}.`);
                return { score: 100, label: 'BULLISH', reasoning: 'Grok LLM is disabled by configuration. Auto-approving.' };
            }
        }
        catch (e) {
            console.warn(`[IntelligenceLayer] Failed to read GROK_ENABLED from DB, defaulting to enabled.`);
        }
        const prompt = `
You are an autonomous LP (Liquidity Provider) intelligence engine for Robinhood Chain (Arbitrum Orbit L2). 
Your role is to analyze lowcap tech-narrative tokens and output dynamic LP positioning decisions for Uniswap V3 concentrated liquidity pools (with future planning for V4 hooks).
You actively hunt for high-yield opportunities: pools with strong sustained volume and high fee APR relative to TVL.

ARCHITECTURE NOTE (Uniswap V3 adapted for V4 roadmap):
- TODO(V4): Currently operating on V3. Once migrating to V4, pools will live in a singleton contract and rebalancing can be triggered via hooks.
- TODO(V4): Fee tiers on V4 can be dynamic via hooks. For now on V3, rely on standard tiers (1%, 0.3%, 0.05%).
- Always evaluate the fundamental tech narrative to determine if the token is a sustainable LP target.

SCOPE: Only analyze tokens that meet ALL of the following:
- Token contract: ${tokenAddress}
- Token name: ${tokenSymbol}

OPPORTUNITY HUNTING (APR + VOLUME):
High yield comes from volume flowing through liquidity, hunt by these metrics:
- vol_tvl_ratio = 7d_avg_daily_volume / current_TVL
- est_apr_pct = (7d_avg_daily_volume × fee_tier × 365 / TVL) × 100
- High volume + rising 7d trend + healthy holder distribution = priority target.

ANTI-OVERFITTING RULES (MANDATORY - never violate these):
- Never use less than 30-day volatility window for range calculation. If <30 days of data exists, use CONSERVATIVE fallback.
- Never increase position size because recent fee APR looks high. Fee APR is lagging, not predictive.
- If volume spiked in last 48h, treat as NOISE unless sustained 7d+ trend.
- Cap confidence at 75 if token is less than 14 days old.

DYNAMIC RANGE LOGIC & FEE TIER:
- Calculate baseline range width using 30-day realized volatility.
- Default to 1% fee tier for lowcap tech tokens (high volatility premium).
- Only suggest 0.3% if 30d daily volume consistently > $100K AND vol is low.

TECH NARRATIVE SCORING (0-100):
- Core tech (AI model, autonomous agent, GPU compute, DePIN infrastructure): 80-100
- Adjacent tech (data marketplace, oracle, DeFi, DEX, RWA): 60-79
- Soft tech / No tech: 0-59. If score < 30, reject.

Respond ONLY in the following strict JSON format, with no markdown, no extra text.
(Note: 'label' and 'score' are mandatory for the current bot architecture compatibility).

{
  "label": "<BULLISH (for ENTER_LP) | NEUTRAL (for HOLD) | BEARISH (for REJECT)>",
  "score": <number 0-100, representing confidence / opportunity score>,
  "reasoning": "<2-3 sentences: why this decision, what drove the range and opportunity score, and one anti-overfitting note>",
  "est_apr_pct": <number: projected APR from 7d avg volume>,
  "vol_tvl_ratio": <number: 7d avg daily volume divided by TVL>,
  "tech_score": <number 0-100>,
  "fee_tier_suggestion": "<1% | 0.3% | 0.05%>",
  "position_size_multiplier": <0.25 | 0.5 | 0.75 | 1.0>
}
`;
        try {
            const response = await fetch(GROK_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getApiKey()}`
                },
                body: JSON.stringify({
                    model: 'grok-4.3',
                    messages: [
                        { role: 'system', content: 'You are a highly capable AI specialized in crypto sentiment analysis.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2
                })
            });
            if (!response.ok) {
                throw new Error(`Grok API Error: ${response.statusText}`);
            }
            let data;
            try {
                data = await response.json();
            }
            catch (e) {
                throw new Error(`Failed to parse Grok API response: ${e.message}`);
            }
            const content = data.choices?.[0]?.message?.content?.trim() || '';
            if (!content) {
                throw new Error('Grok API returned empty content.');
            }
            // Parse JSON
            let result;
            try {
                result = JSON.parse(content);
            }
            catch (e) {
                // Fallback cleanup if Grok returns markdown blocks
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    result = JSON.parse(match[0]);
                }
                else {
                    throw new Error(`Could not extract JSON from Grok response: ${content}`);
                }
            }
            return result;
        }
        catch (error) {
            console.error(`[IntelligenceLayer] Failed to analyze sentiment for ${tokenSymbol}:`, error.message);
            return { score: 0, label: 'NEUTRAL', reasoning: 'Failed to fetch sentiment data.' };
        }
    }
    /**
     * Evaluates whether a discovered wallet is profitable enough to copy.
     */
    static async evaluateWallet(walletData) {
        const prompt = `
You are an expert on-chain copy-trading risk manager.
Review the following wallet metrics and decide if we should automatically copy-trade this wallet.
Metrics: ${JSON.stringify(walletData, null, 2)}

Rules for approval:
- Win rate must be > 55%
- Realized PnL should be positive
- The wallet should have more than just a few lucky trades.

Respond ONLY in strict JSON format:
{
  "approved": <boolean>,
  "reasoning": "<short explanation>"
}
`;
        try {
            const response = await fetch(GROK_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getApiKey()}`
                },
                body: JSON.stringify({
                    model: 'grok-4.3',
                    messages: [
                        { role: 'system', content: 'You are an expert on-chain risk management AI.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.1
                })
            });
            if (!response.ok) {
                throw new Error(`Grok API Error: ${response.statusText}`);
            }
            let data;
            try {
                data = await response.json();
            }
            catch (e) {
                throw new Error(`Failed to parse Grok API response: ${e.message}`);
            }
            const content = data.choices?.[0]?.message?.content?.trim() || '';
            if (!content) {
                throw new Error('Grok API returned empty content.');
            }
            let result;
            try {
                result = JSON.parse(content);
            }
            catch (e) {
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    result = JSON.parse(match[0]);
                }
                else {
                    throw new Error(`Could not extract JSON from Grok response: ${content}`);
                }
            }
            return result;
        }
        catch (error) {
            console.error(`[IntelligenceLayer] Failed to evaluate wallet:`, error.message);
            return { approved: false, reasoning: 'Failed to evaluate wallet metrics.' };
        }
    }
}
