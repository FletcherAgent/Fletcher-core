/**
 * This script is used ONLY ONCE to login to Telegram using your phone number.
 * Upon success, this script will provide a long STRING_SESSION.
 * Save that STRING_SESSION into your .env file.
 *
 * Usage:
 * 1. Open terminal in fletcher-core folder
 * 2. Run command: npx ts-node src/bot/userbot-auth.ts
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
// @ts-ignore
import input from 'input';
import * as dotenv from 'dotenv';
dotenv.config();
const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
const apiHash = process.env.TELEGRAM_API_HASH || '';
const stringSession = new StringSession(''); // Leave blank for the first login
if (!apiId || !apiHash) {
    console.error("❌ ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env");
    process.exit(1);
}
console.log("Preparing Telegram login process...");
const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
});
async function main() {
    await client.start({
        phoneNumber: async () => await input.text('Please enter your phone number (with country code, e.g. +123...): '),
        password: async () => await input.text('Please enter your 2FA password (leave blank if none): '),
        phoneCode: async () => await input.text('Please enter the OTP code sent to your Telegram: '),
        onError: (err) => console.log('❌ Login Error:', err),
    });
    console.log('✅ You have successfully logged in!');
    const session = client.session.save();
    console.log('\n======================================================');
    console.log('👉 SAVE THE CODE BELOW TO YOUR .env FILE AS TELEGRAM_SESSION:\n');
    console.log(session);
    console.log('======================================================\n');
    console.log('After saving to .env, you can close this script (Ctrl+C).');
    process.exit(0);
}
main();
