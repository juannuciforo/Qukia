const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../../lib/prisma');

// GET /admin/users
router.get('/', async (req, res, next) => {
  try {
    const { search, tenantId, role, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { role: { not: 'SUPERADMIN' } };
    if (tenantId) where.tenantId = tenantId;
    if (role)     where.role     = role;
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id:        true,
          email:     true,
          name:      true,
          role:      true,
          isActive:  true,
          tenantId:  true,
          tenant:    { select: { name: true, slug: true } },
          _count:    { select: { conversations: true } },
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      data: users,
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

// POST /admin/users
router.post('/', async (req, res, next) => {
  try {
    const { email, name, password, role = 'USER', tenantId } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'email, name, password required' });
    }

    if (role === 'USER' || role === 'TENANT_ADMIN') {
      if (!tenantId) return res.status(400).json({ error: 'tenantId required for tenant users' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: { email: email.toLowerCase().trim(), name, passwordHash, role, tenantId: tenantId || null },
      select: { id: true, email: true, name: true, role: true, tenantId: true, createdAt: true },
    });

    res.status(201).json(user);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
});

// PATCH /admin/users/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, email, role, isActive, tenantId, password } = req.body;
    const data = {};

    if (name     !== undefined) data.name     = name;
    if (email    !== undefined) data.email    = email.toLowerCase().trim();
    if (role     !== undefined) data.role     = role;
    if (isActive !== undefined) data.isActive = isActive;
    if (tenantId !== undefined) data.tenantId = tenantId;
    if (password)               data.passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, email: true, name: true, role: true, isActive: true, tenantId: true },
    });

    res.json(user);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    next(err);
  }
});

module.exports = router;
