const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const tenants = await p.tenant.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      plan:   { select: { name: true } },
      _count: { select: { users: true, models: true } },
    },
  });

  console.log('\nTENANTS (' + tenants.length + ')\n');
  console.log('STATUS       SLUG                PLAN         CREDITOS                    USUARIOS  MODELOS');
  console.log('-'.repeat(95));

  tenants.forEach(t => {
    const pct    = Math.round((t.creditUsed / t.creditLimit) * 100);
    const bar    = '#'.repeat(Math.round(pct / 10)).padEnd(10, '.');
    const status = t.status === 'ACTIVE'
      ? (pct >= 90 ? '[ALERTA] ' : '[active] ')
      : '[SUSPEND]';
    const credits = (t.creditUsed + '/' + t.creditLimit + ' (' + pct + '%) [' + bar + ']').padEnd(30);
    console.log(
      status + '  ' + t.slug.padEnd(18) + '  ' +
      (t.plan ? t.plan.name : '-').padEnd(12) + ' ' +
      credits + ' ' +
      String(t._count.users).padEnd(9) + ' ' +
      t._count.models
    );
  });

  console.log('');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());