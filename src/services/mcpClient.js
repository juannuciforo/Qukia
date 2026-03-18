/**
 * mcpClient.js
 *
 * Cliente Streamable HTTP para el servidor remoto de Power BI MCP de Microsoft.
 * Endpoint: https://api.fabric.microsoft.com/v1/mcp/powerbi
 *
 * El servidor usa Streamable HTTP (HTTP POST + JSON-RPC 2.0), NO SSE puro.
 * Requiere secuencia de inicialización MCP antes de poder llamar tools.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const MCP_ENDPOINT = 'https://api.fabric.microsoft.com/v1/mcp/powerbi';
let _requestId = 1;
const nextId = () => String(_requestId++);

/**
 * Envía un mensaje JSON-RPC al servidor MCP via HTTP POST.
 * Incluye Accept header requerido por la spec Streamable HTTP.
 */
async function mcpPost(token, body, sessionId = null) {
  const headers = {
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept:         'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const { data, headers: resHeaders } = await axios.post(MCP_ENDPOINT, body, {
    headers,
    timeout: 30000,
    // Necesario para recibir el Mcp-Session-Id del response header
    responseType: 'json',
  });

  return { data, sessionId: resHeaders?.['mcp-session-id'] || null };
}

/**
 * Inicializa una sesión MCP con el servidor.
 * Devuelve el sessionId para usar en todas las requests siguientes.
 */
async function initSession(token) {
  const { data, sessionId } = await mcpPost(token, {
    jsonrpc: '2.0',
    id:      nextId(),
    method:  'initialize',
    params:  {
      protocolVersion: '2024-11-05',
      capabilities:    {},
      clientInfo:      { name: 'qukia-backend', version: '1.0.0' },
    },
  });

  if (data?.error) throw new Error(`MCP init error: ${data.error.message}`);

  // Enviar initialized notification (sin id, es una notificación)
  await mcpPost(token, {
    jsonrpc: '2.0',
    method:  'notifications/initialized',
  }, sessionId);

  return sessionId;
}

/**
 * Llama una tool del servidor MCP.
 */
async function callTool(token, sessionId, toolName, toolArgs = {}) {
  const { data } = await mcpPost(token, {
    jsonrpc: '2.0',
    id:      nextId(),
    method:  'tools/call',
    params:  { name: toolName, arguments: toolArgs },
  }, sessionId);

  if (data?.error) throw new Error(`MCP tool error [${toolName}]: ${data.error.message}`);

  const content = data?.result?.content || [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');

  try   { return JSON.parse(text); }
  catch { return text; }
}

/**
 * Lista las tools disponibles en el servidor MCP.
 */
async function listTools(token, sessionId) {
  const { data } = await mcpPost(token, {
    jsonrpc: '2.0',
    id:      nextId(),
    method:  'tools/list',
    params:  {},
  }, sessionId);

  return data?.result?.tools || [];
}

/**
 * Obtiene el schema del modelo semántico via MCP.
 * Tool: GetSemanticModelSchema
 */
async function getSchemaViaMCP(model, token) {
  let sessionId;
  try {
    sessionId = await initSession(token);
    logger.debug('MCP session initialized', { sessionId });

    const result = await callTool(token, sessionId, 'GetSemanticModelSchema', {
      semanticModelId: model.pbiDatasetId,
    });

    const tables = result?.tables || result?.schema?.tables || [];
    if (!tables.length) return [];

    return tables
      .filter(t => t.name && !t.name.startsWith('$') && !t.name.startsWith('DateTableTemplate') && !t.name.startsWith('LocalDateTable'))
      .map(t => ({
        name:     t.name,
        columns:  (t.columns  || []).map(c => ({ name: c.name, type: c.dataType || c.type || 'string' })),
        measures: (t.measures || []).map(m => ({ name: m.name, expression: m.expression || '' })),
      }));

  } catch (err) {
    logger.error('MCP getSchemaViaMCP failed', {
      error:  err.message,
      status: err.response?.status,
      detail: err.response?.data,
    });
    return [];
  }
}

/**
 * Ejecuta DAX via MCP.
 * Tool: ExecuteQuery
 */
async function runDaxViaMCP(model, daxQuery, token) {
  let sessionId;
  try {
    sessionId = await initSession(token);

    const result = await callTool(token, sessionId, 'ExecuteQuery', {
      semanticModelId: model.pbiDatasetId,
      query:           daxQuery,
    });

    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.rows)) return result.rows;
    if (Array.isArray(result?.results?.[0]?.tables?.[0]?.rows)) {
      return result.results[0].tables[0].rows;
    }
    return [];

  } catch (err) {
    logger.error('MCP runDaxViaMCP failed', { error: err.message, status: err.response?.status });
    throw err;
  }
}

/**
 * Descubre tools disponibles — útil para debugging.
 */
async function discoverTools(token) {
  try {
    const sessionId = await initSession(token);
    const tools = await listTools(token, sessionId);
    logger.debug('MCP tools discovered', { tools: tools.map(t => t.name) });
    return tools;
  } catch (err) {
    logger.error('MCP discoverTools failed', { error: err.message });
    return [];
  }
}

module.exports = { getSchemaViaMCP, runDaxViaMCP, discoverTools };