const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, slug, amountOrType, type] = process.argv;

  if (!slug) {
    console.error('\nUso: npm run db:reset-credits -- <slug> RESET');
    console.error('     npm run db:reset-credits -- <slug> <amount> PURCHASE|ADJUSTMENT\n');
    process.exit(1);
  }

  const tenant = await p.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error('\nTenant no encontrado: ' + slug + '\n');
    process.exit(1);
  }

  if (amountOrType === 'RESET') {
    await p.$transaction([
      p.tenant.update({
        where: { id: tenant.id },
        data:  { creditUsed: 0, status: 'ACTIVE' },
      }),
      p.creditTransaction.create({
        data: {
          tenantId:    tenant.id,
          amount:      0,
          type:        'RESET',
          description: 'Reset manual via script',
        },
      }),
    ]);
    console.log('\nCreditos reseteados para "' + tenant.name + '". Status -> ACTIVE\n');
    return;
  }

  const amount = parseInt(amountOrType);
  const txType = (type || 'ADJUSTMENT').toUpperCase();

  if (!amount || isNaN(amount)) {
    console.error('\nAmount debe ser un numero entero.\n');
    process.exit(1);
  }

  const data = {};
  if (txType === 'PURCHASE') data.creditLimit = { increment: amount };

  await p.$transaction([
    p.tenant.update({ where: { id: tenant.id }, data }),
    p.creditTransaction.create({
      data: {
        tenantId:    tenant.id,
        amount,
        type:        txType,
        description: 'Ajuste manual via script (' + txType + ')',
      },
    }),
  ]);

  const updated = await p.tenant.findUnique({ where: { id: tenant.id } });
  console.log('\nTenant:      ' + updated.name);
  console.log('creditUsed:  ' + updated.creditUsed);
  console.log('creditLimit: ' + updated.creditLimit + '\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());