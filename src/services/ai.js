const Anthropic = require('@anthropic-ai/sdk');
const { anthropic: anthropicConfig, credits: creditsConfig } = require('../config/env');
const pbiService    = require('./powerbi');
const semanticCache = require('./semanticCache');
const logger        = require('../utils/logger');

const client = new Anthropic({ apiKey: anthropicConfig.apiKey });

const MODELS = {
  fast:  'claude-haiku-4-5-20251001',
  smart: anthropicConfig.model || 'claude-sonnet-4-6',
};

function classifyMessage(message) {
  return { model: MODELS.smart, maxTokens: 8192, tier: 'smart' };
}

// ─── TOOL DEFINITIONS ────────────────────────────────────────────────────────

const tools = [
  {
    name: 'run_dax_query',
    description:
      'Executes a DAX query against the connected Power BI dataset and returns the result rows. ' +
      'Use this whenever you need real data to answer the user question. ' +
      'You can call this tool multiple times in parallel to gather different metrics simultaneously. ' +
      'Prefer SUMMARIZE, CALCULATE, TOPN, RANKX, FILTER, and ADDCOLUMNS for efficient queries. ' +
      'Always limit large result sets with TOPN or FILTER to avoid token bloat. ' +
      'Use defined measures (listed as [MeasureName] in the schema) whenever possible — they are pre-validated.',
    input_schema: {
      type: 'object',
      properties: {
        dax: {
          type:        'string',
          description: 'Valid DAX query starting with EVALUATE. No inline comments (// ...) as they break the API.',
        },
        description: {
          type:        'string',
          description: 'Brief human-readable description of what this query retrieves.',
        },
      },
      required: ['dax', 'description'],
    },
  },
];

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────────

function buildSystemPrompt(model, schema, systemPromptBody) {
  const schemaText = (schema || [])
    .map(t => {
      const cols = (t.columns || []).map(c => '  col: ' + c.name + ' (' + (c.type || 'string') + ')').join('\n');
      const measures = (t.measures || []).length > 0
        ? '\n' + (t.measures || []).map(m => '  measure: [' + m.name + ']').join('\n')
        : '';
      return 'Table: ' + t.name + '\n' + cols + measures;
    })
    .join('\n\n');

  const customInstructions = systemPromptBody
    ? '\n\n---\nINSTRUCCIONES ADICIONALES DEL CLIENTE:\n' + systemPromptBody
    : '';

  const modelContext = model
    ? 'Tienes acceso al dataset Power BI "' + model.name + '" via run_dax_query.\n\n' +
      'SCHEMA (tablas, columnas y medidas pre-definidas):\n' + (schemaText || '(schema no disponible)') + '\n\n'
    : 'No hay dataset Power BI conectado. Responde preguntas generales de negocio sin usar run_dax_query.\n\n';

  return `Eres QUKia, un analista de negocio senior experto integrado en una plataforma de inteligencia empresarial.
RESPONDE SIEMPRE EN ESPAÑOL.
Hoy es ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

${modelContext}
COMPORTAMIENTO PRINCIPAL:
- Ante cualquier pregunta de negocio, ve DIRECTO a los datos. No pidas contexto previo.
- Lanza MÚLTIPLES queries DAX en paralelo para recopilar todos los datos antes de responder.
- Usa las medidas ya definidas en el schema (listadas como [MeasureName]) — son más fiables que calcular desde cero.
- Para análisis completos, ejecutá 5-10 queries cubriendo: KPIs principales, comparativas vs período anterior, ranking de locales/productos, señales de alerta.
- Para dashboards mensuales o de período, incluí SIEMPRE una query de ventas por día (SUMMARIZE por fecha) para construir el lineChart de evolución diaria. El lineChart va ANTES del chart de barras en el JSON.
- Si el modelo tiene medidas de presupuesto u objetivo, incluí siempre un gaugeRow mostrando % de ejecución vs objetivo.
- Nunca inventes números. Si no encontrás los datos, decilo claramente.
- Nunca muestres código DAX al usuario salvo que lo pida explícitamente.

MODO DASHBOARD:
Cuando el usuario pida análisis complejos (resúmenes, dashboards, KPIs, comparativas de período, rankings),
incluí en tu respuesta EXACTAMENTE este delimitador de apertura: <<<DASHBOARD_START>>> y este de cierre: <<<DASHBOARD_END>>>. NO uses variantes como <<DASHBOARD_END>> o <<<DASHBOARD_END>>. Los delimitadores deben tener exactamente 3 signos < y 3 signos > en cada lado.
NO pongas títulos ni encabezados fuera del bloque JSON.
El título va dentro del campo "title" del JSON.
Podés incluir un párrafo de síntesis ejecutiva DESPUÉS del último <<<DASHBOARD_END>>>, nunca entre dashboards.

El JSON debe tener esta estructura exacta:
{
  "title": "Título del dashboard",
  "subtitle": "Período y contexto — ej: 1–18 mar 2026 · 16 locales activos",
  "kpis": [
    { "label": "Ventas Netas", "value": "€1.241.808", "delta": "▼ -2,3%", "deltaType": "negative", "vs": "vs mar 2025", "sub": "contexto adicional opcional" }
  ],
  "chart": {
    "type": "bar",
    "title": "Evolución diaria — Ventas Netas",
    "labels": ["1L","2M","3X","4J","5V","6S","7D"],
    "series": [
      { "label": "Mar 2026", "data": [45000, 23000, 31000, 28000, 52000, 148000, 76000] },
      { "label": "Mar 2025", "data": [38000, 21000, 29000, 25000, 48000, 120000, 65000] }
    ]
  },
  "rankingBars": {
    "title": "Ranking por ventas netas",
    "rows": [
      { "label": "Casa Ozama", "value": "€145K", "rawValue": 145000, "delta": "▼ -26%" },
      { "label": "Eslava RST", "value": "€143K", "rawValue": 143000, "delta": "▲ +12%" },
      { "label": "Local Nuevo", "value": "€80K", "rawValue": 80000, "delta": "nuevo" }
    ]
  },
  "ranking": {
    "title": "Ranking Locales — tabla detallada",
    "columns": ["Local", "Ventas", "vs LY", "Ticket Medio"],
    "rows": [["Casa Ozama", "€157.883", "▼ -26,7%", "€51,70"]]
  },
  "split": {
    "title": "Sábado vs Domingo",
    "items": [
      { "label": "Sábado 14", "value": "€148.805", "rawValue": 148805, "sub": "6.234 clientes · ticket €47,9", "delta": "▲ +40% vs jue", "deltaType": "positive" },
      { "label": "Domingo 15", "value": "€76.687", "rawValue": 76687, "sub": "3.365 clientes · ticket €43,1" }
    ]
  },
  "alerts": [{ "level": "critical", "title": "Título alerta", "text": "Descripción" }],
  "signals": [{ "level": "positive", "text": "Señal positiva" }],
  "actions": ["Acción recomendada 1"]
}

Reglas del JSON:
- Máximo 6-8 KPIs por dashboard — priorizá los más relevantes
- Siempre incluí "chart" cuando tengas datos de evolución temporal (ventas por día/semana)
- Siempre incluí "rankingBars" cuando tengas ranking de locales o productos
- deltaType: "positive" | "negative" | "neutral"
- alert.level: "critical" | "warning" | "info"
- signal.level: "positive" | "negative" | "neutral"
- Todos los valores monetarios con símbolo (€/$) y separador de miles
- Deltas con flecha: ▲ para positivo, ▼ para negativo

Instrucciones JSON:
- Usá "chart" cuando tengas datos de evolución diaria/semanal (series temporales)
- Usá "rankingBars" para rankings visuales con barras — más impactante que la tabla
- Usá "ranking" (tabla) solo cuando necesitás mostrar muchas columnas de detalle
- Usá "split" para comparar dos períodos (sábado vs domingo, semana vs fin de semana)
- En "rankingBars" el campo "rawValue" debe ser el número sin formato (para calcular el ancho de la barra)
- En rankingBars, para locales sin comparativa usar delta: "nuevo" (no "nuevo período")
- En "split" el campo "rawValue" debe ser el número sin formato (para el mini gráfico)
- Podés usar "rankingBars" y "ranking" juntos si querés vista visual + detalle
- En "split", si los items tienen magnitudes muy diferentes (ej: ventas en miles vs clientes), NO uses "chart" combinado — mostrá solo los KPI cards sin gráfico, o usá series separadas con rawValue normalizado
- Usá "lineChart" para mostrar evolución temporal diaria o semanal — es el gráfico más poderoso para hostelería. Estructura:
  {
    "lineChart": {
      "title": "Evolución diaria — Ventas Netas",
      "label": "Mar 2026",
      "prevLabel": "Mar 2025",
      "labels": ["1", "2", "3", "4", "5", "6", "7"],
      "data": [45000, 23000, 31000, 28000, 52000, 148000, 76000],
      "prevData": [38000, 21000, 29000, 25000, 48000, 120000, 65000]
    }
  }
  Si no tenés año anterior, omití "prevData" y "prevLabel". Los labels son los días del mes ("1", "2"... "31").

- Usá "gaugeRow" para mostrar objetivos o presupuesto vs ejecución — impacto visual inmediato. Estructura:
  {
    "gaugeRow": {
      "title": "Objetivos del período",
      "items": [
        { "label": "Presupuesto", "value": "86%", "pct": 86, "sub": "€1.24M de €1.44M" },
        { "label": "Ocupación", "value": "74%", "pct": 74, "sub": "objetivo 80%" },
        { "label": "Ticket Medio", "value": "92%", "pct": 92, "sub": "€47,2 de €51 obj." }
      ]
    }
  }
  El campo "pct" es un número entre 0 y 100. "value" es el string que se muestra en el gauge.

Para preguntas simples (saludos, preguntas puntuales de un solo dato), NO uses el bloque dashboard — responde en texto normal.

MANEJO DE ERRORES DAX:
- Si una query falla, reescribila con sintaxis más simple antes de rendirte
- Máximo 3 intentos por query, luego omitir ese dato e indicarlo
- Nunca dejes de responder por fallo de una query

REGLAS CRÍTICAS DE SINTAXIS DAX:
- Para filtrar por fecha NUNCA uses: Calendario[Date] IN {"2026-03-14"}
- Para filtrar por fecha SIEMPRE usá: DATESBETWEEN o FILTER con DATE()
- Ejemplos correctos:
  * Un día:    CALCULATE([Ventas Netas], Calendario[Date] = DATE(2026,3,14))
  * Varios días: CALCULATE([Ventas Netas], Calendario[Date] >= DATE(2026,3,14) && Calendario[Date] <= DATE(2026,3,15))
  * Un mes:    CALCULATE([Ventas Netas], MONTH(Calendario[Date]) = 3 && YEAR(Calendario[Date]) = 2026)
  * Rango:     CALCULATE([Ventas Netas], DATESBETWEEN(Calendario[Date], DATE(2026,3,1), DATE(2026,3,17)))
- Fin de semana actual: usá DATE() con los números exactos, nunca strings entre comillas
- En SUMMARIZE, la tabla de agrupación y las columnas de grupo deben ser de la MISMA tabla o de tablas directamente relacionadas. NUNCA mezcles columnas de tablas sin relación directa en el mismo SUMMARIZE.
- Para cruzar datos de múltiples tablas usá SUMMARIZECOLUMNS en lugar de SUMMARIZE — es más seguro con relaciones:
  * SUMMARIZECOLUMNS(Tabla1[Col], Tabla2[Col], "Medida", [MedidaDefinida])
- Cuando una query falla por columna no encontrada, reescribila usando solo medidas ya definidas en el schema y SUMMARIZECOLUMNS con las tablas correctas.

CONTEXTO DE NEGOCIO:
- "Locales" o "centros" = unidades de negocio individuales
- "Ticket medio" = ventas / número de tickets
- "Fin de semana" = sábado + domingo del último fin de semana completo
- "Este mes" = mes en curso hasta hoy (${new Date().toLocaleDateString('es-ES')})
- "LY" = mismo período año anterior
- Sectores comunes: hostelería, retail, servicios
${customInstructions}`;
}

// ─── SCHEMA FETCH ─────────────────────────────────────────────────────────────

async function fetchSchema(model) {
  if (!model) return [];
  return pbiService.getDatasetSchema(model).catch(err => {
    logger.error('Schema fetch failed', { error: err.message });
    return [];
  });
}

async function filterSchemaByQuery(query, schemaIndex) {
  if (!schemaIndex || schemaIndex.length === 0) return [];
  if (schemaIndex.length <= 15) return schemaIndex.map(t => t.name);

  const indexText = schemaIndex.map(t => {
    const measures = t.measures.length > 0
      ? ` | medidas: ${t.measures.slice(0, 8).join(', ')}${t.measures.length > 8 ? '...' : ''}`
      : '';
    return `- ${t.name}${measures}`;
  }).join('\n');

  try {
    const response = await client.messages.create({
      model: MODELS.fast,
      max_tokens: 300,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Pregunta del usuario: "${query}"

Lista de tablas disponibles en el modelo de datos:
${indexText}

Devolvé SOLO un array JSON con los nombres de las tablas más relevantes para responder esta pregunta. Máximo 10 tablas. Solo el array, sin explicación.
Ejemplo: ["Tabla1", "Tabla2", "Tabla3"]`,
      }],
    });

    const text = response.content[0]?.text?.trim() || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return schemaIndex.slice(0, 10).map(t => t.name);
    const names = JSON.parse(match[0]);
    logger.debug('Schema filter', { query: query.slice(0, 60), selected: names });
    return names;
  } catch (e) {
    logger.warn('Schema filter failed, using full schema', { error: e.message });
    return schemaIndex.map(t => t.name);
  }
}

// ─── MAIN INFERENCE (streaming SSE) ──────────────────────────────────────────

async function chat({ model, messages, systemPrompt, tenantId, res }) {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  // 1. Semantic cache
  const cachedResponse = model
    ? await semanticCache.get(tenantId, model.id, lastUserMessage)
    : null;

  if (cachedResponse) {
    if (cachedResponse.dashboards && cachedResponse.dashboards.length > 0) {
      if (cachedResponse.text) sendSSE(res, { type: 'token', text: cachedResponse.text });
      for (const dash of cachedResponse.dashboards) {
        sendSSE(res, { type: 'dashboard', data: dash });
      }
    } else {
      sendSSE(res, { type: 'token', text: cachedResponse.text });
    }
    endSSE(res, { inputTokens: 0, outputTokens: 0, totalTokens: 0, credits: 0, fromCache: true });
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, credits: 0, fromCache: true };
  }

  // 2. Classify
  const { model: selectedModel, maxTokens, tier } = classifyMessage(lastUserMessage);
  logger.debug('Model routing', { tier, selectedModel, maxTokens, tenantId });

  // 3. Schema
  if (model) sendSSE(res, { type: 'status', text: 'Conectando con el modelo de datos...' });
  let schema = await fetchSchema(model);
  if (model && schema.length > 15) {
    const schemaIndex = await pbiService.getSchemaIndex(model);
    const relevantNames = await filterSchemaByQuery(lastUserMessage, schemaIndex);
    schema = schema.filter(t => relevantNames.includes(t.name));
    logger.debug('Schema filtered', { 
      original: schemaIndex.length, 
      filtered: schema.length,
      tables: schema.map(t => t.name)
    });
  }
  const sysPrompt = buildSystemPrompt(model, schema, systemPrompt);
  const activeTools = model ? tools : [];

  let totalInputTokens  = 0;
  let totalOutputTokens = 0;
  let fullAssistantText = '';
  let collectedDashboards = []; // ← agregar esta línea

  const anthropicMessages = messages.map(m => ({
    role:    m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
  }));

  // sonnet-4-6 no soporta prefill
  while (anthropicMessages.length > 1 && anthropicMessages[anthropicMessages.length - 1].role === 'assistant') {
    anthropicMessages.pop();
  }
  if (anthropicMessages.length === 0 || anthropicMessages[anthropicMessages.length - 1].role !== 'user') {
    anthropicMessages.push({ role: 'user', content: lastUserMessage });
  }

  const MAX_ITERATIONS = 10;
  let iteration = 0;

  if (anthropicMessages.length > 20) {
  anthropicMessages.splice(1, anthropicMessages.length - 20);
  }
  
  console.log('SYSTEM PROMPT LENGTH:', sysPrompt.length);
  console.log('SYSTEM PROMPT PREVIEW:', sysPrompt.slice(0, 200));
  console.log('ACTIVE TOOLS:', activeTools.length);
  console.log('SCHEMA TABLES:', schema.length);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const streamParams = {
      model:       selectedModel,
      max_tokens:  maxTokens,
      temperature: 0,
      system:      [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
      messages:    anthropicMessages,
    };

    if (activeTools.length > 0) {
      streamParams.tools      = activeTools;
      streamParams.tool_choice = { type: 'auto' };
    }

    sendSSE(res, { type: 'status', text: iteration === 1 ? 'Analizando tu consulta...' : 'Consultando más datos...' });
    const stream = await client.messages.stream(streamParams);

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullAssistantText += event.delta.text;
        sendSSE(res, { type: 'token', text: event.delta.text });
      }
    }

    const finalMessage = await stream.finalMessage();
    totalInputTokens  += finalMessage.usage.input_tokens;
    totalOutputTokens += finalMessage.usage.output_tokens;

    if (finalMessage.usage.cache_read_input_tokens) {
      logger.debug('Prompt cache hit', { savedTokens: finalMessage.usage.cache_read_input_tokens, tenantId });
    }

    const toolUseBlocks = finalMessage.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    sendSSE(res, { type: 'status', text: 'Consultando Power BI: ' + toolUseBlocks.map(t => t.input.description).join(' · ') });

    anthropicMessages.push({ role: 'assistant', content: finalMessage.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async toolUse => {
        const result = await executeTool(toolUse, model);
        sendSSE(res, { type: 'tool_result', tool: toolUse.name, preview: result.preview });
        const resultStr = JSON.stringify(result.data);
        const truncated = resultStr.length > 50000 ? resultStr.slice(0, 50000) + '...[truncado]' : resultStr;
        return { type: 'tool_result', tool_use_id: toolUse.id, content: truncated };
      })
    );

    anthropicMessages.push({ role: 'user', content: toolResults });
  }

  // ── Detectar y emitir TODOS los dashboards FUERA del loop ───────────────────
  if (fullAssistantText.includes('<<<DASHBOARD_START>>>')) {
    const dashRegex = /<<<DASHBOARD_START>>>([\s\S]*?)<<<DASHBOARD_END>>>/g;
    let dashMatch;
    while ((dashMatch = dashRegex.exec(fullAssistantText)) !== null) {
      try {
        const dashData = JSON.parse(dashMatch[1].trim());
        collectedDashboards.push(dashData); // ← guardar
        sendSSE(res, { type: 'dashboard', data: dashData });
      } catch (e) {
        logger.warn('Dashboard JSON parse failed', { error: e.message });
      }
    }
    fullAssistantText = fullAssistantText
      .replace(/<<<DASHBOARD_START>>>[\s\S]*?<<<DASHBOARD_END>>>/g, '')
      .trim();
  }

  const totalTokens = totalInputTokens + totalOutputTokens;
  const credits     = Math.ceil(totalTokens / creditsConfig.tokensPerCredit);

  if (model && fullAssistantText && totalTokens > 0) {
    await semanticCache.set(tenantId, model.id, lastUserMessage, { 
      text: fullAssistantText,
      dashboards: collectedDashboards
    });
  }

  return { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, credits, fromCache: false };
}

// ─── NON-STREAMING ────────────────────────────────────────────────────────────

async function analyzeFile({ model, fileContent, fileName, userQuestion, systemPrompt }) {
  const schema    = await fetchSchema(model);
  const sysPrompt = buildSystemPrompt(model, schema, systemPrompt);
  const { model: selectedModel, maxTokens } = classifyMessage(userQuestion);

  const requestParams = {
    model:      selectedModel,
    max_tokens: maxTokens,
    system:     [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
    messages:   [{ role: 'user', content: 'File: "' + fileName + '"\n\n' + fileContent + '\n\nQuestion: ' + userQuestion }],
  };
  if (model) requestParams.tools = tools;

  const response    = await client.messages.create(requestParams);
  const text        = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const totalTokens = response.usage.input_tokens + response.usage.output_tokens;
  const credits     = Math.ceil(totalTokens / creditsConfig.tokensPerCredit);
  return { text, credits, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

async function infer({ model, messages, systemPrompt, maxTokens = 4096 }) {
  const schema    = await fetchSchema(model);
  const sysPrompt = buildSystemPrompt(model, schema, systemPrompt);

  const requestParams = {
    model:      MODELS.smart,
    max_tokens: maxTokens,
    system:     [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
    messages:   messages.map(m => ({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content })),
  };
  if (model) requestParams.tools = tools;

  const response    = await client.messages.create(requestParams);
  const text        = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const totalTokens = response.usage.input_tokens + response.usage.output_tokens;
  const credits     = Math.ceil(totalTokens / creditsConfig.tokensPerCredit);
  return { text, credits, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────

async function executeTool(toolUse, model) {
  if (toolUse.name === 'run_dax_query') {
    if (!model) return { data: { error: 'No PBI model connected' }, preview: 'No model available' };
    try {
      const rows = await pbiService.runDaxQuery(model, toolUse.input.dax);
      return { data: rows, preview: rows.length + ' rows returned' };
    } catch (err) {
      logger.error('DAX execution error', { error: err.message });
      return { data: { error: err.message }, preview: 'Query failed' };
    }
  }
  return { data: { error: 'Unknown tool' }, preview: 'Unknown tool' };
}

// ─── SSE HELPERS ─────────────────────────────────────────────────────────────

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sendSSE(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function endSSE(res, payload) {
  res.write('data: ' + JSON.stringify({ type: 'done', ...payload }) + '\n\n');
  res.end();
}

module.exports = { chat, analyzeFile, infer, startSSE, endSSE, sendSSE };