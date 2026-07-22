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
You are a crypto sentiment analysis engine. Analyze the current social sentiment and narrative around the token $${tokenSymbol} (Contract: ${tokenAddress}) on X (Twitter).
Respond ONLY in the following strict JSON format, with no markdown formatting or extra text:
{
  "score": <number between 1-100, where 100 is extremely bullish>,
  "label": "<BULLISH or BEARISH or NEUTRAL>",
  "reasoning": "<short 2 sentence explanation of the sentiment>"
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
