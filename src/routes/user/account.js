const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../../lib/prisma');

// ─────────────────────────────────────────────────────────────────────────────
// USER PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /user/prompts  (personal + global system prompts)
router.get('/prompts', async (req, res, next) => {
  try {
    const [personal, global] = await Promise.all([
      prisma.userPrompt.findMany({
        where:   { userId: req.user.sub },
        orderBy: [{ isFavorite: 'desc' }, { updatedAt: 'desc' }],
      }),
      prisma.systemPrompt.findMany({
        where:   { isActive: true, isGlobal: true },
        orderBy: { title: 'asc' },
        select:  { id: true, title: true, body: true, category: true },
      }),
    ]);

    res.json({ personal, global });
  } catch (err) {
    next(err);
  }
});

// POST /user/prompts
router.post('/prompts', async (req, res, next) => {
  try {
    const { title, body, isFavorite } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });

    const prompt = await prisma.userPrompt.create({
      data: { userId: req.user.sub, title, body, isFavorite: !!isFavorite },
    });

    res.status(201).json(prompt);
  } catch (err) {
    next(err);
  }
});

// PATCH /user/prompts/:id
router.patch('/prompts/:id', async (req, res, next) => {
  try {
    const { title, body, isFavorite } = req.body;
    const data = {};
    if (title      !== undefined) data.title      = title;
    if (body       !== undefined) data.body        = body;
    if (isFavorite !== undefined) data.isFavorite  = isFavorite;

    const prompt = await prisma.userPrompt.update({
      where: { id: req.params.id, userId: req.user.sub },
      data,
    });

    res.json(prompt);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Prompt not found' });
    next(err);
  }
});

// DELETE /user/prompts/:id
router.delete('/prompts/:id', async (req, res, next) => {
  try {
    await prisma.userPrompt.delete({
      where: { id: req.params.id, userId: req.user.sub },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Prompt not found' });
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MODELS (read-only for end users — tenant models visible to them)
// ─────────────────────────────────────────────────────────────────────────────

// GET /user/models
router.get('/models', async (req, res, next) => {
  try {
    const models = await prisma.aiModel.findMany({
      where:   { tenantId: req.tenant.id, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select:  {
        id:            true,
        name:          true,
        pbiWorkspaceId: true,
        pbiDatasetId:  true,
        measures:      true,
        status:        true,
        createdAt:     true,
      },
    });
    res.json(models);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

// GET /user/account
router.get('/account', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id: req.user.sub },
      include: {
        tenant: {
          include: {
            plan: true,
            _count: { select: { models: true, users: true } },
          },
        },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tenant = user.tenant;
    res.json({
      user: {
        id:       user.id,
        email:    user.email,
        name:     user.name,
        role:     user.role,
      },
      tenant: tenant
        ? {
            id:          tenant.id,
            name:        tenant.name,
            subdomain:   tenant.subdomain,
            plan:        tenant.plan,
            creditLimit: tenant.creditLimit,
            creditUsed:  tenant.creditUsed,
            creditPct:   Math.round((tenant.creditUsed / tenant.creditLimit) * 100),
            status:      tenant.status,
            models:      tenant._count.models,
            users:       tenant._count.users,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /user/account  (update name/password)
router.patch('/account', async (req, res, next) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const data = {};

    if (name) data.name = name;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'currentPassword required to change password' });
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      data.passwordHash = await bcrypt.hash(newPassword, 12);
    }

    const updated = await prisma.user.update({
      where: { id: req.user.sub },
      data,
      select: { id: true, email: true, name: true, role: true },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /user/account/usage  (credit transaction history)
router.get('/account/usage', async (req, res, next) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    if (!req.tenant) return res.status(400).json({ error: 'Tenant context missing' });

    const [txs, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where:   { tenantId: req.tenant.id },
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.creditTransaction.count({ where: { tenantId: req.tenant.id } }),
    ]);

    res.json({ data: txs, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
