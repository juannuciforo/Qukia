const router = require('express').Router();
const prisma = require('../../lib/prisma');

// GET /admin/prompts
router.get('/', async (req, res, next) => {
  try {
    const { category, search } = req.query;
    const where = {};
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { body:  { contains: search, mode: 'insensitive' } },
      ];
    }

    const prompts = await prisma.systemPrompt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    res.json(prompts);
  } catch (err) {
    next(err);
  }
});

// GET /admin/prompts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const prompt = await prisma.systemPrompt.findUnique({ where: { id: req.params.id } });
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
    res.json(prompt);
  } catch (err) {
    next(err);
  }
});

// POST /admin/prompts
router.post('/', async (req, res, next) => {
  try {
    const { title, body, category, isGlobal } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });

    const prompt = await prisma.systemPrompt.create({
      data: {
        title,
        body,
        category: category || null,
        isGlobal: isGlobal !== false,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId:   req.user.sub,
        action:   'PROMPT_CREATED',
        entity:   'SystemPrompt',
        entityId: prompt.id,
        meta:     { title },
      },
    });

    res.status(201).json(prompt);
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/prompts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { title, body, category, isGlobal, isActive } = req.body;
    const data = {};
    if (title    !== undefined) data.title    = title;
    if (body     !== undefined) data.body     = body;
    if (category !== undefined) data.category = category;
    if (isGlobal !== undefined) data.isGlobal = isGlobal;
    if (isActive !== undefined) data.isActive = isActive;

    const prompt = await prisma.systemPrompt.update({
      where: { id: req.params.id },
      data,
    });

    res.json(prompt);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Prompt not found' });
    next(err);
  }
});

// DELETE /admin/prompts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.systemPrompt.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Prompt not found' });
    next(err);
  }
});

module.exports = router;
