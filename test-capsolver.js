const apiKey = 'CAP-AD35A5E0266008C3F0FA870F8BDA2CA171028A1FE5698810E809448286722FBB';
const url = 'https://api.capsolver.com/getBalance';

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientKey: apiKey })
})
.then(res => res.json())
.then(console.log);
