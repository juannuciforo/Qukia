const router  = require('express').Router();
const prisma  = require('../../lib/prisma');
const aiSvc   = require('../../services/ai');
const { deductCredits } = require('../../middleware/credits');
const logger  = require('../../utils/logger');
const { generateTitle } = require('../../services/titleGenerator');

// POST /user/chat/message  (streaming SSE)
router.post('/message', async (req, res, next) => {
  const { conversationId, modelId, message, systemPromptId } = req.body;

  // modelId es opcional — si no hay modelo PBI conectado se responde sin DAX
  if (!message?.trim()) {
    return res.status(400).json({ error: 'message required' });
  }

  try {
    const tenant = req.tenant;

    // model es null si no se pasa modelId o no existe
    let model = null;
    if (modelId) {
      model = await prisma.aiModel.findFirst({
        where: { id: modelId, tenantId: tenant.id, status: 'ACTIVE' },
      });
      if (!model) return res.status(404).json({ error: 'Model not found or inactive' });
    }

    // Resolve or create conversation
    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.user.sub },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 12,
          },
        },
      });
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      const title = await generateTitle(message.trim());
      conversation = await prisma.conversation.create({
        data: {
          userId:   req.user.sub,
          tenantId: tenant.id,
          modelId:  model?.id || null,
          title,
        },
        include: { messages: true },
      });
    }

    // Resolve custom system prompt
    let systemPromptBody = null;
    if (systemPromptId) {
      const sp = await prisma.systemPrompt.findUnique({ where: { id: systemPromptId } });
      if (sp?.isActive) systemPromptBody = sp.body;
    }

    // Persist user message
    const userMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: 'USER', content: message.trim() },
    });

    // Build history
    const history = [
      ...conversation.messages.map(m => ({
        role:    m.role.toLowerCase(),
        content: m.content,
      })),
      { role: 'user', content: message.trim() },
    ];

    // Start SSE
    aiSvc.startSSE(res);
    aiSvc.sendSSE(res, { type: 'conversation_id', conversationId: conversation.id });

    // Run inference with all optimizations
    const { inputTokens, outputTokens, totalTokens, credits, fromCache } = await aiSvc.chat({
      model,
      messages:     history,
      systemPrompt: systemPromptBody,
      tenantId:     tenant.id,
      res,
    });

    aiSvc.endSSE(res, { inputTokens, outputTokens, totalTokens, credits, fromCache });

    // Only deduct credits if not from cache
    if (!fromCache && credits > 0) {
      await deductCredits(
        tenant.id,
        credits,
        'Chat: ' + (model?.name || 'sin modelo') + ' — conv ' + conversation.id,
        userMessage.id
      );
    }

    logger.info('Chat completed', {
      userId:         req.user.sub,
      tenantId:       tenant.id,
      conversationId: conversation.id,
      modelId:        model?.id || null,
      totalTokens,
      credits,
      fromCache,
    });
  } catch (err) {
    logger.error('Chat route error', { error: err.message, stack: err.stack });
    if (res.headersSent) {
      // SSE ya inició — no podemos cambiar status, solo intentar notificar
      try {
        aiSvc.sendSSE(res, { type: 'error', message: err.message });
      } catch (_) { /* res ya cerrado, ignorar */ }
      if (!res.writableEnded) res.end();
    } else {
      next(err);
    }
  }
});

// POST /user/chat/confirm
router.post('/confirm', async (req, res, next) => {
  try {
    const { conversationId, content, inputTokens, outputTokens, creditsUsed } = req.body;
    if (!conversationId || !content) {
      return res.status(400).json({ error: 'conversationId and content required' });
    }

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: req.user.sub },
    });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { dashboards } = req.body;
    const msg = await prisma.message.create({
      data: {
        conversationId,
        role:         'ASSISTANT',
        content,
        inputTokens:  inputTokens  || 0,
        outputTokens: outputTokens || 0,
        creditsUsed:  creditsUsed  || 0,
        metadata:     dashboards?.length ? { dashboards } : undefined,
      },
    });

    res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    next(err);
  }
});

// GET /user/chat/conversations
router.get('/conversations', async (req, res, next) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where:   { userId: req.user.sub },
        skip,
        take:    parseInt(limit),
        orderBy: { updatedAt: 'desc' },
        include: {
          model:  { select: { name: true } },
          _count: { select: { messages: true } },
        },
      }),
      prisma.conversation.count({ where: { userId: req.user.sub } }),
    ]);

    res.json({
      data: conversations.map(c => ({
        id:        c.id,
        title:     c.title || 'Sin titulo',
        model:     c.model?.name,
        messages:  c._count.messages,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
      })),
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /user/chat/conversations/:id
router.get('/conversations/:id', async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where:   { id: req.params.id, userId: req.user.sub },
      include: {
        model:    { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  } catch (err) {
    next(err);
  }
});

// DELETE /user/chat/conversations/:id
router.delete('/conversations/:id', async (req, res, next) => {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (!conv) return res.status(404).json({ error: 'Not found' });
    await prisma.conversation.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;