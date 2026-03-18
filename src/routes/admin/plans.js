const router = require('express').Router();
const prisma = require('../../lib/prisma');

// GET /admin/plans
router.get('/', async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({
      orderBy: { creditLimit: 'asc' },
      include: { _count: { select: { tenants: true } } },
    });
    res.json(plans);
  } catch (err) {
    next(err);
  }
});

// POST /admin/plans
router.post('/', async (req, res, next) => {
  try {
    const { name, slug, creditLimit, modelLimit, userLimit, priceMonthly, features } = req.body;
    if (!name || !slug || !creditLimit) {
      return res.status(400).json({ error: 'name, slug, creditLimit required' });
    }

    const plan = await prisma.plan.create({
      data: {
        name,
        slug:         slug.toLowerCase(),
        creditLimit:  parseInt(creditLimit),
        modelLimit:   parseInt(modelLimit)  || 999,
        userLimit:    parseInt(userLimit)   || 999,
        priceMonthly: parseFloat(priceMonthly) || 0,
        features:     features || [],
      },
    });

    res.status(201).json(plan);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Plan slug already exists' });
    next(err);
  }
});

// PATCH /admin/plans/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, creditLimit, modelLimit, userLimit, priceMonthly, features, isActive } = req.body;
    const data = {};
    if (name         !== undefined) data.name         = name;
    if (creditLimit  !== undefined) data.creditLimit  = parseInt(creditLimit);
    if (modelLimit   !== undefined) data.modelLimit   = parseInt(modelLimit);
    if (userLimit    !== undefined) data.userLimit    = parseInt(userLimit);
    if (priceMonthly !== undefined) data.priceMonthly = parseFloat(priceMonthly);
    if (features     !== undefined) data.features     = features;
    if (isActive     !== undefined) data.isActive     = isActive;

    const plan = await prisma.plan.update({ where: { id: req.params.id }, data });
    res.json(plan);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Plan not found' });
    next(err);
  }
});

module.exports = router;
