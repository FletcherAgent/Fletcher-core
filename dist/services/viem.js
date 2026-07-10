import { createPublicClient, http, defineChain } from 'viem';
// Mendefinisikan konfigurasi Robinhood Chain secara kustom
export const robinhoodChain = defineChain({
    id: 4663, // ID chain placeholder, akan disesuaikan jika perlu
    name: 'Robinhood Chain',
    network: 'robinhood',
    nativeCurrency: {
        decimals: 18,
        name: 'Robinhood',
        symbol: 'RHD', // Menggunakan RHD atau token gas native Robinhood
    },
    rpcUrls: {
        default: {
            http: ['https://rpc.mainnet.chain.robinhood.com'],
        },
        public: {
            http: ['https://rpc.mainnet.chain.robinhood.com'],
        },
    },
});
export const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(),
});
console.log("🔌 Viem Client: Connected to Robinhood Chain RPC");
