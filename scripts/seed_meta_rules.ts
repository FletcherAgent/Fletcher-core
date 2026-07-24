import * as dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../src/core/db.js';

async function main() {
  // ─── RHC Token Registry ────────────────────────────────────────────────────
  // Robinhood Chain canonical tokens (verified via Blockscout):
  //   WETH  - 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 - 18 decimals (~22,790 supply)
  //   USDG  - 0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168 -  6 decimals (~295M supply, Paxos)
  //   USDC  - DOES NOT EXIST on RHC. Bridged USDC → converted to USDG on arrival.
  //           Any "USDC" token on RHC is non-canonical/scam (e.g. USDGbeatUSDC at 0x6AeA69...).
  // ──────────────────────────────────────────────────────────────────────────
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
    { key: 'grok.mode', value: 'VETO' }, // VETO | ANNOTATION | ADVISOR
    { key: 'lp.maxPositions', value: '5' },
    // RHC Canonical Quote Tokens (decimals fetched on-chain via getTokenMeta)
    { key: 'tokens.quote.weth', value: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' }, // 18 dec
    { key: 'tokens.quote.usdg', value: '0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168' }, // 6 dec (Paxos USDG)
    // tokens.quote.usdc intentionally excluded: USDC does not exist on RHC
  ];

  for (const c of configs) {
    await prisma.systemConfig.upsert({
      where: { key: c.key },
      update: { value: c.value },
      create: { key: c.key, value: c.value },
    });
  }
  console.log('✅ Seeded LP Meta Configs');

  // Remove stale USDC key if it exists (USDC is NOT canonical on Robinhood Chain)
  const deletedUsdc = await prisma.systemConfig.deleteMany({
    where: { key: { in: ['tokens.quote.usdc'] } }
  });
  if (deletedUsdc.count > 0) {
    console.log(`🗑️  Removed stale key: tokens.quote.usdc (${deletedUsdc.count} row deleted)`);
  } else {
    console.log('ℹ️  tokens.quote.usdc was not in DB (already clean)');
  }

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
