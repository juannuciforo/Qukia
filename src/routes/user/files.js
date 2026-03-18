const router  = require('express').Router();
const path    = require('path');
const fs      = require('fs');
const prisma  = require('../../lib/prisma');
const aiSvc   = require('../../services/ai');
const { upload, parseFile } = require('../../services/fileParser');
const { deductCredits } = require('../../middleware/credits');
const { generateTitle } = require('../../services/titleGenerator');

// ─── POST /user/files  (upload) ───────────────────────────────────────────────
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = await prisma.file.create({
      data: {
        userId:   req.user.sub,
        tenantId: req.tenant.id,
        name:     req.file.originalname,
        mimeType: req.file.mimetype,
        size:     req.file.size,
        path:     req.file.path,
        status:   'PROCESSING',
      },
    });

    // Parse asynchronously — don't block the upload response
    parseFile(req.file.path, req.file.mimetype)
      .then(parsed =>
        prisma.file.update({
          where: { id: file.id },
          data:  { status: 'READY', parsedData: { text: parsed } },
        })
      )
      .catch(err =>
        prisma.file.update({
          where: { id: file.id },
          data:  { status: 'ERROR', parsedData: { error: err.message } },
        })
      );

    res.status(201).json({
      id:       file.id,
      name:     file.name,
      mimeType: file.mimeType,
      size:     file.size,
      status:   file.status,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /user/files ──────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const files = await prisma.file.findMany({
      where:   { userId: req.user.sub, tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' },
      select:  { id: true, name: true, mimeType: true, size: true, status: true, createdAt: true },
    });
    res.json(files);
  } catch (err) {
    next(err);
  }
});

// ─── POST /user/files/analyze  (multi-file) ──────────────────────────────────
// Body: { fileIds: string[], question: string, modelId?: string, conversationId?: string }
router.post('/analyze', async (req, res, next) => {
  const { fileIds, question, modelId, conversationId } = req.body;

  if (!question)          return res.status(400).json({ error: 'question is required' });
  if (!fileIds?.length)   return res.status(400).json({ error: 'fileIds array is required' });
  if (fileIds.length > 5) return res.status(400).json({ error: 'Max 5 files per message' });

  try {
    // Cargar y validar archivos
    const files = await prisma.file.findMany({
      where: { id: { in: fileIds }, userId: req.user.sub, tenantId: req.tenant.id },
    });
    for (const id of fileIds) {
      const f = files.find(x => x.id === id);
      if (!f)                   return res.status(404).json({ error: `File ${id} not found` });
      if (f.status !== 'READY') return res.status(400).json({ error: `File "${f.name}" is not ready yet` });
    }

    // Modelo opcional
    let model = null;
    if (modelId) {
      model = await prisma.aiModel.findFirst({
        where: { id: modelId, tenantId: req.tenant.id, status: 'ACTIVE' },
      });
      if (!model) return res.status(404).json({ error: 'Model not found' });
    }

    const fileNames   = files.map(f => f.name).join(', ');
    const fileContent = files.map(f =>
      `=== FILE: ${f.name} ===\n${f.parsedData?.text || '(empty)'}\n`
    ).join('\n');

    // ── Crear o reutilizar conversación ──────────────────────────────────────
    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.user.sub },
      });
    }
    if (!conversation) {
      const title = await generateTitle(question, files.map(f => f.name));
      conversation = await prisma.conversation.create({
        data: {
          userId:   req.user.sub,
          tenantId: req.tenant.id,
          modelId:  model?.id || null,
          title,
        },
      });
    }

    // Guardar mensaje del usuario
    const userContent = `[Archivos: ${fileNames}]\n${question}`;
    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'USER', content: userContent },
    });

    // ── Inferencia ───────────────────────────────────────────────────────────
    const { text, credits, inputTokens, outputTokens } = await aiSvc.analyzeFile({
      model,
      fileContent,
      fileName:     fileNames,
      userQuestion: question,
    });

    // Guardar respuesta del asistente
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role:           'ASSISTANT',
        content:        text,
        inputTokens:    inputTokens  || 0,
        outputTokens:   outputTokens || 0,
        creditsUsed:    credits      || 0,
      },
    });

    // Actualizar updatedAt de la conversación (para que aparezca primero en recientes)
    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { updatedAt: new Date() },
    });

    await deductCredits(
      req.tenant.id,
      credits,
      `File analysis: ${fileNames}`,
    );

    res.json({ text, credits, inputTokens, outputTokens, conversationId: conversation.id });
  } catch (err) {
    next(err);
  }
});

// ─── POST /user/files/:id/analyze  (legacy single-file — mantener compatibilidad) ──
router.post('/:id/analyze', async (req, res, next) => {
  const { modelId, question } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (!file)                   return res.status(404).json({ error: 'File not found' });
    if (file.status !== 'READY') return res.status(400).json({ error: 'File is not ready yet' });
    let model = null;
    if (modelId) {
      model = await prisma.aiModel.findFirst({
        where: { id: modelId, tenantId: req.tenant.id, status: 'ACTIVE' },
      });
      if (!model) return res.status(404).json({ error: 'Model not found' });
    }
    const { text, credits, inputTokens, outputTokens } = await aiSvc.analyzeFile({
      model, fileContent: file.parsedData?.text || '',
      fileName: file.name, userQuestion: question,
    });
    await deductCredits(req.tenant.id, credits, `File analysis: ${file.name}`);
    res.json({ text, credits, inputTokens, outputTokens });
  } catch (err) { next(err); }
});

// ─── DELETE /user/files/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    await prisma.file.delete({ where: { id: file.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;