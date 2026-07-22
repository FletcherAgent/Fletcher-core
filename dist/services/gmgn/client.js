import { gotScraping } from 'got-scraping';
import { SessionManager } from './sessionManager.js';
import * as dotenv from 'dotenv';
dotenv.config();
const BASE_URL = 'https://gmgn.ai/defi/quotation/v1';
// Circuit breaker state
let consecutiveFailures = 0;
let degradationUntil = 0;
const DEGRADATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export async function gmgnClientGet(path, params, retries = 1) {
    // 1. Circuit Breaker Check
    if (Date.now() < degradationUntil) {
        throw new Error('[GMGN Client] 🛑 DEGRADATION MODE ACTIVE. GMGN API is paused.');
    }
    try {
        const session = await SessionManager.getSession();
        const url = new URL(`${BASE_URL}${path}`);
        if (params) {
            for (const [k, v] of Object.entries(params))
                url.searchParams.set(k, v);
        }
        // Format cookies into a string
        const cookieString = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const response = await gotScraping({
            url: url.toString(),
            method: 'GET',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://gmgn.ai/',
                'User-Agent': session.userAgent,
                'Cookie': cookieString
            },
            // got-scraping handles the TLS fingerprinting automatically
            responseType: 'json',
            throwHttpErrors: false // We will handle them manually
        });
        if (response.statusCode === 200) {
            // Success, reset circuit breaker
            consecutiveFailures = 0;
            return response.body;
        }
        if (response.statusCode === 403 || response.statusCode === 503) {
            console.warn(`[GMGN Client] ⚠️ ${response.statusCode} Blocked by Cloudflare on ${path}.`);
            if (retries > 0) {
                console.log(`[GMGN Client] 🔄 Forcing session refresh and retrying...`);
                // Force refresh session
                await SessionManager.getSession(true);
                // Wait a bit before retry
                await new Promise(r => setTimeout(r, 2000));
                return gmgnClientGet(path, params, retries - 1);
            }
        }
        throw new Error(`[GMGN Client] HTTP ${response.statusCode}: ${JSON.stringify(response.body)}`);
    }
    catch (error) {
        consecutiveFailures++;
        console.error(`[GMGN Client] ❌ Request failed (${consecutiveFailures}/5):`, error.message);
        if (consecutiveFailures >= 5) {
            console.error(`[GMGN Client] 🚨 5 CONSECUTIVE FAILURES. ACTIVATING DEGRADATION MODE FOR 10 MINUTES.`);
            degradationUntil = Date.now() + DEGRADATION_COOLDOWN_MS;
            // TODO: Send Telegram Alert here if needed
        }
        throw error;
    }
}
