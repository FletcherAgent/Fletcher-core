import * as dotenv from 'dotenv';
dotenv.config();

// Use DIRECT_URL for local scripts to bypass IPv6 pooler issues
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

async function main() {
  const { prisma } = await import('../src/core/db.js');
  
  try {
    console.log("Seeding initial tracked wallets...");

    const wallets = [
      // === EXISTING WALLETS ===
      { address: '0xc38f2021b6b6349b8f662b7f207d84beb7bc8308', label: 'early-1', tier: 1 },
      { address: '0x6d8ac75d911bf7339fcf414ea79ae1edde18dabc', label: 'early-2', tier: 1 },
      { address: '0xeee29d1a6fa5873065ad8789c6e15231b48318a0', label: 'early-3', tier: 1 },
      { address: '0x96962a9fa7ed1c3a306c5948cb8997208d11c354', label: 'early-4', tier: 2 },
      { address: '0x7b25A4e86fF33ee656FD9434bdFDdf86EC54b362', label: 'degen-1', tier: 2 },
      { address: '0x7e3Ba68C49561AaE7c23C1d20fEF0F1D7615a3ad', label: 'early-active-1', tier: 1 },
      { address: '0xf41e3186861afb9840ea3c87f00366440a648320', label: 'nachsol', tier: 1 },
      // === NEW WALLETS — Discovered from Robinhood Chain Explorer (July 2026) ===
      // Tier 1: High-frequency whale traders via UniversalRouter
      { address: '0x4f67f52147c6bc03563772fa3d7af3adffb92110', label: 'likenooneeverwas', tier: 1 },
      { address: '0x2e6ce3ec985a7479ef0cb7d732f566834c6320ec', label: 'uni-swapper-1', tier: 1 },
      { address: '0xd5bf36c9e0fc2de8b3a7ea1cda33a2e60a5cfa64', label: 'uni-swapper-2', tier: 1 },
      // Tier 2: Active DeFi / arbitrage traders
      { address: '0x4180672adc800d66237917f21444e3f00b7f4114', label: 'degen-active-1', tier: 2 },
      { address: '0x6abb37866ed277247eff2839e85262314be86768', label: 'arb-hunter-1', tier: 2 },
      // Tier 3: NFT + swap activity
      { address: '0xde67826bfaffbf721b6e28867c7c58d834ea0424', label: 'nft-degen-1', tier: 3 },
    ];

    for (const w of wallets) {
      await prisma.trackedWallet.upsert({
        where: { address: w.address },
        update: {},
        create: {
          address: w.address,
          label: w.label,
          tier: w.tier,
          status: 'ACTIVE',
          entrySource: 'manual-aldi-screening'
        },
      });
    }

    // Initialize copy-exit config
    await prisma.systemConfig.upsert({
      where: { key: 'copyExitEnabled' },
      update: {},
      create: {
        key: 'copyExitEnabled',
        value: 'true'
      }
    });

    console.log("Seeding finished.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
