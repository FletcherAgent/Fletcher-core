import { Bot } from "grammy";
import * as dotenv from "dotenv";
import { Orchestrator } from "../core/orchestrator.js";
import { connectDb, prisma } from "../core/db.js";

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
/help - Show this guide and command list.

🕹️ <b>Operation Mode</b>
/mode auto - (Sniper Mode) Bot automatically buys new tokens without confirmation.
/mode confirm - (Manual Mode) Bot sends [Confirm] / [Reject] buttons before buying.

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
    
    startBot();
  } catch (error) {
    console.error("[System] Critical startup error:", error);
    process.exit(1);
  }
}

startApp();
