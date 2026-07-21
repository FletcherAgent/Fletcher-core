const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const lps = await prisma.lPPosition.findMany({ select: { id: true, feesCollected: true, ilRunning: true } });
  console.log(lps);
}
main().catch(console.error).finally(() => prisma.$disconnect());
