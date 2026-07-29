const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.oapshcnrszgqklceouai:XIv3oizBIw3eezIy@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true' });
client.connect().then(() => client.query('SELECT meta FROM "Log" ORDER BY "createdAt" DESC LIMIT 5')).then(res => console.log(JSON.stringify(res.rows, null, 2))).catch(console.error).finally(() => client.end());
