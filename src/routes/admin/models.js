const router = require('express').Router();
const prisma = require('../../lib/prisma');
const powerbiService = require('../../services/powerbi');
const semanticCache = require('../../services/semanticCache');
const { redis }     = require('../../lib/redis');

// GET /admin/models
router.get('/', async (req, res, next) => {
  try {
    const { tenantId, status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (tenantId) where.tenantId = tenantId;
    if (status)   where.status   = status;

    const [models, total] = await Promise.all([
      prisma.aiModel.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          tenant: { select: { name: true, slug: true } },
          _count: { select: { conversations: true } },
        },
      }),
      prisma.aiModel.count({ where }),
    ]);

    const modelIds = models.map(m => m.pbiDatasetId).filter(Boolean);

    const cacheFlags = await Promise.all(
      modelIds.map(id => redis.exists(`pbi:schema:${id}`))
    );

    const cacheMap = {};
    modelIds.forEach((id, i) => { cacheMap[id] = cacheFlags[i] === 1; });

    console.log('modelIds:', modelIds);
    console.log('cacheMap:', cacheMap);
    res.json({
      data: models.map(m => ({
        ...m,
        pbiClientSecret: m.pbiClientSecret ? '***' : null,
        schemaCache: m.pbiDatasetId ? cacheMap[m.pbiDatasetId] ?? false : false,
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

// GET /admin/models/:id
router.get('/:id', async (req, res, next) => {
  try {
    const model = await prisma.aiModel.findUnique({
      where: { id: req.params.id },
      include: { tenant: true },
    });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    res.json({ ...model, pbiClientSecret: model.pbiClientSecret ? '***' : null });
  } catch (err) {
    next(err);
  }
});

// POST /admin/models
router.post('/', async (req, res, next) => {
  try {
    const {
      name, tenantId, pbiWorkspaceId, pbiDatasetId, pbiReportId,
      pbiClientId, pbiClientSecret, pbiTenantId, measures,
    } = req.body;

    if (!name || !tenantId || !pbiWorkspaceId || !pbiDatasetId) {
      return res.status(400).json({
        error: 'name, tenantId, pbiWorkspaceId, pbiDatasetId required',
      });
    }

    const model = await prisma.aiModel.create({
      data: {
        name,
        tenantId,
        pbiWorkspaceId,
        pbiDatasetId,
        pbiReportId:     pbiReportId  || null,
        pbiClientId:     pbiClientId  || null,
        pbiClientSecret: pbiClientSecret || null,
        pbiTenantId:     pbiTenantId  || null,
        measures:        measures || [],
      },
      include: { tenant: { select: { name: true, slug: true } } },
    });

    res.status(201).json({ ...model, pbiClientSecret: undefined });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Model name already exists for this tenant' });
    next(err);
  }
});

// PATCH /admin/models/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const {
      name, pbiWorkspaceId, pbiDatasetId, pbiReportId,
      pbiClientId, pbiClientSecret, pbiTenantId, measures, status,
    } = req.body;

    const data = {};
    if (name             !== undefined) data.name             = name;
    if (pbiWorkspaceId   !== undefined) data.pbiWorkspaceId   = pbiWorkspaceId;
    if (pbiDatasetId     !== undefined) data.pbiDatasetId     = pbiDatasetId;
    if (pbiReportId      !== undefined) data.pbiReportId      = pbiReportId;
    if (pbiClientId      !== undefined) data.pbiClientId      = pbiClientId;
    if (pbiClientSecret  !== undefined) data.pbiClientSecret  = pbiClientSecret;
    if (pbiTenantId      !== undefined) data.pbiTenantId      = pbiTenantId;
    if (measures         !== undefined) data.measures         = measures;
    if (status           !== undefined) data.status           = status;

    const model = await prisma.aiModel.update({
      where: { id: req.params.id },
      data,
      include: { tenant: { select: { id: true } } },
    });

    // FIX: invalidar caches cuando se modifica un modelo
    const shouldInvalidate =
      pbiDatasetId !== undefined ||
      pbiWorkspaceId !== undefined ||
      status !== undefined;

    if (shouldInvalidate && model.tenant?.id) {
      // 1. Schema PBI cacheado en Redis
      await redis.del(`pbi:schema:${model.pbiDatasetId}`);
      // 2. Respuestas semanticas del tenant (pueden estar basadas en schema viejo)
      await semanticCache.invalidateTenant(model.tenant.id);
    }

    res.json({ ...model, pbiClientSecret: undefined });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Model not found' });
    next(err);
  }
});

// DELETE /admin/models/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.aiModel.delete({
      where: { id: req.params.id },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Model not found' });
    next(err);
  }
});

// POST /admin/models/:id/test  — verify Power BI connectivity
router.post('/:id/test', async (req, res, next) => {
  try {
    const model = await prisma.aiModel.findUnique({ where: { id: req.params.id } });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    const result = await powerbiService.testConnection(model);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /admin/models/:id/sync-schema
router.post('/:id/sync-schema', async (req, res, next) => {
  try {
    const model = await prisma.aiModel.findFirst({
      where: { id: req.params.id, status: 'ACTIVE' }
    });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    await redis.del(`pbi:schema:${model.pbiDatasetId}`);
    await redis.del(`pbi:schema-index:${model.pbiDatasetId}`);

    const schema = await powerbiService.getDatasetSchema(model);
    await powerbiService.getSchemaIndex(model);

    res.json({ ok: true, tables: schema.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
