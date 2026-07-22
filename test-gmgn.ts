import * as dotenv from 'dotenv';
dotenv.config();

async function runTest() {
  console.log('Testing GMGN getTrendingPairs...');
  try {
    const { getTrendingPairs } = await import('./src/services/gmgn/index.js');
    const pairs = await getTrendingPairs(5);
    console.log('Pairs returned:', pairs.length);
    console.log(JSON.stringify(pairs, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error during test:', error);
    process.exit(1);
  }
}

runTest();
