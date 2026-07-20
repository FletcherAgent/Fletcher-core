import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Bot } from 'grammy';
import * as dotenv from 'dotenv';
import { getTokenInfo } from '../services/gmgn.js';
import { IntelligenceLayer } from '../services/intelligence.js';
dotenv.config();

import { Orchestrator } from '../core/orchestrator.js';

let client: TelegramClient | null = null;

/**
 * Start Userbot Listener
 * @param fletcherBot Grammy bot instance to send notifications to the user
 * @param orchestrator Orchestrator instance to process spot buys
 */
export async function startUserbot(fletcherBot: Bot, orchestrator: Orchestrator) {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionStr = process.env.TELEGRAM_SESSION || '';
  const targetGroupStr = process.env.TELEGRAM_ALPHA_GROUP_ID || '';
  const ownerChatId = process.env.TELEGRAM_OWNER_ID || ''; // Your Telegram ID to receive alerts

  if (!apiId || !apiHash || !sessionStr) {
    console.log('⚠️ [Userbot] Incomplete configuration (API_ID, API_HASH, or SESSION is missing). Userbot is not running.');
    return;
  }

  const stringSession = new StringSession(sessionStr);
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    console.log('✅ [Userbot] Successfully connected using Session. Waiting for signals...');
    
    // Ensure targetGroup is valid (can be an ID number or username)
    // If it's a negative number (e.g., -100123...), we parse it to BigInt
    let targetGroupId: any = targetGroupStr;
    if (/^-?\d+$/.test(targetGroupStr)) {
      // GramJS can use ID numbers directly
      targetGroupId = parseInt(targetGroupStr);
    }

    client.addEventHandler(async (event: NewMessageEvent) => {
      const message = event.message;
      const text = message.text || '';
      
      // Filter out signals that don't have "scarp" as verified caller
      let isScarp = text.toLowerCase().includes('scarp');
      if (!isScarp) {
        try {
          const sender = await message.getSender();
          const username = (sender as any)?.username?.toLowerCase() || '';
          const firstName = (sender as any)?.firstName?.toLowerCase() || '';
          if (username.includes('scarp') || firstName.includes('scarp') || username.includes('maxcashguy')) {
            isScarp = true;
          }
        } catch (e) {
          // Ignore if sender cannot be fetched
        }
      }

      if (!isScarp) {
        return;
      }

      // Regex to find EVM address (0x followed by 40 hex characters)
      const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
      if (!addressMatch) return;
      
      const tokenAddress = addressMatch[0];
      console.log(`[Userbot] 🚨 Signal detected! Address: ${tokenAddress}`);

      // Ask Fletcher to verify
      console.log(`[Userbot] Verifying ${tokenAddress} with DexScreener/GoPlus...`);
      const tokenInfo = await getTokenInfo(tokenAddress);
      
      if (!tokenInfo) {
        console.log(`[Userbot] ❌ Token ${tokenAddress} not found or no pool exists yet.`);
        return;
      }

      // Basic safety filter
      if (tokenInfo.isHoneypot) {
        console.log(`[Userbot] ❌ Token ${tokenAddress} detected as HONEYPOT! Ignoring.`);
        return;
      }

      // Grok Sentiment Layer verification
      console.log(`[Userbot] Running Grok XAI to check token quality...`);
      const sentiment = await IntelligenceLayer.analyzeSentiment(tokenInfo.symbol, tokenAddress);
      
      if (sentiment.score < 50) {
        console.log(`[Userbot] ❌ Token ${tokenAddress} rejected by Grok XAI (Score ${sentiment.score}: ${sentiment.reasoning})`);
        return;
      }

      // Passed all verifications! Send alert via Grammy Bot
      if (ownerChatId) {
        const msg = `🚨 <b>ALPHA SPOT SIGNAL DETECTED!</b> 🚨\n\n` +
                    `🗣️ <b>Caller:</b> Scarp (@MaxCashGuy)\n` +
                    `<b>Token:</b> ${tokenInfo.symbol} (${tokenInfo.name})\n` +
                    `<b>Contract:</b> <code>${tokenAddress}</code>\n` +
                    `<b>Market Cap:</b> $${(tokenInfo.marketCap / 1000).toFixed(1)}K\n` +
                    `<b>Liquidity:</b> $${(tokenInfo.liquidity / 1000).toFixed(1)}K\n` +
                    `<b>Volume 24h:</b> $${(tokenInfo.volume24h / 1000).toFixed(1)}K\n\n` +
                    `🧠 <b>Grok XAI Analysis (Score: ${sentiment.score}):</b>\n` +
                    `<i>${sentiment.reasoning}</i>`;

        try {
          await fletcherBot.api.sendMessage(ownerChatId, msg, { parse_mode: 'HTML' });
          console.log(`[Userbot] ✅ Signal report successfully sent to Owner!`);
        } catch (botErr) {
          console.error(`[Userbot] Failed to send message via Grammy:`, botErr);
        }
      }

      // Trigger Spot Buy via Orchestrator
      console.log(`[Userbot] 🚀 Triggering Alpha Spot Buy for ${tokenInfo.symbol}...`);
      await orchestrator.processAlphaSpotSignal(tokenAddress, sentiment.score);

    }, new NewMessage({ chats: targetGroupStr ? [targetGroupId] : [] })); // If targetGroup is empty, it listens to ALL groups (dangerous).

  } catch (err) {
    console.error('❌ [Userbot] Failed to connect:', err);
  }
}
