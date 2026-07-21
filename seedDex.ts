import { prisma } from './src/core/db.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await prisma.$connect();
  console.log('Clearing existing records...');
  await prisma.dexProtocol.deleteMany();
  console.log('Seeding DexProtocol based on .env variables...');

  // Helper to extract addresses safely
  const V2_ROUTER = process.env.V2_ROUTER || null;
  const V2_FACTORY = process.env.V2_FACTORY || null;

  const V3_FACTORY = process.env.V3_FACTORY || null;
  const V3_QUOTER = process.env.V3_QUOTER || null;
  const V3_POSITION_MANAGER = process.env.V3_NONFUNGIBLE_POSITION_MANAGER || process.env.POSITION_MANAGER || null;

  const V4_POOL_MANAGER = process.env.V4_POOL_MANAGER || null;
  const V4_POSITION_MANAGER = process.env.V4_POSITION_MANAGER || null;
  const V4_QUOTER = process.env.V4_QUOTER || null;
  const V4_STATE_VIEW = process.env.V4_STATE_VIEW || null;

  const UNIVERSAL_ROUTER = process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS || null;

  // Insert Uniswap V2
  await prisma.dexProtocol.create({
    data: {
      name: 'Uniswap V2',
      version: 'V2',
      routerAddress: UNIVERSAL_ROUTER, // V2/V3 uses Universal Router for swaps
      factoryAddress: V2_FACTORY,
      isDefault: true,
      verified: true
    }
  });

  // Insert Uniswap V3
  await prisma.dexProtocol.create({
    data: {
      name: 'Uniswap V3',
      version: 'V3',
      routerAddress: UNIVERSAL_ROUTER,
      factoryAddress: V3_FACTORY,
      quoterAddress: V3_QUOTER,
      positionManager: V3_POSITION_MANAGER,
      isDefault: true,
      verified: true
    }
  });

  // Insert Uniswap V4
  // For V4, Universal Router is also used but we'll store V4 specific components
  await prisma.dexProtocol.create({
    data: {
      name: 'Uniswap V4',
      version: 'V4',
      routerAddress: UNIVERSAL_ROUTER,
      poolManager: V4_POOL_MANAGER,
      quoterAddress: V4_QUOTER,
      positionManager: V4_POSITION_MANAGER,
      stateView: V4_STATE_VIEW,
      isDefault: true,
      verified: true
    }
  });

  console.log('✅ Seed complete!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
