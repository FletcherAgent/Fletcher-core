import { prisma } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

export async function getDexConfig(version: 'V2' | 'V3' | 'V4') {
  // Try to find the default verified protocol in the DB
  let dbConfig = null;
  try {
    dbConfig = await prisma.dexProtocol.findFirst({
      where: { version, isDefault: true, verified: true }
    });
  } catch (error) {
    console.warn(`[DexConfig] DB findFirst failed for ${version}. Falling back to .env configuration.`);
  }

  return {
    routerAddress: (dbConfig?.routerAddress || process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS || '').toLowerCase(),
    factoryAddress: (dbConfig?.factoryAddress || process.env[`${version}_FACTORY`] || '').toLowerCase(),
    quoterAddress: (dbConfig?.quoterAddress || process.env[`${version}_QUOTER`] || '').toLowerCase(),
    positionManager: (dbConfig?.positionManager || process.env.V3_NONFUNGIBLE_POSITION_MANAGER || process.env.POSITION_MANAGER || process.env[`${version}_POSITION_MANAGER`] || '').toLowerCase(),
    poolManager: (dbConfig?.poolManager || process.env.V4_POOL_MANAGER || '').toLowerCase(),
    stateView: (dbConfig?.stateView || process.env.V4_STATE_VIEW || '').toLowerCase(),
  };
}

export async function getAllDexConfigs(version: 'V2' | 'V3' | 'V4') {
  let configs: any[] = [];
  try {
    configs = await prisma.dexProtocol.findMany({
      where: { version, verified: true },
      orderBy: { isDefault: 'desc' }
    });
  } catch (error) {
    console.warn(`[DexConfig] DB connection failed for ${version}. Falling back to .env configuration.`);
  }

  // If no DB configs, return one default mapped from process.env
  if (configs.length === 0) {
    return [await getDexConfig(version)];
  }

  return configs.map(dbConfig => ({
    routerAddress: (dbConfig.routerAddress || process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS || '').toLowerCase(),
    factoryAddress: (dbConfig.factoryAddress || process.env[`${version}_FACTORY`] || '').toLowerCase(),
    quoterAddress: (dbConfig.quoterAddress || process.env[`${version}_QUOTER`] || '').toLowerCase(),
    positionManager: (dbConfig.positionManager || process.env.V3_NONFUNGIBLE_POSITION_MANAGER || process.env.POSITION_MANAGER || process.env[`${version}_POSITION_MANAGER`] || '').toLowerCase(),
    poolManager: (dbConfig.poolManager || process.env.V4_POOL_MANAGER || '').toLowerCase(),
    stateView: (dbConfig.stateView || process.env.V4_STATE_VIEW || '').toLowerCase(),
  }));
}
