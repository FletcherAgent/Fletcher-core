import { ScoutAgent } from '../agents/scout.js';
export class Orchestrator {
    scout;
    constructor() {
        this.scout = new ScoutAgent();
        // Inisialisasi agen-agen lainnya nanti (Trader, LP Manager, dsb.)
    }
    async startAll() {
        console.log("🚀 Orchestrator: Memulai seluruh agen Fletcher (Minimum Viable Swarm)...");
        // Mulai memonitor peluncuran token baru
        await this.scout.startListening();
    }
}
