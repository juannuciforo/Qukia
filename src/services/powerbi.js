const axios = require('axios');
const logger = require('../utils/logger');
const { redis, CACHE_TTL } = require('../lib/redis');

const PBI_API = 'https://api.powerbi.com/v1.0/myorg';
const TOKEN_KEY = (clientId) => `pbi:token:${clientId}`;

const IMPERSONATED_USER = process.env.PBI_IMPERSONATED_USER || 'cookdata@cookdatabi.com';

async function getAccessToken(model) {
  const clientId     = model.pbiClientId     || process.env.PBI_CLIENT_ID;
  const clientSecret = model.pbiClientSecret || process.env.PBI_CLIENT_SECRET;
  const tenantId     = model.pbiTenantId     || process.env.PBI_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('Power BI credentials not configured for this model');
  }

  const cacheKey = TOKEN_KEY(clientId);
  const cached   = await redis.get(cacheKey);
  if (cached) return cached;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://analysis.windows.net/powerbi/api/.default',
  });

  const { data } = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  await redis.setex(cacheKey, data.expires_in - 300, data.access_token);
  return data.access_token;
}

async function runDaxQuery(model, daxQuery) {
  const token = await getAccessToken(model);
  const url = `${PBI_API}/groups/${model.pbiWorkspaceId}/datasets/${model.pbiDatasetId}/executeQueries`;

  try {
    const { data } = await axios.post(url, {
      queries: [{ query: daxQuery }],
      serializerSettings: { includeNulls: true },
      impersonatedUserName: IMPERSONATED_USER,
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    return data.results?.[0]?.tables?.[0]?.rows ?? [];
  } catch (err) {
    logger.error('DAX execution error', {
      error: err.message,
      status: err.response?.status,
      detail: err.response?.data,
      dax: daxQuery,
    });
    throw err;
  }
}

/**
 * Obtiene schema via Scanner API (Admin API).
 *
 * Requisitos en Power BI Admin Portal:
 * 1. "Service principals can access read-only admin APIs" → habilitado para el Security Group
 * 2. "Enhance admin APIs responses with detailed metadata" → habilitado
 * 3. El App Registration en Azure NO debe tener permisos con "Admin consent required"
 *
 * Flujo: getInfo → polling scanStatus → scanResult → extraer tablas/columnas
 */
async function getDatasetSchema(model) {
  const cacheKey = `pbi:schema:${model.pbiDatasetId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const token = await getAccessToken(model);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Paso 1: iniciar scan ───────────────────────────────────────────────────
  let scanId;
  try {
    const { data } = await axios.post(
      `${PBI_API}/admin/workspaces/getInfo?datasetSchema=True&datasetExpressions=True`,
      { workspaces: [model.pbiWorkspaceId] },
      { headers, timeout: 15000 }
    );
    scanId = data.id;
    logger.debug('Scanner API scan started', { scanId, workspaceId: model.pbiWorkspaceId });
  } catch (err) {
    logger.error('Scanner API getInfo failed', {
      error: err.message,
      status: err.response?.status,
      detail: err.response?.data,
    });
    return [];
  }

  // ── Paso 2: polling hasta Succeeded (max 30s) ──────────────────────────────
  let scanResult = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const { data: status } = await axios.get(
        `${PBI_API}/admin/workspaces/scanStatus/${scanId}`,
        { headers, timeout: 10000 }
      );
      logger.debug('Scanner API poll', { status: status.status, attempt: i + 1 });
      if (status.status === 'Succeeded') {
        const { data: result } = await axios.get(
          `${PBI_API}/admin/workspaces/scanResult/${scanId}`,
          { headers, timeout: 15000 }
        );
        scanResult = result;
        break;
      }
      if (status.status === 'Failed') {
        logger.error('Scanner API scan failed', { scanId });
        return [];
      }
    } catch (err) {
      logger.error('Scanner API polling error', { error: err.message });
      return [];
    }
  }

  if (!scanResult) {
    logger.error('Scanner API timeout after 30s', { scanId });
    return [];
  }

   // ── Paso 3: extraer y filtrar schema ──────────────────────────────────────
  const workspace = scanResult.workspaces?.[0];
  const dataset   = workspace?.datasets?.find(d => d.id === model.pbiDatasetId);

  if (!dataset) {
    logger.warn('Scanner API: dataset not found in scan result', {
      datasetId: model.pbiDatasetId,
      availableDatasets: workspace?.datasets?.map(d => d.id),
    });
    return [];
  }

  // Prefijos de tablas internas de Power BI que nunca son útiles para análisis
  const SYSTEM_TABLE_PREFIXES = ['$', 'DateTableTemplate', 'LocalDateTable', 'RowNumber'];

  // Columnas técnicas internas que no aportan valor analítico
  const SYSTEM_COLUMN_PATTERNS = /^(RowNumber|__|\$)/i;

  const schema = (dataset.tables || [])
    .filter(t => {
      if (!t.name) return false;
      return !SYSTEM_TABLE_PREFIXES.some(p => t.name.startsWith(p));
    })
    .map(t => {
      // Filtrar columnas técnicas y limitar a 40 por tabla (las más relevantes)
      const columns = (t.columns || [])
        .filter(c => c.name && !SYSTEM_COLUMN_PATTERNS.test(c.name))
        .slice(0, 40)
        .map(c => ({ name: c.name, type: c.dataType || 'string' }));

      // Incluir medidas con expresión truncada a 150 chars
      // — suficiente para que Claude entienda qué calcula sin explotar el context window
      const measures = (t.measures || [])
        .map(m => ({
          name:       m.name,
          expression: m.expression
            ? m.expression.replace(/\s+/g, ' ').trim().slice(0, 150)
            : '',
        }));

      return { name: t.name, columns, measures };
    })
    // Priorizar tablas que tienen medidas (son las más útiles para análisis)
    .sort((a, b) => (b.measures.length - a.measures.length));

  if (schema.length > 0) {
    await redis.setex(cacheKey, CACHE_TTL.LONG, JSON.stringify(schema));
    logger.info('Schema fetched via Scanner API', {
      datasetId:     model.pbiDatasetId,
      tables:        schema.length,
      totalColumns:  schema.reduce((acc, t) => acc + t.columns.length, 0),
      totalMeasures: schema.reduce((acc, t) => acc + t.measures.length, 0),
    });
  } else {
    logger.warn('Scanner API returned dataset but no tables', { datasetId: model.pbiDatasetId });
  }

  return schema;
}

async function testConnection(model) {
  try {
    const token = await getAccessToken(model);
    const { data } = await axios.get(
      `${PBI_API}/groups/${model.pbiWorkspaceId}/datasets`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const found = data.value?.find(d => d.id === model.pbiDatasetId);
    return {
      ok:      !!found,
      message: found ? 'Connected successfully' : 'Dataset not found in workspace',
      dataset: found || null,
    };
  } catch (err) {
    logger.error('PBI connection test failed', { error: err.message, detail: err.response?.data });
    return { ok: false, message: err.response?.data?.error?.message || err.message };
  }
}

module.exports = { runDaxQuery, getDatasetSchema, testConnection, getAccessToken };