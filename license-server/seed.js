// Creates license keys on the deployed license server.
//
//   node seed.js <admin-secret> <server-url> [count]
//   POS_ADMIN_SECRET=... node seed.js <server-url> [count]
//
// The secret can come from the environment instead of the command line, so it
// never lands in the shell history. Each key works on one computer by default;
// run it again whenever a new shop needs a copy.

const fromEnv = Boolean(process.env.POS_ADMIN_SECRET);
const ADMIN_SECRET = process.env.POS_ADMIN_SECRET || process.argv[2];
const SERVER_URL = (process.argv[fromEnv ? 2 : 3] || '').replace(/\/+$/, '');
const COUNT = Math.max(1, Number(process.argv[fromEnv ? 3 : 4]) || 3);

if (!ADMIN_SECRET || !SERVER_URL) {
  console.log('Usage: node seed.js <admin-secret> <server-url> [count]');
  console.log('   or: POS_ADMIN_SECRET=... node seed.js <server-url> [count]');
  process.exit(1);
}

async function run() {
  for (let i = 0; i < COUNT; i++) {
    const response = await fetch(`${SERVER_URL}/admin/add-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminSecret: ADMIN_SECRET, maxActivations: 1 }),
    });
    const data = await response.json().catch(() => ({}));
    console.log(data.success ? `✓ License key: ${data.key}` : `✗ ${data.message || 'Failed.'}`);
  }
}

run().catch((err) => {
  console.error(`Could not reach ${SERVER_URL}: ${err.message}`);
  process.exit(1);
});
