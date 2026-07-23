import 'dotenv/config';
import { prisma } from '../src/core/db.js';

async function main() {
  console.log("🌱 Seeding Liveness Gate Default Configs...");

  const defaults = [
    { key: 'liveness.minVol1hUsd', value: '40000' },
    { key: 'liveness.minVolumeDecayRatio', value: '0.30' },
    { key: 'liveness.maxAthDrawdownPct', value: '70' },
    { key: 'liveness.verdictCacheMin', value: '5' },
    { key: 'liveness.deadBlacklistHours', value: '6' },
    { key: 'deadPoolExit.feeFloorUsd4h', value: '5' },
    { key: 'deadPoolExit.minPoolSwaps4h', value: '20' },
    { key: 'factoryAutoDelist.minDeploys7d', value: '5' },
    { key: 'factoryAutoDelist.consecutiveLivenessFails', value: '10' }
  ];

  for (const config of defaults) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: {}, // Do not overwrite existing values
      create: config
    });
    console.log(`✅ Set default: ${config.key} = ${config.value}`);
  }

  // Also seed NOXA factory as active by default if not exists
  const noxaFactoryAddress = process.env.NOXA_FACTORY_ADDRESS || '0x0000000000000000000000000000000000000000';
  if (noxaFactoryAddress !== '0x0000000000000000000000000000000000000000') {
    await prisma.factoryRegistry.upsert({
      where: { address: noxaFactoryAddress },
      update: {},
      create: {
        name: 'NOXA',
        address: noxaFactoryAddress,
        status: 'active'
      }
    });
    console.log(`🏭 Registered NOXA factory at ${noxaFactoryAddress}`);
  }

  console.log("🌱 Seeding complete.");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
