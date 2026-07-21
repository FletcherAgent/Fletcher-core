import { prisma } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

export async function getDexConfig(version: 'V2' | 'V3' | 'V4') {
  // Try to find the default verified protocol in the DB
  const dbConfig = await prisma.dexProtocol.findFirst({
    where: { version, isDefault: true, verified: true }
  });

  return {
    routerAddress: dbConfig?.routerAddress || process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS,
    factoryAddress: dbConfig?.factoryAddress || process.env[`${version}_FACTORY`],
    quoterAddress: dbConfig?.quoterAddress || process.env[`${version}_QUOTER`],
    positionManager: dbConfig?.positionManager || process.env.V3_NONFUNGIBLE_POSITION_MANAGER || process.env.POSITION_MANAGER || process.env[`${version}_POSITION_MANAGER`],
    poolManager: dbConfig?.poolManager || process.env.V4_POOL_MANAGER,
    stateView: dbConfig?.stateView || process.env.V4_STATE_VIEW,
  };
}

export async function getAllDexConfigs(version: 'V2' | 'V3' | 'V4') {
  const configs = await prisma.dexProtocol.findMany({
    where: { version, verified: true },
    orderBy: { isDefault: 'desc' }
  });

  // If no DB configs, return one default mapped from process.env
  if (configs.length === 0) {
    return [await getDexConfig(version)];
  }

  return configs.map(dbConfig => ({
    routerAddress: dbConfig.routerAddress || process.env.UNIVERSAL_ROUTER || process.env.ROUTER_ADDRESS,
    factoryAddress: dbConfig.factoryAddress || process.env[`${version}_FACTORY`],
    quoterAddress: dbConfig.quoterAddress || process.env[`${version}_QUOTER`],
    positionManager: dbConfig.positionManager || process.env.V3_NONFUNGIBLE_POSITION_MANAGER || process.env.POSITION_MANAGER || process.env[`${version}_POSITION_MANAGER`],
    poolManager: dbConfig.poolManager || process.env.V4_POOL_MANAGER,
    stateView: dbConfig.stateView || process.env.V4_STATE_VIEW,
  }));
}
