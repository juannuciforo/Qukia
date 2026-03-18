const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');
const prisma = require('../lib/prisma');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, jwtConfig.secret);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Load full user from DB and attach to req
async function loadUser(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { tenant: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.dbUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

const requireSuperAdmin  = requireRole('SUPERADMIN');
const requireTenantAdmin = requireRole('SUPERADMIN', 'TENANT_ADMIN');
const requireAnyUser     = requireRole('SUPERADMIN', 'TENANT_ADMIN', 'USER');

module.exports = {
  authenticate,
  loadUser,
  requireRole,
  requireSuperAdmin,
  requireTenantAdmin,
  requireAnyUser,
};
