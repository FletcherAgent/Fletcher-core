import { Bot } from "grammy";
import * as dotenv from "dotenv";
import { Orchestrator } from "../core/orchestrator.js";
import { connectDb } from "../core/db.js";
dotenv.config();
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
}
const bot = new Bot(botToken);
bot.command("start", (ctx) => {
    ctx.reply("🟢 Fletcher Agent Core is online.\nRobinhood Chain Active Range Manager.");
});
bot.command("status", (ctx) => {
    ctx.reply("📊 Status:\n- Network: Robinhood Chain (4663)\n- Active Agents: 5\n- Positions: 0 OPEN");
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
