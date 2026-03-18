const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { jwt: jwtConfig } = require('../config/env');
const logger = require('../utils/logger');

function signAccess(user) {
  return jwt.sign(
    {
      sub:      user.id,
      email:    user.email,
      role:     user.role,
      tenantId: user.tenantId,
    },
    jwtConfig.secret,
    { expiresIn: jwtConfig.expiresIn }
  );
}

function signRefresh(userId) {
  const token = uuidv4();
  const expiresAt = new Date(
    Date.now() + parseExpiry(jwtConfig.refreshExpiresIn)
  );
  return { token, expiresAt };
}

function parseExpiry(str) {
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 86400000;
  return parseInt(match[1]) * units[match[2]];
}

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { tenant: true },
  });

  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const accessToken = signAccess(user);
  const { token: refreshToken, expiresAt } = signRefresh(user.id);

  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt },
  });

  logger.info('User logged in', { userId: user.id, email: user.email });

  res.json({
    accessToken,
    refreshToken,
    user: {
      id:       user.id,
      email:    user.email,
      name:     user.name,
      role:     user.role,
      tenantId: user.tenantId,
      tenant:   user.tenant
        ? { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug }
        : null,
    },
  });
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken required' });
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  if (!stored.user.isActive) {
    return res.status(401).json({ error: 'User inactive' });
  }

  // Rotate refresh token
  const { token: newRefresh, expiresAt } = signRefresh(stored.userId);

  await prisma.$transaction([
    prisma.refreshToken.delete({ where: { token: refreshToken } }),
    prisma.refreshToken.create({
      data: { token: newRefresh, userId: stored.userId, expiresAt },
    }),
  ]);

  const accessToken = signAccess(stored.user);

  res.json({ accessToken, refreshToken: newRefresh });
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', require('../middleware/auth').authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    include: { tenant: { include: { plan: true } } },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    id:       user.id,
    email:    user.email,
    name:     user.name,
    role:     user.role,
    tenantId: user.tenantId,
    tenant:   user.tenant,
  });
});

module.exports = router;
