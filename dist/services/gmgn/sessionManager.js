import { chromium } from 'playwright';
import { prisma } from '../../core/db.js';
const SESSION_KEY = 'gmgn.session';
export class SessionManager {
    static session = null;
    static isRefreshing = false;
    static async getSession(forceRefresh = false) {
        if (!forceRefresh && this.session && this.session.expiresAt > Date.now()) {
            return this.session;
        }
        // Try loading from DB first
        if (!forceRefresh && !this.session) {
            const dbRecord = await prisma.systemConfig.findUnique({ where: { key: SESSION_KEY } });
            if (dbRecord) {
                try {
                    const parsed = JSON.parse(dbRecord.value);
                    if (parsed.expiresAt > Date.now()) {
                        this.session = parsed;
                        console.log('[SessionManager] 📦 Loaded active GMGN session from Database');
                        return this.session;
                    }
                }
                catch (e) {
                    console.warn('[SessionManager] Failed to parse session from DB', e);
                }
            }
        }
        if (this.isRefreshing) {
            // Wait for the ongoing refresh to finish
            while (this.isRefreshing) {
                await new Promise(r => setTimeout(r, 500));
            }
            return this.session;
        }
        console.log('[SessionManager] 🔄 Refreshing GMGN Session (Cloudflare Challenge)...');
        this.isRefreshing = true;
        try {
            const session = await this.performCloudflareBypass();
            this.session = session;
            // Save to database
            await prisma.systemConfig.upsert({
                where: { key: SESSION_KEY },
                update: { value: JSON.stringify(session) },
                create: { key: SESSION_KEY, value: JSON.stringify(session) }
            });
            console.log('[SessionManager] ✅ New GMGN session acquired and saved');
            return session;
        }
        finally {
            this.isRefreshing = false;
        }
    }
    static async performCloudflareBypass() {
        const browser = await chromium.launch({
            headless: true, // Use headless in Railway
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();
        try {
            await page.goto('https://gmgn.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait for a typical element on gmgn.ai that indicates the page loaded past Cloudflare
            // or wait for the cf_clearance cookie to appear.
            console.log('[SessionManager] Waiting for Cloudflare challenge to pass...');
            // Wait up to 20 seconds for the cookie to be set
            let cookies = await context.cookies();
            let cfCookie = cookies.find(c => c.name === 'cf_clearance');
            let retries = 0;
            while (!cfCookie && retries < 20) {
                await new Promise(r => setTimeout(r, 1000));
                cookies = await context.cookies();
                cfCookie = cookies.find(c => c.name === 'cf_clearance');
                retries++;
            }
            if (!cfCookie) {
                throw new Error('Failed to acquire cf_clearance cookie after 20 seconds');
            }
            // TTL: Set session to expire in 1 hour or when cookie expires, whichever is sooner
            const expiresAt = Date.now() + (60 * 60 * 1000);
            return {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                cookies: cookies,
                expiresAt
            };
        }
        finally {
            await browser.close();
        }
    }
}
