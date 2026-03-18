const router = require('express').Router();
const prisma = require('../../lib/prisma');
const { invalidatePattern } = require('../../lib/redis');
const logger = require('../../utils/logger');

// GET /admin/tenants
router.get('/', async (req, res, next) => {
  try {
    const { search, plan, status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (search) {
      where.OR = [
        { name:      { contains: search, mode: 'insensitive' } },
        { subdomain: { contains: search, mode: 'insensitive' } },
        { slug:      { contains: search, mode: 'insensitive' } },
      ];
    }
    if (plan)   where.plan = { slug: plan };
    if (status) where.status = status;

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          plan:    true,
          _count: { select: { users: true, models: true } },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    res.json({
      data: tenants.map(t => ({
        id:          t.id,
        name:        t.name,
        slug:        t.slug,
        subdomain:   t.subdomain,
        razonSocial: t.razonSocial,
        plan:        t.plan,
        creditLimit: t.creditLimit,
        creditUsed:  t.creditUsed,
        pct:         Math.round((t.creditUsed / t.creditLimit) * 100),
        status:      t.status,
        models:      t._count.models,
        users:       t._count.users,
        createdAt:   t.createdAt,
      })),
      pagination: {
        total,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/tenants/:id
router.get('/:id', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        plan:   true,
        models: true,
        users: {
          where: { role: { not: 'SUPERADMIN' } },
          select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
        },
        _count: { select: { conversations: true, files: true } },
      },
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

// POST /admin/tenants
router.post('/', async (req, res, next) => {
  try {
    const { name, slug, razonSocial, planId, creditLimit } = req.body;

    if (!name || !slug || !planId) {
      return res.status(400).json({ error: 'name, slug, planId required' });
    }

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return res.status(400).json({ error: 'Plan not found' });

    const tenant = await prisma.tenant.create({
      data: {
        name,
        slug:        slug.toLowerCase(),
        subdomain:   `${slug.toLowerCase()}.quikia.cookdata.io`,
        razonSocial,
        planId,
        creditLimit: creditLimit || plan.creditLimit,
      },
      include: { plan: true },
    });

    await prisma.auditLog.create({
      data: {
        userId:   req.user.sub,
        action:   'TENANT_CREATED',
        entity:   'Tenant',
        entityId: tenant.id,
        meta:     { name, slug },
      },
    });

    logger.info('Tenant created', { tenantId: tenant.id, slug });
    res.status(201).json(tenant);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Slug or subdomain already exists' });
    }
    next(err);
  }
});

// PATCH /admin/tenants/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, razonSocial, planId, creditLimit, status,
            alertAt70, alertAt80, alertAt90, suspendAt100, gracePeriodH } = req.body;

    const data = {};
    if (name        !== undefined) data.name        = name;
    if (razonSocial !== undefined) data.razonSocial = razonSocial;
    if (planId      !== undefined) data.planId      = planId;
    if (creditLimit !== undefined) data.creditLimit = creditLimit;
    if (status      !== undefined) data.status      = status;
    if (alertAt70   !== undefined) data.alertAt70   = alertAt70;
    if (alertAt80   !== undefined) data.alertAt80   = alertAt80;
    if (alertAt90   !== undefined) data.alertAt90   = alertAt90;
    if (suspendAt100 !== undefined) data.suspendAt100 = suspendAt100;
    if (gracePeriodH !== undefined) data.gracePeriodH = gracePeriodH;

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data,
      include: { plan: true },
    });

    await invalidatePattern(`tenant:*:${req.params.id}`);

    logger.info('Tenant updated', { tenantId: tenant.id });
    res.json(tenant);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Tenant not found' });
    next(err);
  }
});

// POST /admin/tenants/:id/credits  (add or remove credits)
router.post('/:id/credits', async (req, res, next) => {
  try {
    const { amount, type = 'ADJUSTMENT', description } = req.body;

    if (!amount || !Number.isInteger(amount)) {
      return res.status(400).json({ error: 'amount (integer) required' });
    }

    const [tenant] = await prisma.$transaction([
      prisma.tenant.update({
        where: { id: req.params.id },
        data: {
          creditUsed:  type === 'RESET' ? 0     : { increment: 0 },
          creditLimit: type === 'PURCHASE' ? { increment: amount } : undefined,
          status:      type === 'RESET' ? 'ACTIVE' : undefined,
        },
      }),
      prisma.creditTransaction.create({
        data: {
          tenantId:    req.params.id,
          amount,
          type,
          description: description || `Manual ${type.toLowerCase()} by admin`,
        },
      }),
    ]);

    await invalidatePattern(`tenant:*:${req.params.id}`);
    res.json({ ok: true, tenant });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/tenants/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.tenant.update({
      where: { id: req.params.id },
      data: { status: 'SUSPENDED' },
    });
    await invalidatePattern(`tenant:*:${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Tenant not found' });
    next(err);
  }
});

module.exports = router;
