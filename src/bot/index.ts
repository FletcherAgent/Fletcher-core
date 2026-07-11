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
  ctx.reply("🟢 Fletcher Agent Core is online.\nRobinhood Chain Active Range Manager.\n\nKetik /help untuk melihat daftar perintah.");
});

bot.command("help", (ctx) => {
  const helpText = `
🤖 **Fletcher Bot Commands** 🤖

🚀 **Sistem Utama**
/start - Memulai bot dan menampilkan status awal.
/status - Menampilkan status agen, jaringan, dan posisi aktif.
/help - Menampilkan panduan dan daftar perintah ini.

🕹️ **Mode Operasi**
/mode auto - (Sniper Mode) Bot otomatis membeli koin baru tanpa konfirmasi (Sangat Cepat).
/mode confirm - (Manual Mode) Bot akan mengirim tombol [Confirm] / [Reject] ke Telegram sebelum membeli.

🧪 **Pengujian (Developer)**
/dryrun <Alamat_Token> - Memaksa bot memasukkan token tertentu ke dalam antrean (Inject Signal) untuk testing eksekusi.
`;
  ctx.reply(helpText, { parse_mode: "Markdown" });
});

bot.command("status", async (ctx) => {
  try {
    const openPositions = await prisma.position.count({ where: { status: 'OPEN' } });
    ctx.reply(`📊 Status:\n- Network: Robinhood Chain (4663)\n- Active Agents: 5\n- Positions: ${openPositions} OPEN`);
  } catch (e) {
    ctx.reply("❌ Gagal mengambil status dari database.");
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

// Log Chat ID for every incoming message
bot.on("message", (ctx) => {
  console.log(`[Telegram] New message received! Your Chat ID is: ${ctx.chat.id}`);
});

const orchestrator = new Orchestrator(bot);

// Start the bot
bot.start({
  onStart: async (botInfo) => {
    console.log(`[Bot] Started as @${botInfo.username}`);
    
    // Connect Database
    await connectDb();

    // Start Fletcher agents (Event Listener, etc.)
    await orchestrator.startAll();
  },
});
