const Redis = require('ioredis');
const { redis: redisConfig } = require('../config/env');
const logger = require('../utils/logger');

const redis = new Redis(redisConfig.url, {
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: true,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', { error: err.message }));

const CACHE_TTL = {
  SHORT:  60,        // 1 minute
  MEDIUM: 60 * 15,   // 15 minutes
  LONG:   60 * 60,   // 1 hour
};

async function getOrSet(key, fetchFn, ttl = CACHE_TTL.MEDIUM) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const value = await fetchFn();
  await redis.setex(key, ttl, JSON.stringify(value));
  return value;
}

async function invalidate(...keys) {
  if (keys.length) await redis.del(...keys);
}

async function invalidatePattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

module.exports = { redis, CACHE_TTL, getOrSet, invalidate, invalidatePattern };
