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
      { address: '0xc38f2021b6b6349b8f662b7f207d84beb7bc8308', label: 'early-1', tier: 1 },
      { address: '0x6d8ac75d911bf7339fcf414ea79ae1edde18dabc', label: 'early-2', tier: 1 },
      { address: '0xeee29d1a6fa5873065ad8789c6e15231b48318a0', label: 'early-3', tier: 1 },
      { address: '0x96962a9fa7ed1c3a306c5948cb8997208d11c354', label: 'early-4', tier: 2 },
      { address: '0x7b25A4e86fF33ee656FD9434bdFDdf86EC54b362', label: 'degen-1', tier: 2 },
      { address: '0x7e3Ba68C49561AaE7c23C1d20fEF0F1D7615a3ad', label: 'early-active-1', tier: 1 },
      { address: '0xf41e3186861afb9840ea3c87f00366440a648320', label: 'nachsol', tier: 1 },
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
