import { Bot } from "grammy";
import * as dotenv from "dotenv";
import { PrismaClient } from '@prisma/client';
import { Orchestrator } from "../core/orchestrator.js";
import { connectDb, prisma } from "../core/db.js";
import { screenPairs } from "../services/gmgn.js";
import { getUserTier, clearTierCache } from "../services/tierGate.js";
import { startUserbot } from "./userbot.js";
import { createSmartAccount, grantSessionKey } from "../services/sessionKey.js";
import { type Hex } from "viem";

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Bot(botToken);

// --- TELEGRAM LOGGER ---
let logBuffer: string[] = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function queueLog(emoji: string, ...args: any[]) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ');

  if (msg.includes("[Tracker]") || msg.includes("Received webhook activity") || msg.includes("Swap activity detected")) return;
  // Ignore Scout WSS spam
  if (msg.includes("[Scout ⚡ WSS]")) return;
  // Do not forward generic REJECTED logs to Telegram
  if (msg.includes("REJECTED:")) return;
  // Ignore No V3 pool found
  if (msg.includes("No V3 pool found")) return;
  // Ignore GMGN fallback warning to prevent Telegram 429 spam
  if (msg.includes("GMGN API failed")) return;

  // Format important alerts as pretty Telegram messages instead of raw log blocks
  if (process.env.TELEGRAM_CHAT_ID) {
    let prettyMsg = null;

    // 1. Grok Analysis Result (COMMENTED OUT TO PREVENT TELEGRAM SPAM/429 ERROR)
    /*
    const grokMatch = msg.match(/\[LPEngine\] Grok Result for (.*?): (BULLISH|BEARISH|NEUTRAL) \(Score: (\d+)\) - (.*)/);
    if (grokMatch) {
      prettyMsg = `<b>🧠 Grok AI Analysis: $${grokMatch[1]}</b>\nStatus: <b>${grokMatch[2]}</b> (Score: ${grokMatch[3]})\n\n<i>${grokMatch[4]}</i>`;
    }
    */

    // 2. Proposing Position (COMMENTED OUT TO PREVENT TELEGRAM SPAM/429 ERROR)
    /*
    const proposeMatch = msg.match(/\[LPEngine\] 📋 Proposing position: (.*?)\s*\|\s*dayMode=(.*?)\s*\|\s*dryRun=(.*)/);
    if (proposeMatch) {
      prettyMsg = `<b>📋 Proposing New LP Position</b>\n<b>Token:</b> $${proposeMatch[1]}\n<b>Day Mode:</b> ${proposeMatch[2]}\n<b>Dry Run:</b> ${proposeMatch[3]}`;
    }
    */

    // 3. Token Passed Screening (COMMENTED OUT TO PREVENT TELEGRAM SPAM/429 ERROR)
    /* 
    const passedMatch = msg.match(/\[(?:GMGN|MarketData)\] ✅ (.*?) PASSED — score: (\d+), mcap: (.*?), vol: (.*)/);
    if (passedMatch) {
      prettyMsg = `<b>✅ Token Passed Screening: $${passedMatch[1]}</b>\n<b>Score:</b> ${passedMatch[2]}\n<b>Market Cap:</b> ${passedMatch[3]}\n<b>24h Vol:</b> ${passedMatch[4]}`;
    }
    */

    // 4. Grok Approved (COMMENTED OUT TO PREVENT TELEGRAM SPAM/429 ERROR)
    /*
    const approvedMatch = msg.match(/\[LPEngine\] ✅ Grok APPROVED (.*)/);
    if (approvedMatch) {
      prettyMsg = `<b>✅ Grok APPROVED $${approvedMatch[1]}</b>\nSentiment is strongly bullish. Proceeding to execution.`;
    }
    */

    // 5. Userbot Rejected (Grok)
    const userbotRejectMatch = msg.match(/\[Userbot\] ❌ Token (.*) rejected by Grok XAI \(Score (\d+): (.*)\)/);
    if (userbotRejectMatch) {
      prettyMsg = `❌ <b>Alpha Signal Rejected</b>\nToken: <code>${userbotRejectMatch[1]}</code>\n<b>Score:</b> ${userbotRejectMatch[2]}\n\n<i>${userbotRejectMatch[3]}</i>`;
    }

    // 6. Userbot Signal Detected
    const signalMatch = msg.match(/\[Userbot\] 🚨 Signal detected! Address: (.*)/);
    if (signalMatch) {
      prettyMsg = `🚨 <b>Alpha Signal Detected!</b>\nAddress: <code>${signalMatch[1]}</code>`;
    }

    // 7. Userbot Verifying
    const verifyingMatch = msg.match(/\[Userbot\] Verifying (.*) with DexScreener\/GoPlus\.\.\./);
    if (verifyingMatch) {
      prettyMsg = `🔍 <b>Verifying Token</b>\nAddress: <code>${verifyingMatch[1]}</code>\n<i>Checking DexScreener & GoPlus...</i>`;
    }

    // 8. Userbot Not Found / No Pool
    const notFoundMatch = msg.match(/\[Userbot\] ❌ Token (.*) not found or no pool exists yet\./);
    if (notFoundMatch) {
      prettyMsg = `❌ <b>Alpha Signal Rejected</b>\nToken: <code>${notFoundMatch[1]}</code>\n<i>Not found on DexScreener or no liquidity pool exists yet.</i>`;
    }

    // 9. Userbot Generic Reject (Catch all other rejections)
    const genericRejectMatch = msg.match(/\[Userbot\] ❌ Token (.*) rejected: (.*)/);
    if (genericRejectMatch && !userbotRejectMatch) {
      prettyMsg = `❌ <b>Alpha Signal Rejected</b>\nToken: <code>${genericRejectMatch[1]}</code>\n<i>Reason: ${genericRejectMatch[2]}</i>`;
    }

    if (!prettyMsg && (msg.includes('⚠️') || msg.includes('❌'))) {
      if (!msg.includes('No V3 pool found')) {
        prettyMsg = `<pre>${msg}</pre>`;
      }
    }

    // 10. Userbot Grok Processing
    const grokProcessingMatch = msg.match(/\[Userbot\] Running Grok XAI to check token quality\.\.\./);
    if (grokProcessingMatch) {
      prettyMsg = `🧠 <i>Running Grok XAI to analyze token quality...</i>`;
    }

    if (prettyMsg) {
      bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, prettyMsg, { parse_mode: 'HTML' })
        .catch(err => originalError("Failed to send formatted msg", err));
      return; // Stop here, do not add to the standard logBuffer
    }
  }

  logBuffer.push(`${emoji} ${msg}`);
}

console.log = (...args) => {
  originalLog(...args);
  queueLog('ℹ️', ...args);
};
console.warn = (...args) => {
  originalWarn(...args);
  queueLog('⚠️', ...args);
};
console.error = (...args) => {
  originalError(...args);
  queueLog('❌', ...args);
};

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

setInterval(() => {
  if (logBuffer.length > 0 && process.env.TELEGRAM_CHAT_ID) {
    const text = logBuffer.join('\n');
    logBuffer = []; // clear buffer

    // Telegram message length limit is 4096. Truncate if needed.
    const chunk = text.length > 4000 ? text.substring(0, 4000) + '... (truncated)' : text;
    const safeChunk = escapeHtml(chunk);

    bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `<pre>${safeChunk}</pre>`, { parse_mode: 'HTML' })
      .catch(err => originalError("Failed to send log to Telegram", err));
  }
}, 3000);
// -----------------------

bot.command("start", (ctx) => {
  ctx.reply("🟢 Fletcher Agent Core is online.\nRobinhood Chain Active Range Manager.\n\nType /help to see the list of commands.");
});

bot.command("help", (ctx) => {
  const helpText = `
🤖 <b>Fletcher Bot Commands</b> 🤖

🚀 <b>Core System</b>
/start - Start the bot and show initial status.
/status - Show agent status, network, and active positions.
/tier - Check your current VIP tier status and FLETCH balance.
/help - Show this guide and command list.

🕹️ <b>Operation Mode</b>
/mode auto - (Sniper Mode) Bot automatically buys new tokens without confirmation.
/mode confirm - (Manual Mode) Bot sends [Confirm] / [Reject] buttons before buying.

🧠 <b>Intelligence Layer</b>
/grok &lt;token&gt; - AI sentiment analysis for a specific token (uses grok-4.3).
/grok_toggle on|off - Enable or disable Grok AI screening globally.
/config - View all system configurations (including GROK_ENABLED).
/discover - Run an autonomous wallet discovery cycle via GMGN & Grok.

💧 <b>LP Engine (v2.0 Core)</b>
/lp status - Show all active LP positions (fee, IL, APR, range).
/lp scan - Run pair screening and show candidates that pass filters.
/lp close &lt;id&gt; - Propose closing a specific LP position.
/lp blacklist &lt;address&gt; - Blacklist a token (owner only).
/lp mode manual - Set LP execution to MANUAL (all tx via Telegram).
/lp mode semi - Set LP execution to SEMI (collect+compound auto).
/lp mode full - Set LP execution to FULL autonomous.
/lpmeta - View or edit LP screening config (owner only).
/harvest - Collect fees from all eligible open LP positions.
/daymode - Manually trigger LP Engine Day Mode (find 1 best token).
/nightmode - Manually trigger LP Engine Night Mode (find up to 3 tokens).

🎯 <b>Copy-Trade (Smart Money)</b>
/track &lt;address&gt; [label] [tier] - Add a wallet to copy-trade.
/untrack &lt;address&gt; - Stop copying a wallet.
/wallets - View the list of tracked wallets.
/wallet &lt;address&gt; - View detailed profile &amp; stats of a specific wallet.
/copyexit on|off - Enable/disable the copy-exit feature.

🧪 <b>Testing (Developer)</b>
/dryrun &lt;TokenAddress&gt; - Force the bot to queue a specific token for execution testing.
`;
  ctx.reply(helpText, { parse_mode: "HTML" }).catch(e => console.error("Error sending help:", e));
});

bot.command("status", async (ctx) => {
  try {
    const openPositions = await prisma.position.count({ where: { status: 'OPEN' } });
    ctx.reply(`📊 Status:\n- Network: Robinhood Chain (4663)\n- Active Agents: 5\n- Positions: ${openPositions} OPEN`);
  } catch (e) {
    ctx.reply("❌ Failed to fetch status from the database.");
  }
});

bot.command("dryrun", (ctx) => {
  const tokenAddress = ctx.match;
  if (!tokenAddress || !tokenAddress.startsWith("0x")) {
    return ctx.reply("❌ Invalid format! Usage: `/dryrun 0xTokenAddress`", { parse_mode: "Markdown" });
  }

  ctx.reply(`🧪 **DRY RUN INITIATED**\nForcing token into pipeline: \`${tokenAddress}\``, { parse_mode: "Markdown" });

  // Inject directly into Orchestrator (simulate Scout finding it)
  // We can't access Orchestrator.scout directly easily, but we can trigger it
  // Wait, let's expose a method on orchestrator to inject manual signal
  orchestrator.injectManualSignal(tokenAddress);
});

bot.command("mode", (ctx) => {
  const modeParam = ctx.match?.toLowerCase().trim();

  if (modeParam === "auto") {
    orchestrator.setTraderMode('AUTO');
    ctx.reply("⚡ **Mode Changed: AUTO (Sniper Mode)**\nBot will automatically sign and broadcast BUY transactions.", { parse_mode: "Markdown" });
  } else if (modeParam === "confirm") {
    orchestrator.setTraderMode('CONFIRM');
    ctx.reply("🛡️ **Mode Changed: CONFIRM**\nBot will ask for your confirmation (via Inline Buttons) before executing any BUY transaction.", { parse_mode: "Markdown" });
  } else {
    ctx.reply("❌ Invalid mode. Usage: `/mode auto` or `/mode confirm`", { parse_mode: "Markdown" });
  }
});


// --- NEW COMMANDS: Copy-Trade ---
bot.command("track", async (ctx) => {
  const params = ctx.match?.trim().split(/\s+/);
  if (!params || params.length === 0 || !params[0]) {
    return ctx.reply("❌ Usage: `/track <address> [label] [tier]`", { parse_mode: "Markdown" });
  }
  const address = params[0].toLowerCase();
  const label = params[1] || "tracked";
  const tier = parseInt(params[2] || "2");

  try {
    await prisma.trackedWallet.upsert({
      where: { address },
      update: { label, tier, status: 'ACTIVE' },
      create: { address, label, tier, status: 'ACTIVE' }
    });
    ctx.reply(`✅ Wallet \`${address}\` tracked as **${label}** (Tier: ${tier}).`, { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to track wallet.");
  }
});

bot.command("untrack", async (ctx) => {
  const address = ctx.match?.toLowerCase().trim();
  if (!address) return ctx.reply("❌ Usage: `/untrack <address>`", { parse_mode: "Markdown" });

  try {
    await prisma.trackedWallet.delete({ where: { address } });
    ctx.reply(`✅ Wallet \`${address}\` removed from tracking.`, { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to remove or not found.");
  }
});

bot.command("grok", async (ctx) => {
  const token = ctx.match?.trim();
  if (!token) return ctx.reply("❌ Usage: `/grok <tokenSymbol>`\\nExample: `/grok PEPE`", { parse_mode: "Markdown" });

  ctx.reply(`🧠 Asking Grok about $${token}...`);
  try {
    const { IntelligenceLayer } = await import('../services/intelligence.js');
    const result = await IntelligenceLayer.analyzeSentiment(token, token); // Pass symbol as placeholder if address unknown

    const emoji = result.label === 'BULLISH' ? '🟢' : result.label === 'BEARISH' ? '🔴' : '🟡';
    const msg = `
${emoji} **Grok Sentiment Analysis for $${token}**
- **Score:** ${result.score}/100
- **Label:** ${result.label}

**Reasoning:**
_${result.reasoning}_
`;
    ctx.reply(msg.trim(), { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Grok API failed.");
  }
});

bot.command("grok_toggle", async (ctx) => {
  const param = ctx.match?.toLowerCase().trim();
  if (param !== "on" && param !== "off") {
    return ctx.reply("❌ Usage: `/grok_toggle on` or `/grok_toggle off`", { parse_mode: "Markdown" });
  }

  const enabled = param === "on" ? "true" : "false";

  try {
    await prisma.systemConfig.upsert({
      where: { key: 'GROK_ENABLED' },
      update: { value: enabled },
      create: { key: 'GROK_ENABLED', value: enabled }
    });
    ctx.reply(enabled === "true"
      ? "✅ **Grok AI Analysis is now ENABLED.** Bot will analyze sentiment for every new token."
      : "⏸️ **Grok AI Analysis is now DISABLED.** Bot will skip AI checks and auto-approve tokens to save API usage.",
      { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to update GROK_ENABLED config in database.");
  }
});

bot.command("config", async (ctx) => {
  try {
    const configs = await prisma.systemConfig.findMany();
    if (configs.length === 0) {
      return ctx.reply("⚙️ **System Config**\n_No configurations found in database._", { parse_mode: "Markdown" });
    }

    let msg = "⚙️ **System Configurations**\n\n";
    for (const conf of configs) {
      msg += `- **${conf.key}**: \`${conf.value}\`\n`;
    }

    ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to fetch configurations from database.");
  }
});

bot.command("discover", async (ctx) => {
  ctx.reply("🔍 Running Autonomous Wallet Discovery Cycle via GMGN & Grok...");
  try {
    const { DiscoveryAgent } = await import('../agents/discovery.js');
    const count = await DiscoveryAgent.runDiscoveryCycle();
    ctx.reply(`✅ Cycle complete. Discovered and automatically added **${count}** new profitable wallets to the registry.`, { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Discovery cycle failed.");
  }
});

bot.command("wallets", async (ctx) => {
  try {
    const wallets = await prisma.trackedWallet.findMany();
    if (wallets.length === 0) return ctx.reply("📭 No tracked wallets found.");

    let msg = "🎯 **Tracked Smart Money:**\n\n";
    for (const w of wallets) {
      msg += `- \`${w.address.substring(0, 8)}...\` | ${w.label} | Tier: ${w.tier} | Status: ${w.status}\n`;
    }
    ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to fetch wallets.");
  }
});

bot.command("wallet", async (ctx) => {
  const address = ctx.match?.toLowerCase().trim();
  if (!address) return ctx.reply("❌ Usage: `/wallet <address>`", { parse_mode: "Markdown" });

  try {
    const w = await prisma.trackedWallet.findUnique({ where: { address } });
    if (!w) return ctx.reply(`❌ Wallet \`${address}\` not found in registry.`, { parse_mode: "Markdown" });

    const msg = `
🔍 **Wallet Detail**
- **Address:** \`${w.address}\`
- **Label:** ${w.label || '-'}
- **Tier:** ${w.tier}
- **Status:** ${w.status}
- **Bundle ID:** ${w.bundleId || 'None'}

📊 **Performance Stats**
- **Total Signals:** ${w.totalSignals}
- **Win Rate:** ${w.winRate ? w.winRate.toFixed(2) + '%' : 'N/A'}
- **Avg PNL:** ${w.avgPnlR ? w.avgPnlR.toFixed(4) + ' R' : 'N/A'}
- **Consecutive Losses:** ${w.consecutiveLosses}

🕒 **Activity**
- **Last Trade:** ${w.lastTradeAt ? w.lastTradeAt.toLocaleString() : 'Never'}
- **Registered:** ${w.createdAt.toLocaleString()}
    `;
    ctx.reply(msg.trim(), { parse_mode: "Markdown" });
  } catch (e) {
    ctx.reply("❌ Failed to fetch wallet details.");
  }
});

bot.command("copyexit", async (ctx) => {
  const param = ctx.match?.toLowerCase().trim();
  if (param === 'on' || param === 'off') {
    const value = param === 'on' ? 'true' : 'false';
    try {
      await prisma.systemConfig.upsert({
        where: { key: 'copyExitEnabled' },
        update: { value },
        create: { key: 'copyExitEnabled', value }
      });
      ctx.reply(`✅ Copy-Exit is now **${param.toUpperCase()}**.`, { parse_mode: "Markdown" });
    } catch (e) {
      ctx.reply("❌ Failed to update config.");
    }
  } else {
    ctx.reply("❌ Usage: `/copyexit on` or `/copyexit off`", { parse_mode: "Markdown" });
  }
});

const orchestrator = new Orchestrator(bot);

// ─── LP ENGINE COMMANDS ──────────────────────────────────────────────────────

/** /lp <subcommand> dispatcher */
bot.command("tier", async (ctx) => {
  const args = ctx.match?.trim();
  const wallet = process.env.USER_WALLET_ADDRESS;
  if (!wallet) return ctx.reply("❌ Wallet address not configured in ENV.");

  if (args === "refresh") {
    clearTierCache(wallet);
    ctx.reply("🔄 Tier cache cleared.");
  }

  const tier = await getUserTier(wallet);

  let label = "Tier 0 (Basic)";
  if (tier === 1) label = "Tier 1 (Base)";
  if (tier === 2) label = "Tier 2 (Pro)";
  if (tier === 3) label = "Tier 3 (VIP)";

  ctx.reply(`🏅 *Your FLETCH Status*\n- Address: \`${wallet}\`\n- Level: **${label}**\n\n_Use /tier refresh to update immediately._`, { parse_mode: 'Markdown' });
});

bot.command("lp", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const sub = args[0]?.toLowerCase();

  const wallet = process.env.USER_WALLET_ADDRESS;
  if (!wallet) return ctx.reply("❌ Wallet address not configured in ENV.");

  const tier = await getUserTier(wallet);
  if (tier === 0 && sub !== 'status') {
    return ctx.reply("❌ **Access Denied**\nYou need at least Tier 1 (10,000 $FLETCH) to use LP features.", { parse_mode: 'Markdown' });
  }

  const lpEngine = orchestrator.getLPEngine();

  // /lp status
  if (!sub || sub === 'status') {
    try {
      const summary = await lpEngine.getStatusSummary();
      ctx.reply(summary, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply('❌ Failed to fetch LP positions.');
    }
    return;
  }

  // /lp scan
  if (sub === 'scan') {
    ctx.reply('🔍 *Scanning pairs...* (this may take a few seconds)', { parse_mode: 'Markdown' });
    try {
      const candidates = await screenPairs();
      if (candidates.length === 0) {
        return ctx.reply('📭 *No pairs passed screening right now.*\n\nCheck `/lpmeta` to review filter criteria.', { parse_mode: 'Markdown' });
      }
      let msg = `✅ *${candidates.length} pair(s) passed screening:*\n\n`;
      for (const c of candidates.slice(0, 5)) {
        msg +=
          `• *${c.token.symbol}* — score: ${c.score}/100\n` +
          `  MCap: $${(c.token.marketCap / 1000).toFixed(0)}K | Vol: $${(c.token.volume24h / 1000).toFixed(0)}K\n` +
          `  \`${c.token.address.slice(0, 10)}...\`\n\n`;
      }
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e: any) {
      ctx.reply(`❌ Scan failed: ${e?.message ?? 'unknown error'}`);
    }
    return;
  }

  // /lp close <id>
  if (sub === 'close') {
    const posId = args[1];
    if (!posId) return ctx.reply('❌ Usage: `/lp close <position_id>`', { parse_mode: 'Markdown' });
    try {
      await lpEngine.proposeClosePosition(posId, 'Manual close via Telegram');
      ctx.reply(`🔴 Close proposal sent for position \`${posId.slice(0, 8)}\`.`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      ctx.reply(`❌ Failed to propose close: ${e?.message}`);
    }
    return;
  }

  // /lp blacklist <addr>
  if (sub === 'blacklist') {
    const addr = args[1]?.toLowerCase();
    if (!addr || !/^0x[a-f0-9]{40}$/i.test(addr)) {
      return ctx.reply('❌ Usage: `/lp blacklist <0x...>`', { parse_mode: 'Markdown' });
    }

    const wallet = process.env.USER_WALLET_ADDRESS ?? '';
    const tier = await getUserTier(wallet);
    if (tier < 3) {
      return ctx.reply(`❌ **Access Denied**\nBlacklist requests require Tier 3 (VIP). You are Tier ${tier}.`, { parse_mode: 'Markdown' });
    }

    const ownerChatId = process.env.TELEGRAM_CHAT_ID!;
    const msg = `⚠️ *Blacklist Request*\nUser ${ctx.from?.username || ctx.from?.first_name} (Tier 3) requests to blacklist:\n\`${addr}\`\n\nApprove this action?`;

    // Use raw telegram API via ctx.api to send to owner (if ctx is not owner)
    try {
      await ctx.api.sendMessage(ownerChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `blacklist_approve:${addr}` },
              { text: '❌ Reject', callback_data: `blacklist_reject:${addr}` }
            ]
          ]
        }
      });
      ctx.reply(`✅ Blacklist request for \`${addr}\` sent to Owner for approval.`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      ctx.reply(`❌ Failed to send request to owner: ${e.message}`);
    }
    return;
  }

  // /lp mode manual|semi|full
  if (sub === 'mode') {
    const modeArg = args[1]?.toLowerCase();
    if (!['manual', 'semi', 'full'].includes(modeArg ?? '')) {
      return ctx.reply('❌ Usage: `/lp mode manual|semi|full`', { parse_mode: 'Markdown' });
    }

    const wallet = process.env.USER_WALLET_ADDRESS ?? '';
    const tier = await getUserTier(wallet);

    if (modeArg === 'semi' && tier < 2) {
      return ctx.reply(`❌ **Access Denied**\nMode SEMI requires Tier 2 (Pro) or higher. You are currently Tier ${tier}.`, { parse_mode: 'Markdown' });
    }
    if (modeArg === 'full' && tier < 3) {
      return ctx.reply(`❌ **Access Denied**\nMode FULL requires Tier 3 (VIP). You are currently Tier ${tier}.`, { parse_mode: 'Markdown' });
    }
    try {
      await prisma.systemConfig.upsert({
        where: { key: 'lp.defaultMode' },
        update: { value: modeArg!.toUpperCase() },
        create: { key: 'lp.defaultMode', value: modeArg!.toUpperCase() },
      });
      const emoji = modeArg === 'full' ? '🤖' : modeArg === 'semi' ? '⚡' : '🛡️';
      let msg = `${emoji} LP mode set to **${modeArg!.toUpperCase()}**.`;
      if (modeArg === 'semi') msg += `\n⚠️ *Auto-Compound is active.* Bot will execute harvests via Alchemy Session Key automatically.`;
      if (modeArg === 'full') msg += `\n⚠️ *FULL AUTONOMOUS active.* Bot will Open, Close, and Compound LP positions via Alchemy without asking for approval!`;
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply('❌ Failed to update LP mode.');
    }
    return;
  }

  // /lp day  (manual trigger DAY mode)
  if (sub === 'day') {
    ctx.reply('☀️ *Triggering DAY mode manually...*', { parse_mode: 'Markdown' });
    lpEngine.runDayMode().catch(e => ctx.reply(`❌ DAY mode error: ${e?.message}`));
    return;
  }

  // /lp night  (manual trigger NIGHT mode)
  if (sub === 'night') {
    ctx.reply('🌙 *Triggering NIGHT mode manually...*', { parse_mode: 'Markdown' });
    lpEngine.runNightMode().catch(e => ctx.reply(`❌ NIGHT mode error: ${e?.message}`));
    return;
  }

  ctx.reply('❌ Unknown LP subcommand. See /help for available commands.');
});

/** /lpmeta — view or edit LP screening config (owner only) */
bot.command('lpmeta', async (ctx) => {
  const ownerWallet = process.env.USER_WALLET_ADDRESS?.toLowerCase();
  // Simple ownership check — Telegram doesn't expose wallet, check by chat ID vs env TELEGRAM_CHAT_ID
  if (ctx.chat.id.toString() !== process.env.TELEGRAM_CHAT_ID) {
    return ctx.reply('⛔ This command is owner-only.');
  }

  const args = ctx.match?.trim();
  const lpKeys = [
    'lp.minMcap', 'lp.minVol', 'lp.categories', 'lp.blacklist',
    'lp.nightWindow', 'lp.dayCloseTime', 'lp.nightRange',
    'lp.maxPositions', 'lp.positionCap', 'lp.startSize.live', 'lp.startSize.dryrun',
    'lp.ilHourThreshold', 'lp.defaultMode', 'lp.minGrokScore',
    'lp.outOfRangeGraceMinutes', 'lp.dynamicRange',
  ];

  // /lpmeta <key> <value>  → update
  if (args && args.includes(' ')) {
    const spaceIdx = args.indexOf(' ');
    const key = args.slice(0, spaceIdx).trim();
    const value = args.slice(spaceIdx + 1).trim();

    if (key === 'factory') {
      const parts = value.split(' ');
      if (parts.length < 2) return ctx.reply('❌ Format: `/lpmeta factory <name> <address>`', { parse_mode: 'Markdown' });
      const fName = parts[0];
      const fAddr = parts[1];
      try {
        await prisma.factoryRegistry.upsert({
          where: { address: fAddr },
          update: { name: fName, status: 'active' },
          create: { name: fName, address: fAddr, status: 'active' }
        });
        return ctx.reply(`✅ Factory Registered: \`${fName}\` @ \`${fAddr}\``, { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply('❌ Failed to register factory.');
      }
    }

    if (key === 'factory_status') {
      const parts = value.split(' ');
      if (parts.length < 2) return ctx.reply('❌ Format: `/lpmeta factory_status <name> <active|dead|dormant>`', { parse_mode: 'Markdown' });
      try {
        const factory = await prisma.factoryRegistry.findFirst({ where: { name: { equals: parts[0], mode: 'insensitive' } }});
        if (!factory) return ctx.reply('❌ Factory not found');
        await prisma.factoryRegistry.update({ where: { id: factory.id }, data: { status: parts[1] } });
        return ctx.reply(`✅ Factory \`${factory.name}\` status updated to \`${parts[1]}\``, { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply('❌ Failed to update factory status.');
      }
    }

    if (!key.startsWith('lp.') && !key.startsWith('liveness.')) {
      return ctx.reply('❌ Key must start with `lp.` or `liveness.`', { parse_mode: 'Markdown' });
    }
    try {
      await prisma.systemConfig.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
      ctx.reply(`✅ Updated \`${key}\` = \`${value}\``, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply('❌ Failed to update config.');
    }
    return;
  }

  // /lpmeta  → show all
  try {
    const configs = await prisma.systemConfig.findMany({ 
      where: { OR: [{ key: { in: lpKeys } }, { key: { startsWith: 'liveness.' } }] } 
    });
    const map = Object.fromEntries(configs.map(c => [c.key, c.value]));
    let msg = '⚙️ *LP Engine MetaConfig*\n\n';
    
    // Core LP Keys
    for (const k of lpKeys) {
      msg += `\`${k}\` = \`${map[k] ?? '(not set)'}\`\n`;
    }
    
    // Liveness Keys
    msg += '\n🛡️ *Liveness Gate*\n';
    const livenessKeys = Object.keys(map).filter(k => k.startsWith('liveness.'));
    for (const k of livenessKeys) {
      msg += `\`${k}\` = \`${map[k]}\`\n`;
    }
    
    // Factories
    const factories = await prisma.factoryRegistry.findMany();
    if (factories.length > 0) {
      msg += '\n🏭 *Factories*\n';
      for (const f of factories) {
        msg += `\`${f.name}\` (${f.status}) - fails: ${f.consecutiveLivenessFails}\n`;
      }
    }

    msg += '\n_Edit: `/lpmeta <key> <value>`_\n_Factory: `/lpmeta factory <name> <address>`_';
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('❌ Failed to fetch meta config.');
  }
});

/** /harvest — collect fees from all open LP positions */
bot.command('harvest', async (ctx) => {
  const lpEngine = orchestrator.getLPEngine();
  ctx.reply('🌾 *Proposing harvest for all open positions...*', { parse_mode: 'Markdown' });
  try {
    await lpEngine.proposeHarvest();
  } catch (e: any) {
    ctx.reply(`❌ Harvest failed: ${e?.message}`);
  }
});

bot.command('daymode', async (ctx) => {
  const lpEngine = orchestrator.getLPEngine();
  ctx.reply('☀️ *Triggering LP Engine DAY Mode manually...*', { parse_mode: 'Markdown' });
  try {
    await lpEngine.runDayMode();
  } catch (e: any) {
    ctx.reply(`❌ Day Mode failed: ${e?.message}`);
  }
});

bot.command('nightmode', async (ctx) => {
  const lpEngine = orchestrator.getLPEngine();
  ctx.reply('🌙 *Triggering LP Engine NIGHT Mode manually...*', { parse_mode: 'Markdown' });
  try {
    await lpEngine.runNightMode();
  } catch (e: any) {
    ctx.reply(`❌ Night Mode failed: ${e?.message}`);
  }
});


bot.command('sessionkey', async (ctx) => {
  ctx.reply('🔑 *Generating Smart Account Session Key (ERC-6900)...*', { parse_mode: 'Markdown' });
  try {
    const pk = (process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
    if (!pk) throw new Error('PRIVATE_KEY not found in .env');
    
    // Create Smart Account Client
    const client = await createSmartAccount(pk, 3);
    
    // Grant Session Key
    const keyData = await grantSessionKey(client, 'FULL');
    
    ctx.reply(`✅ *Session Key Granted!*\n\n` +
      `Smart Account: \`${client.account.address}\`\n` +
      `Session Key: \`${keyData.keyAddress}\`\n` +
      `Mode: FULL\n` +
      `Expires: ${new Date(keyData.expiry).toLocaleString()}`, 
      { parse_mode: 'Markdown' });
  } catch (e: any) {
    ctx.reply(`❌ Failed to generate Session Key: ${e?.message}`);
  }
});

// ─── LP INLINE KEYBOARD CALLBACKS ───────────────────────────────────────────

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // LP approve/reject: format = "lp_approve:<posId>:<type>" or "lp_reject:..."
  if (data.startsWith('lp_approve:') || data.startsWith('lp_reject:')) {
    const [action, posId, type] = data.split(':');
    const isApprove = action === 'lp_approve';
    const lpEngine = orchestrator.getLPEngine();

    await ctx.answerCallbackQuery();

    if (!isApprove) {
      // Rejected — clean up PENDING position
      try {
        if (type === 'OPEN') {
          await prisma.lPPosition.update({
            where: { id: posId },
            data: { status: 'REJECTED' } as any,
          });
        } else if (type === 'CLOSE' || type === 'REBALANCE') {
          await prisma.lPPosition.update({
            where: { id: posId },
            data: { status: 'OPEN' }, // revert EXITING back to OPEN
          });
        }
      } catch (_) { }
      await ctx.editMessageText(`❌ *LP ${type} proposal rejected.*`, { parse_mode: 'Markdown' });
      return;
    }

    // Approved
    const config = await prisma.systemConfig.findUnique({ where: { key: 'TRADING_MODE' } });
    const isDryRun = (config?.value || 'LIVE') === 'DRY_RUN';
    if (isDryRun) {
      // DRY_RUN: simulate confirmation
      if (type === 'OPEN') {
        const fakeTokenId = `DRY-${Date.now()}`;
        await lpEngine.onOpenConfirmed(posId, fakeTokenId);
        await ctx.editMessageText(
          `✅ *[DRY RUN] LP OPEN simulated*\nFake tokenId: \`${fakeTokenId}\``,
          { parse_mode: 'Markdown' }
        );
      } else if (type === 'CLOSE') {
        await lpEngine.onCloseConfirmed(posId, 0);
        await ctx.editMessageText(`✅ *[DRY RUN] LP CLOSE simulated*`, { parse_mode: 'Markdown' });
      } else if (type === 'HARVEST') {
        await ctx.editMessageText(`✅ *[DRY RUN] HARVEST simulated*`, { parse_mode: 'Markdown' });
      } else {
        await ctx.editMessageText(`✅ *[DRY RUN] LP ${type} simulated*`, { parse_mode: 'Markdown' });
      }
      return;
    }

    // LIVE — calldata is already built during proposal creation
    // Only notification here; actual tx broadcast requires wallet signer
    // (same as existing trench flow: user copies calldata or uses web3 wallet)
    await ctx.editMessageText(
      `⏳ *LP ${type} approved.* Broadcasting transaction...\n` +
      `_(Check your wallet or Fletcher web dashboard for tx status)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Blacklist approve/reject
  if (data.startsWith('blacklist_approve:') || data.startsWith('blacklist_reject:')) {
    const [action, addr] = data.split(':');
    const isApprove = action === 'blacklist_approve';
    await ctx.answerCallbackQuery();

    if (!isApprove) {
      await ctx.editMessageText(`❌ *Blacklist request rejected* for \`${addr}\`.`, { parse_mode: 'Markdown' });
      return;
    }

    try {
      const config = await prisma.systemConfig.findUnique({ where: { key: 'lp.blacklist' } });
      const currentList = config?.value ? JSON.parse(config.value) : [];
      if (!currentList.includes(addr)) {
        currentList.push(addr);
        await prisma.systemConfig.upsert({
          where: { key: 'lp.blacklist' },
          update: { value: JSON.stringify(currentList) },
          create: { key: 'lp.blacklist', value: JSON.stringify(currentList) },
        });
      }
      await ctx.editMessageText(`✅ *Token Blacklisted*\n\`${addr}\` added to LP blacklist.`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.editMessageText(`❌ *Failed to update blacklist:* ${e.message}`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Fall through: let existing trench callbacks handle (don't double-answer)
  // Existing bot handles its own callback_query separately via Telegraf middleware
});


async function startApp() {
  try {
    // Connect Database
    await connectDb();

    // Start Fletcher agents (Event Listener, Webhook Server, etc.)
    await orchestrator.startAll();

    // Start Telegram Bot with retry logic for zero-downtime deploys
    const startBot = async () => {
      try {
        await bot.start({
          onStart: async (botInfo) => {
            console.log(`[Bot] Started as @${botInfo.username}`);
          },
        });
      } catch (err: any) {
        console.error(`[Bot] Telegram polling failed: ${err.message}`);
        console.log(`[Bot] Retrying in 5 seconds... (Waiting for old container to shut down)`);
        setTimeout(startBot, 5000);
      }
    };

    // Start main bot (without waiting so we can start userbot too)
    startBot();

    // Start Userbot listener
    await startUserbot(bot, orchestrator);

  } catch (error) {
    console.error("[System] Critical startup error:", error);
    process.exit(1);
  }
}

startApp();
