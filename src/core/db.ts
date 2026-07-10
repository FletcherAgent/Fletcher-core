import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import process from 'node:process';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

export async function connectDb() {
  try {
    await prisma.$connect();
    console.log("💾 Database: Connected to Supabase via Prisma");
  } catch (error) {
    console.error("🔴 Database: Connection failed", error);
    process.exit(1);
  }
}
