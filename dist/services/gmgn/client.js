import crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();
const BASE_URL = 'https://openapi.gmgn.ai/v1';
// Circuit breaker state
let consecutiveFailures = 0;
let degradationUntil = 0;
const DEGRADATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export async function gmgnClientGet(path, params, retries = 1) {
    // 1. Circuit Breaker Check
    if (Date.now() < degradationUntil) {
        throw new Error('[GMGN OpenAPI Client] 🛑 DEGRADATION MODE ACTIVE. GMGN API is paused.');
    }
    const apiKey = process.env.GMGN_API_KEY;
    if (!apiKey) {
        throw new Error('[GMGN OpenAPI Client] Missing GMGN_API_KEY in environment variables.');
    }
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const clientId = crypto.randomUUID();
        const url = new URL(`${BASE_URL}${path}`);
        if (params) {
            for (const [k, v] of Object.entries(params))
                url.searchParams.set(k, v);
        }
        // OpenAPI requires these query params for exist auth
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('client_id', clientId);
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'X-APIKEY': apiKey,
                'Content-Type': 'application/json',
                'User-Agent': 'gmgn-cli/1.0.0'
            }
        });
        if (response.status === 200) {
            const data = await response.json();
            if (data.code === 0) {
                // Success, reset circuit breaker
                consecutiveFailures = 0;
                return (data.data !== undefined ? data.data : data);
            }
            else {
                throw new Error(`API Error: ${data.message || data.error} (code: ${data.code})`);
            }
        }
        if (response.status === 429) {
            console.warn(`[GMGN OpenAPI Client] ⚠️ 429 Rate Limit on ${path}.`);
            if (retries > 0) {
                // Wait a bit before retry
                await new Promise(r => setTimeout(r, 2000));
                return gmgnClientGet(path, params, retries - 1);
            }
        }
        const text = await response.text();
        throw new Error(`[GMGN OpenAPI Client] HTTP ${response.status}: ${text}`);
    }
    catch (error) {
        consecutiveFailures++;
        console.error(`[GMGN OpenAPI Client] ❌ Request failed (${consecutiveFailures}/5):`, error.message);
        if (consecutiveFailures >= 5) {
            console.error(`[GMGN OpenAPI Client] 🚨 5 CONSECUTIVE FAILURES. ACTIVATING DEGRADATION MODE FOR 10 MINUTES.`);
            degradationUntil = Date.now() + DEGRADATION_COOLDOWN_MS;
            // Send Telegram Alert
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (botToken && chatId) {
                const msg = `⚠️ *GMGN OpenAPI Access Failed* ⚠️\n\nThe GMGN OpenAPI failed after 5 retries. Bot has activated *Degradation Mode* and will use GeckoTerminal & DexScreener as fallbacks for the next 10 menit.`;
                fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
                }).catch(err => console.error('[GMGN OpenAPI Client] Failed to send Telegram alert', err));
            }
        }
        throw error;
    }
}
