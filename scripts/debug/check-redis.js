const { createClient } = require('redis');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

async function main() {
  const url    = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = createClient({ url });

  client.on('error', e => console.error('Redis error:', e.message));
  await client.connect();

  const ping = await client.ping();
  console.log('\nRedis: ' + url);
  console.log('PING -> ' + ping);

  const keys = await client.keys('*');
  console.log('\nKeys en cache (' + keys.length + '):\n');

  if (!keys.length) {
    console.log('  (vacio)\n');
  } else {
    for (const key of keys.sort()) {
      const ttl  = await client.ttl(key);
      const type = await client.type(key);
      const ttlStr = ttl === -1 ? 'sin expiry' : ttl === -2 ? 'expirada' : ttl + 's';
      console.log('  [' + type.padEnd(6) + '] ttl:' + ttlStr.padEnd(12) + ' ' + key);
    }
    console.log('');
  }

  await client.disconnect();
}

main().catch(e => console.error('ERROR:', e.message));