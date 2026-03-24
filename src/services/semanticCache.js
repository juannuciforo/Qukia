const crypto = require('crypto');
const { redis } = require('../lib/redis');
const logger = require('../utils/logger');

// TTL por defecto: 4 horas
const DEFAULT_TTL = 60 * 60 * 4;

/**
 * Genera una clave determinista a partir del tenantId + modelId + pregunta normalizada.
 * Normalizar = lowercase + colapsar espacios + strip puntuación irrelevante.
 * Así "¿Cómo van las ventas?" y "como van las ventas" dan el mismo hash.
 */
function buildCacheKey(tenantId, modelId, message) {
  const stopwords = ['el','la','los','las','un','una','de','del','en','por','para',
    'me','te','se','le','nos','que','con','sin','más','mas','muy','este','esta',
    'estos','estas','mi','mis','tu','sus','hay','como','hola','buenas','podrias',
    'podes','puedes','mostrame','mostrar','dame','dime','quiero','ver','necesito',
    'por','favor','porfavor','porfa'];

  const synonyms = {
    'insights':'resumen','análisis':'resumen','analisis':'resumen',
    'kpis':'resumen','métricas':'resumen','metricas':'resumen',
    'actuales':'actual','presente':'actual','hoy':'actual',
    'importantes':'','principales':'','precisos':'','completos':''
  };

  let normalized = message
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[¿?¡!.,;:]/g, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(w => !stopwords.includes(w))
    .map(w => synonyms[w] !== undefined ? synonyms[w] : w)
    .filter(Boolean)
    .sort() // orden alfabético — "ventas insights" == "insights ventas"
    .join(' ');

  const hash = crypto
    .createHash('sha256')
    .update(`${tenantId}:${modelId}:${normalized}`)
    .digest('hex')
    .slice(0, 16);

  return `semantic:${tenantId}:${hash}`;
}

async function get(tenantId, modelId, message) {
  try {
    const key = buildCacheKey(tenantId, modelId, message);
    const cached = await redis.get(key);
    if (!cached) return null;

    logger.debug('Semantic cache hit', { tenantId, key });
    return JSON.parse(cached);
  } catch (err) {
    logger.error('Semantic cache get error', { error: err.message });
    return null;
  }
}

async function set(tenantId, modelId, message, response, ttl = DEFAULT_TTL) {
  try {
    const key = buildCacheKey(tenantId, modelId, message);
    await redis.setex(key, ttl, JSON.stringify(response));
    logger.debug('Semantic cache set', { tenantId, key, ttl });
  } catch (err) {
    logger.error('Semantic cache set error', { error: err.message });
  }
}

/**
 * Invalida toda la caché semántica de un tenant.
 * Llamar cuando se actualiza el modelo PBI o el schema cambia.
 */
async function invalidateTenant(tenantId) {
  try {
    const keys = await redis.keys(`semantic:${tenantId}:*`);
    if (keys.length) {
      await redis.del(...keys);
      logger.info('Semantic cache invalidated', { tenantId, keys: keys.length });
    }
  } catch (err) {
    logger.error('Semantic cache invalidation error', { error: err.message });
  }
}

module.exports = { get, set, invalidateTenant };
