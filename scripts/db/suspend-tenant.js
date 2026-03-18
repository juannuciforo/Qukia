const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, slug, status] = process.argv;
  const VALID = ['ACTIVE', 'SUSPENDED', 'PAUSED'];

  if (!slug || !VALID.includes((status || '').toUpperCase())) {
    console.error('\nUso: npm run db:suspend -- <slug> ACTIVE|SUSPENDED|PAUSED\n');
    process.exit(1);
  }

  const tenant = await p.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error('\nTenant no encontrado: ' + slug + '\n');
    process.exit(1);
  }

  const prev = tenant.status;
  await p.tenant.update({
    where: { id: tenant.id },
    data:  { status: status.toUpperCase() },
  });

  // Intentar invalidar cache Redis (opcional, no falla si Redis no esta disponible)
  try {
    const { invalidatePattern } = require('../src/lib/redis');
    await invalidatePattern('tenant:*:' + tenant.id);
  } catch (_) {}

  console.log('\nTenant: ' + tenant.name);
  console.log('Status: ' + prev + ' -> ' + status.toUpperCase() + '\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());