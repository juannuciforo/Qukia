const router = require('express').Router();
const prisma = require('../../lib/prisma');

// GET /admin/logs
router.get('/', async (req, res, next) => {
  try {
    const { tenantId, userId, action, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (tenantId) where.tenantId = tenantId;
    if (userId)   where.userId   = userId;
    if (action)   where.action   = { contains: action, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: logs,
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

module.exports = router;
