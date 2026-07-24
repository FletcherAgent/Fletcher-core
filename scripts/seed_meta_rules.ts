import { prisma } from '../src/core/db.js';

async function main() {
  const configs = [
    { key: 'lp.lanes.newPair.minVol5mUsd', value: '300000' },
    { key: 'lp.lanes.newPair.sizeMultiplier', value: '0.5' },
    { key: 'lp.lanes.newPair.maxConcurrent', value: '1' },
    { key: 'lp.lanes.newPair.deadPoolWindowH', value: '1' },
    { key: 'lp.lanes.dipCatcher.athMcapMinUsd', value: '1000000' },
    { key: 'lp.lanes.dipCatcher.athMcapMaxUsd', value: '2000000' },
    { key: 'lp.lanes.dipCatcher.ddMinPct', value: '45' },
    { key: 'lp.lanes.dipCatcher.ddMaxPct', value: '60' },
    { key: 'lp.lanes.dipCatcher.rangeLowerMult', value: '0.80' },
    { key: 'lp.lanes.dipCatcher.timeStopH', value: '12' },
    { key: 'lp.lanes.dipCatcher.maxConcurrent', value: '2' },
    { key: 'lp.entryWindows.tz', value: 'Asia/Jakarta' },
    { key: 'lp.entryWindows.windows', value: '09:00-10:30,18:00-19:30,22:00-23:30' },
    { key: 'lp.entryWindows.outsideSizeMult', value: '0.5' },
    { key: 'lp.portfolio.regime', value: 'normal' },
    { key: 'lp.portfolio.crowdedSizeMult', value: '0.6' },
    { key: 'lp.portfolio.maxPositions', value: '5' },
    { key: 'lp.guardian.oorLeftCutAtPnlPct', value: '-10' },
    { key: 'lp.fudCheck.enabled', value: 'true' },
    { key: 'lp.fudCheck.onlyCategories', value: 'tech,utility' },
    { key: 'lp.fudCheck.rejectAbove', value: '60' },
    { key: 'lp.maxPositions', value: '5' },
  ];

  for (const c of configs) {
    await prisma.systemConfig.upsert({
      where: { key: c.key },
      update: {},
      create: { key: c.key, value: c.value },
    });
  }
  console.log('✅ Seeded new LP Meta Configs');

  const existing = await prisma.factoryRegistry.findFirst({ where: { name: 'flap.fun' } });
  if (existing) {
    await prisma.factoryRegistry.update({ where: { id: existing.id }, data: { status: 'banned' } });
  } else {
    await prisma.factoryRegistry.create({ data: { name: 'flap.fun', address: '0x000000000000000000000000000000000000flap', status: 'banned' } });
  }
  console.log('✅ Banned flap.fun factory');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
