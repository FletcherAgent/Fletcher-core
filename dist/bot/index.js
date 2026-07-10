import { Bot } from "grammy";
import * as dotenv from "dotenv";
import { Orchestrator } from "../core/orchestrator.js";
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
const orchestrator = new Orchestrator();
// Start the bot
bot.start({
    onStart: async (botInfo) => {
        console.log(`[Bot] Started as @${botInfo.username}`);
        // Mulai agen-agen Fletcher (Event Listener dll)
        await orchestrator.startAll();
    },
});
