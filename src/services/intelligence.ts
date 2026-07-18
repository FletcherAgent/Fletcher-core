import * as dotenv from 'dotenv';
dotenv.config();

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

export type SentimentResult = {
  score: number; // 1-100
  label: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reasoning: string;
};

export class IntelligenceLayer {
  private static getApiKey(): string {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error('XAI_API_KEY is missing in .env');
    return key;
  }

  /**
   * Evaluates the social sentiment of a specific token using Grok.
   */
  static async analyzeSentiment(tokenSymbol: string, tokenAddress: string): Promise<SentimentResult> {
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

      const data = await response.json();
      const content = data.choices[0].message.content.trim();
      
      // Parse JSON
      let result: SentimentResult;
      try {
        result = JSON.parse(content);
      } catch (e) {
        // Fallback cleanup if Grok returns markdown blocks
        const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
        result = JSON.parse(cleaned);
      }

      return result;
    } catch (error) {
      console.error(`[IntelligenceLayer] Failed to analyze sentiment for ${tokenSymbol}:`, error);
      return { score: 50, label: 'NEUTRAL', reasoning: 'Failed to fetch sentiment data.' };
    }
  }

  /**
   * Evaluates whether a discovered wallet is profitable enough to copy.
   */
  static async evaluateWallet(walletData: any): Promise<{ approved: boolean; reasoning: string }> {
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

      const data = await response.json();
      const content = data.choices[0].message.content.trim();
      
      let result;
      try {
        result = JSON.parse(content);
      } catch (e) {
        const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
        result = JSON.parse(cleaned);
      }

      return result;
    } catch (error) {
      console.error(`[IntelligenceLayer] Failed to evaluate wallet:`, error);
      return { approved: false, reasoning: 'Failed to evaluate wallet metrics.' };
    }
  }
}
