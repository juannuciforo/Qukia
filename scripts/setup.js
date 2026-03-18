// scripts/setup.js
// Ejecutar desde C:\...\Qukia\scripts:
//   node setup.js

const fs   = require('fs');
const path = require('path');

// Raiz del proyecto (un nivel arriba de /scripts)
const ROOT = path.resolve(__dirname, '..');

const files = {

// ─────────────────────────────────────────────────────────────────────────────
'db/list-users.js': `
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const users = await p.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { tenant: { select: { name: true, slug: true } } },
  });

  console.log('\\nUSUARIOS (' + users.length + ')\\n');
  console.log('ACTIVO  EMAIL                                    ROL              TENANT');
  console.log('-'.repeat(85));

  users.forEach(u => {
    const active = u.isActive ? '[ok]  ' : '[off] ';
    const tenant = u.tenant ? u.tenant.slug : '(sin tenant)';
    console.log(active + u.email.padEnd(44) + ' ' + u.role.padEnd(16) + ' ' + tenant);
  });

  console.log('\\nPara resetear contrasena: npm run db:reset-pass\\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'db/list-tenants.js': `
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

  console.log('\\nTENANTS (' + tenants.length + ')\\n');
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
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'db/reset-password.js': `
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, email, newPassword] = process.argv;

  if (!email || !newPassword) {
    console.error('\\nUso: npm run db:reset-pass -- email@ejemplo.com nuevapass123\\n');
    process.exit(1);
  }

  const user = await p.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (!user) {
    console.error('\\nUsuario no encontrado: ' + email + '\\n');
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await p.user.update({ where: { id: user.id }, data: { passwordHash: hash } });

  console.log('\\nContrasena actualizada para: ' + user.email + ' (' + user.role + ')\\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'db/reset-credits.js': `
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, slug, amountOrType, type] = process.argv;

  if (!slug) {
    console.error('\\nUso: npm run db:reset-credits -- <slug> RESET');
    console.error('     npm run db:reset-credits -- <slug> <amount> PURCHASE|ADJUSTMENT\\n');
    process.exit(1);
  }

  const tenant = await p.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error('\\nTenant no encontrado: ' + slug + '\\n');
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
    console.log('\\nCreditos reseteados para "' + tenant.name + '". Status -> ACTIVE\\n');
    return;
  }

  const amount = parseInt(amountOrType);
  const txType = (type || 'ADJUSTMENT').toUpperCase();

  if (!amount || isNaN(amount)) {
    console.error('\\nAmount debe ser un numero entero.\\n');
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
  console.log('\\nTenant:      ' + updated.name);
  console.log('creditUsed:  ' + updated.creditUsed);
  console.log('creditLimit: ' + updated.creditLimit + '\\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'db/suspend-tenant.js': `
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ log: [] });

async function main() {
  const [,, slug, status] = process.argv;
  const VALID = ['ACTIVE', 'SUSPENDED', 'PAUSED'];

  if (!slug || !VALID.includes((status || '').toUpperCase())) {
    console.error('\\nUso: npm run db:suspend -- <slug> ACTIVE|SUSPENDED|PAUSED\\n');
    process.exit(1);
  }

  const tenant = await p.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error('\\nTenant no encontrado: ' + slug + '\\n');
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

  console.log('\\nTenant: ' + tenant.name);
  console.log('Status: ' + prev + ' -> ' + status.toUpperCase() + '\\n');
}

main()
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => p.$disconnect());
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'debug/check-redis.js': `
const { createClient } = require('redis');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

async function main() {
  const url    = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = createClient({ url });

  client.on('error', e => console.error('Redis error:', e.message));
  await client.connect();

  const ping = await client.ping();
  console.log('\\nRedis: ' + url);
  console.log('PING -> ' + ping);

  const keys = await client.keys('*');
  console.log('\\nKeys en cache (' + keys.length + '):\\n');

  if (!keys.length) {
    console.log('  (vacio)\\n');
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
`.trim(),

// ─────────────────────────────────────────────────────────────────────────────
'debug/check-env.js': `
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ANTHROPIC_API_KEY',
  'PORT',
];

const OPTIONAL = [
  'NODE_ENV',
  'UPLOAD_DIR',
  'MAX_FILE_SIZE',
  'CORS_ORIGIN',
];

console.log('\\nVARIABLES DE ENTORNO\\n');
console.log('ESTADO   VARIABLE');
console.log('-'.repeat(60));

let missing = 0;

REQUIRED.forEach(key => {
  const val = process.env[key];
  if (!val) {
    console.log('[FALTA]  ' + key);
    missing++;
  } else {
    const isSecret = key.toLowerCase().includes('secret') || key.toLowerCase().includes('key');
    const preview  = isSecret
      ? val.slice(0, 8) + '...'
      : val.length > 40 ? val.slice(0, 40) + '...' : val;
    console.log('[ok]     ' + key.padEnd(26) + ' ' + preview);
  }
});

console.log('\\nOPCIONALES:');
OPTIONAL.forEach(key => {
  const val = process.env[key];
  console.log('[' + (val ? 'ok' : '--') + ']     ' + key.padEnd(26) + ' ' + (val || '(no definida)'));
});

if (missing > 0) {
  console.log('\\n' + missing + ' variable(s) requerida(s) faltante(s). Revisa tu .env\\n');
  process.exit(1);
} else {
  console.log('\\nTodo OK.\\n');
}
`.trim(),

};

// =============================================================================
// CREAR ARCHIVOS
// =============================================================================

let created = 0;
let skipped = 0;

for (const [relPath, content] of Object.entries(files)) {
  const fullPath = path.join(__dirname, relPath);
  const dir      = path.dirname(fullPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Carpeta creada: ' + path.relative(ROOT, dir));
  }

  if (fs.existsSync(fullPath)) {
    console.log('Ya existe (skip): ' + path.relative(ROOT, fullPath));
    skipped++;
  } else {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log('Creado: ' + path.relative(ROOT, fullPath));
    created++;
  }
}

// =============================================================================
// ACTUALIZAR package.json
// =============================================================================

const pkgPath = path.join(ROOT, 'package.json');

if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const newScripts = {
    'db:users':         'node scripts/db/list-users.js',
    'db:tenants':       'node scripts/db/list-tenants.js',
    'db:reset-pass':    'node scripts/db/reset-password.js',
    'db:reset-credits': 'node scripts/db/reset-credits.js',
    'db:suspend':       'node scripts/db/suspend-tenant.js',
    'debug:redis':      'node scripts/debug/check-redis.js',
    'debug:env':        'node scripts/debug/check-env.js',
  };

  let addedScripts = 0;
  pkg.scripts = pkg.scripts || {};

  for (const [key, val] of Object.entries(newScripts)) {
    if (!pkg.scripts[key]) {
      pkg.scripts[key] = val;
      addedScripts++;
    }
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('\npackage.json actualizado (' + addedScripts + ' scripts agregados)');
} else {
  console.log('\nATENCION: package.json no encontrado en ' + ROOT);
  console.log('Agrega manualmente los scripts (ver documentacion).');
}

// =============================================================================
// RESUMEN
// =============================================================================

console.log('\n----------------------------------------');
console.log('Archivos creados: ' + created);
console.log('Archivos salteados (ya existian): ' + skipped);
console.log('----------------------------------------');
console.log('\nUso rapido:');
console.log('  npm run db:users');
console.log('  npm run db:tenants');
console.log('  npm run db:reset-pass -- email@ejemplo.com nuevapass');
console.log('  npm run db:reset-credits -- <slug> RESET');
console.log('  npm run db:reset-credits -- <slug> 500 PURCHASE');
console.log('  npm run db:suspend -- <slug> SUSPENDED');
console.log('  npm run debug:redis');
console.log('  npm run debug:env');
console.log('');