const router = require('express').Router();
const prisma = require('../../lib/prisma');

// GET /admin/dashboard
router.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalTenants,
      activeTenants,
      alertTenants,
      suspendedTenants,
      totalUsers,
      totalModels,
      creditsThisMonth,
      recentActivity,
      topTenantsByUsage,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.tenant.count({
        where: {
          status: 'ACTIVE',
          AND: [
            { creditUsed: { gt: 0 } },
          ],
        },
      }),
      prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
      prisma.user.count({ where: { role: { not: 'SUPERADMIN' } } }),
      prisma.aiModel.count({ where: { status: 'ACTIVE' } }),
      prisma.creditTransaction.aggregate({
        where: {
          type: 'USAGE',
          createdAt: { gte: startOfMonth },
        },
        _sum: { amount: true },
      }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        where: { tenantId: { not: null } },
      }),
      prisma.tenant.findMany({
        orderBy: { creditUsed: 'desc' },
        take: 10,
        include: { plan: true },
      }),
    ]);

    // Tenants approaching limit (>= 70% used)
    const tenantsAtRisk = await prisma.tenant.findMany({
      where: {
        status: 'ACTIVE',
        creditUsed: { gt: 0 },
      },
      include: { plan: true },
    }).then(ts => ts.filter(t => t.creditUsed / t.creditLimit >= 0.7));

    res.json({
      metrics: {
        totalTenants,
        activeTenants,
        suspendedTenants,
        tenantsAtRisk: tenantsAtRisk.length,
        totalUsers,
        totalModels,
        creditsUsedThisMonth: creditsThisMonth._sum.amount || 0,
      },
      topTenantsByUsage: topTenantsByUsage.map(t => ({
        id:          t.id,
        name:        t.name,
        slug:        t.slug,
        creditUsed:  t.creditUsed,
        creditLimit: t.creditLimit,
        pct:         Math.round((t.creditUsed / t.creditLimit) * 100),
        plan:        t.plan.slug,
        status:      t.status,
      })),
      tenantsAtRisk: tenantsAtRisk.map(t => ({
        id:   t.id,
        name: t.name,
        slug: t.slug,
        pct:  Math.round((t.creditUsed / t.creditLimit) * 100),
      })),
      recentActivity,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
