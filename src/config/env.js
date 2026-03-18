require('dotenv').config();

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ANTHROPIC_API_KEY',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  nodeEnv:           process.env.NODE_ENV || 'development',
  port:              parseInt(process.env.PORT) || 3000,
  baseDomain:        process.env.BASE_DOMAIN || 'quikia.cookdata.io',

  db: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret:             process.env.JWT_SECRET,
    expiresIn:          process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret:      process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn:   process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  anthropic: {
    apiKey:  process.env.ANTHROPIC_API_KEY,
    model:   process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  },

  credits: {
    tokensPerCredit: parseInt(process.env.TOKENS_PER_CREDIT) || 1000,
  },

  upload: {
    dir:        process.env.UPLOAD_DIR || './uploads',
    maxSizeMb:  parseInt(process.env.MAX_FILE_SIZE_MB) || 20,
  },

  admin: {
    email:    process.env.ADMIN_EMAIL    || 'admin@cookdata.io',
    password: process.env.ADMIN_PASSWORD || 'changeme123',
    name:     process.env.ADMIN_NAME     || 'Super Admin',
  },

  isDev: process.env.NODE_ENV !== 'production',
};
