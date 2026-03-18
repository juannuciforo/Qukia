const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ─── PLANS ────────────────────────────────────────────────────────────────
  const planBasic = await prisma.plan.upsert({
    where:  { slug: 'basic' },
    update: {},
    create: {
      name:         'Básico',
      slug:         'basic',
      creditLimit:  500,
      modelLimit:   2,
      userLimit:    3,
      priceMonthly: 49,
      features:     ['Chat analytics', 'Hasta 2 modelos PBI', 'Hasta 3 usuarios'],
    },
  });

  const planPro = await prisma.plan.upsert({
    where:  { slug: 'pro' },
    update: {},
    create: {
      name:         'Pro',
      slug:         'pro',
      creditLimit:  1000,
      modelLimit:   5,
      userLimit:    10,
      priceMonthly: 149,
      features:     ['Chat analytics', 'Hasta 5 modelos PBI', 'Hasta 10 usuarios', 'Carga de archivos', 'Historial completo'],
    },
  });

  const planEnterprise = await prisma.plan.upsert({
    where:  { slug: 'enterprise' },
    update: {},
    create: {
      name:         'Enterprise',
      slug:         'enterprise',
      creditLimit:  10000,
      modelLimit:   999,
      userLimit:    999,
      priceMonthly: 499,
      features:     ['Modelos ilimitados', 'Usuarios ilimitados', 'Soporte prioritario', 'SSO', 'Auditoría completa'],
    },
  });

  console.log('Plans created');

  // ─── SUPER ADMIN ──────────────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL    || 'admin@cookdata.io';
  const adminPass  = process.env.ADMIN_PASSWORD || 'changeme123';
  const adminName  = process.env.ADMIN_NAME     || 'Super Admin';

  const passwordHash = await bcrypt.hash(adminPass, 12);

  await prisma.user.upsert({
    where:  { email: adminEmail },
    update: {},
    create: {
      email:    adminEmail,
      name:     adminName,
      passwordHash,
      role:     'SUPERADMIN',
    },
  });

  console.log(`Super admin created: ${adminEmail}`);

  // ─── DEMO TENANT ──────────────────────────────────────────────────────────
  const demoTenant = await prisma.tenant.upsert({
    where:  { slug: 'demo' },
    update: {},
    create: {
      name:        'Demo Company',
      slug:        'demo',
      subdomain:   'demo.quikia.cookdata.io',
      razonSocial: 'Demo Company SL',
      planId:      planPro.id,
      creditLimit: planPro.creditLimit,
    },
  });

  console.log(`Demo tenant created: ${demoTenant.slug}`);

  // Demo user
  const demoUserHash = await bcrypt.hash('demo1234', 12);
  await prisma.user.upsert({
    where:  { email: 'demo@demo.quikia.cookdata.io' },
    update: {},
    create: {
      email:        'demo@demo.quikia.cookdata.io',
      name:         'Demo User',
      passwordHash: demoUserHash,
      role:         'USER',
      tenantId:     demoTenant.id,
    },
  });

  // ─── SYSTEM PROMPTS ────────────────────────────────────────────────────────
  const systemPrompts = [
    {
      title:    'Resumen ejecutivo del período',
      category: 'ventas',
      body: `Eres un analista de negocio experto. El usuario necesita un resumen ejecutivo de sus KPIs de ventas para el período seleccionado.

Estructura tu respuesta con:
1. Titulares clave (máximo 3 métricas destacadas)
2. Comparativa con período anterior (variación absoluta y %)
3. Alertas o puntos de atención
4. Recomendación accionable

Usa lenguaje conciso y orientado a decisiones. No muestres código DAX al usuario final.`,
    },
    {
      title:    'Top 10 productos por margen',
      category: 'ventas',
      body: `Lista los 10 productos con mayor margen bruto del período seleccionado.

Incluye para cada producto:
- Nombre del producto
- Unidades vendidas
- Precio medio
- Ingresos totales
- Margen bruto (valor y %)

Ordena de mayor a menor margen. Si no hay datos suficientes, indícalo claramente.`,
    },
    {
      title:    'Análisis de variación presupuesto',
      category: 'finanzas',
      body: `Analiza la variación entre el presupuesto aprobado y la ejecución real del período.

Destaca:
1. Las 3 partidas con mayor desviación positiva
2. Las 3 partidas con mayor desviación negativa
3. Desviación total en porcentaje
4. Causa probable de las principales desviaciones`,
    },
    {
      title:    'Proyección mes siguiente',
      category: 'ventas',
      body: `Basándote en la tendencia de los últimos 3 meses, proyecta las ventas del mes siguiente.

Proporciona:
1. Proyección puntual (valor esperado)
2. Rango optimista / pesimista
3. Factores que podrían alterar la proyección
4. Confianza en la proyección (alta/media/baja)`,
    },
    {
      title:    'Eficiencia logística por ruta',
      category: 'logistica',
      body: `Analiza la eficiencia de cada ruta de distribución para el período seleccionado.

Métricas clave:
1. Coste por entrega
2. Tiempo medio de entrega
3. Tasa de incidencias
4. Rutas con peor performance y causa probable`,
    },
  ];

  for (const sp of systemPrompts) {
    await prisma.systemPrompt.upsert({
      where:  { id: sp.title }, // won't match — will always create on first seed
      update: {},
      create: sp,
    }).catch(() =>
      prisma.systemPrompt.create({ data: sp })
    );
  }

  console.log('System prompts created');
  console.log('\nSeed completed successfully.');
  console.log(`\nAdmin login: ${adminEmail} / ${adminPass}`);
  console.log('Demo login:  demo@demo.quikia.cookdata.io / demo1234');
}

main()
  .catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
