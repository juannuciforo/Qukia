const prisma = require('../lib/prisma');
const { getOrSet, CACHE_TTL } = require('../lib/redis');

/**
 * Resolves the tenant context from:
 * 1. X-Tenant-Slug header (for explicit API calls)
 * 2. Subdomain of the Host header (e.g. alcala.quikia.cookdata.io)
 * 3. tenantId already on the JWT (for tenant users)
 *
 * Attaches req.tenant for downstream use.
 */
async function resolveTenant(req, res, next) {
  try {
    let slug = null;

    // Priority 1: explicit header
    if (req.headers['x-tenant-slug']) {
      slug = req.headers['x-tenant-slug'];
    }

    // Priority 2: subdomain
    if (!slug) {
      const host = req.hostname || '';
      const parts = host.split('.');
      if (parts.length >= 3) {
        slug = parts[0];
      }
    }

    // Priority 3: JWT tenantId
    if (!slug && req.user?.tenantId) {
      req.tenant = await getOrSet(
        `tenant:id:${req.user.tenantId}`,
        () => prisma.tenant.findUnique({ where: { id: req.user.tenantId }, include: { plan: true } }),
        CACHE_TTL.MEDIUM
      );
      return next();
    }

    if (!slug || slug === 'api' || slug === 'admin') {
      return next();
    }

    const tenant = await getOrSet(
      `tenant:slug:${slug}`,
      () => prisma.tenant.findUnique({ where: { slug }, include: { plan: true } }),
      CACHE_TTL.MEDIUM
    );

    if (!tenant) {
      return res.status(404).json({ error: `Tenant '${slug}' not found` });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Ensures the authenticated user belongs to the resolved tenant.
 * SUPERADMIN bypasses this check.
 */
function assertTenantAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (req.user.role === 'SUPERADMIN') return next();

  if (!req.tenant) {
    return res.status(400).json({ error: 'Tenant context missing' });
  }

  if (req.user.tenantId !== req.tenant.id) {
    return res.status(403).json({ error: 'Access denied to this tenant' });
  }

  next();
}

module.exports = { resolveTenant, assertTenantAccess };
