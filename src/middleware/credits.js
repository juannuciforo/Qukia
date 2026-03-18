const prisma = require('../lib/prisma');
const logger = require('../utils/logger');

/**
 * Called before any AI endpoint.
 * Checks the tenant has remaining credits.
 * Increments usage after a successful call via the deductCredits helper.
 */
async function checkCredits(req, res, next) {
  const tenant = req.tenant || req.dbUser?.tenant;

  if (!tenant) {
    return res.status(400).json({ error: 'Tenant context required for AI calls' });
  }

  // Reload fresh from DB to avoid stale cache during limit checks
  const fresh = await prisma.tenant.findUnique({ where: { id: tenant.id } });

  if (fresh.status === 'SUSPENDED') {
    return res.status(402).json({
      error: 'Account suspended. Credit limit reached.',
      code: 'TENANT_SUSPENDED',
    });
  }

  if (fresh.creditUsed >= fresh.creditLimit && fresh.suspendAt100) {
    return res.status(402).json({
      error: 'Credit limit reached.',
      code: 'CREDIT_LIMIT_REACHED',
      used: fresh.creditUsed,
      limit: fresh.creditLimit,
    });
  }

  // Attach fresh tenant for downstream use
  req.tenant = fresh;
  next();
}

/**
 * After AI call completes, deduct credits and record transaction.
 * credits = Math.ceil(totalTokens / TOKENS_PER_CREDIT)
 */
async function deductCredits(tenantId, credits, description, messageId) {
  if (credits <= 0) return;

  try {
    const [updatedTenant] = await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenantId },
        data: { creditUsed: { increment: credits } },
      }),
      prisma.creditTransaction.create({
        data: {
          tenantId,
          amount: credits,
          type: 'USAGE',
          description,
          messageId,
        },
      }),
    ]);

    // Trigger alerts (fire-and-forget)
    checkAlertThresholds(updatedTenant).catch((err) =>
      logger.error('Alert check error', { error: err.message })
    );
  } catch (err) {
    logger.error('Failed to deduct credits', { tenantId, credits, error: err.message });
  }
}

async function checkAlertThresholds(tenant) {
  const pct = (tenant.creditUsed / tenant.creditLimit) * 100;

  if (pct >= 100 && tenant.suspendAt100) {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { status: 'SUSPENDED' },
    });
    logger.warn(`Tenant ${tenant.slug} suspended: credit limit reached`);
    // TODO: send email notification
  } else if (pct >= 90 && tenant.alertAt90) {
    logger.warn(`Tenant ${tenant.slug}: 90% credit alert`);
    // TODO: send email notification
  } else if (pct >= 80 && tenant.alertAt80) {
    logger.warn(`Tenant ${tenant.slug}: 80% credit alert`);
    // TODO: send email notification
  } else if (pct >= 70 && tenant.alertAt70) {
    logger.warn(`Tenant ${tenant.slug}: 70% credit alert`);
    // TODO: send email notification
  }
}

module.exports = { checkCredits, deductCredits };
