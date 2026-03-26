require('./config/env'); // validates env vars on startup
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const { port, isDev }  = require('./config/env');
const logger           = require('./utils/logger');
const { redis }        = require('./lib/redis');
const prisma           = require('./lib/prisma');

const { authenticate, requireSuperAdmin, requireAnyUser } = require('./middleware/auth');
const { resolveTenant, assertTenantAccess } = require('./middleware/tenant');
const { checkCredits } = require('./middleware/credits');
const { notFound, errorHandler } = require('./middleware/errors');

// ─── ROUTES ──────────────────────────────────────────────────────────────────
const authRouter      = require('./routes/auth');
const adminDashboard  = require('./routes/admin/dashboard');
const adminTenants    = require('./routes/admin/tenants');
const adminUsers      = require('./routes/admin/users');
const adminModels     = require('./routes/admin/models');
const adminPrompts    = require('./routes/admin/prompts');
const adminPlans      = require('./routes/admin/plans');
const adminLogs       = require('./routes/admin/logs');
const userChat        = require('./routes/user/chat');
const userFiles       = require('./routes/user/files');
const userAccount     = require('./routes/user/account');

// ─── APP ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// ─── SECURITY & COMPRESSION ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: '*',
  credentials: true,
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { error: 'Too many login attempts, try again in 15 minutes.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { error: 'Too many AI requests per minute.' },
});

app.use(apiLimiter);

// ─── BODY PARSING ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── LOGGING ─────────────────────────────────────────────────────────────────
app.use(
  morgan(isDev ? 'dev' : 'combined', {
    stream: { write: msg => logger.http(msg.trim()) },
    skip:   (req) => req.path === '/health',
  })
);


// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.use(express.static('public'));

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

// ─── ROOT REDIRECT ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/app.html');
});

// ─── AUTH (public) ────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRouter);

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
// All admin routes require SUPERADMIN role
app.use(
  '/admin',
  authenticate,
  requireSuperAdmin,
  (router => {
    router.use('/dashboard', adminDashboard);
    router.use('/tenants',   adminTenants);
    router.use('/users',     adminUsers);
    router.use('/models',    adminModels);
    router.use('/prompts',   adminPrompts);
    router.use('/plans',     adminPlans);
    router.use('/logs',      adminLogs);
    router.post('/debug/flush-semantic', async (req, res) => {
      try {
        const keys = await redis.keys('semantic:*');
        if (keys.length > 0) await redis.del(keys);
        const schemas = await redis.keys('pbi:*');
        res.json({ deleted: keys.length, schemasPreserved: schemas.length, keys });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
    return router;
  })(express.Router())
);

// ─── USER ROUTES ──────────────────────────────────────────────────────────────
// Tenant users: authenticate → resolve tenant → assert access
const userRouter = express.Router();

userRouter.use(authenticate);
userRouter.use(requireAnyUser);
userRouter.use(resolveTenant);
userRouter.use(assertTenantAccess);

// Chat routes also go through credit check
userRouter.use('/chat', chatLimiter, userChat);

// Files and account do not need credit check
userRouter.use('/files',   userFiles);
userRouter.use('/',        userAccount); // /user/prompts, /user/models, /user/account

app.use('/user', userRouter);

// ─── 404 & ERROR HANDLING ────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── STARTUP ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    await redis.connect().catch(() => {}); // Redis is optional at startup

    app.listen(port, () => {
      logger.info(`QUKia API running on port ${port} [${isDev ? 'development' : 'production'}]`);
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await prisma.$disconnect();
  process.exit(0);
});

start();
