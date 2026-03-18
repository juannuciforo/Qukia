const Anthropic = require('@anthropic-ai/sdk');
const { anthropic: anthropicConfig } = require('../config/env');

const client = new Anthropic({ apiKey: anthropicConfig.apiKey });

/**
 * Genera un título corto y descriptivo para una conversación.
 * Usa Haiku para minimizar costo (~0.001 créditos por título).
 * Nunca bloquea — si falla, devuelve el fallback.
 *
 * @param {string} userMessage  — primer mensaje del usuario
 * @param {string[]} fileNames  — nombres de archivos adjuntos (opcional)
 * @returns {Promise<string>}   — título de 4-7 palabras
 */
async function generateTitle(userMessage, fileNames = []) {
  const filesCtx = fileNames.length
    ? `Archivos adjuntos: ${fileNames.join(', ')}\n`
    : '';

  const prompt =
    `${filesCtx}Mensaje: ${userMessage.slice(0, 300)}\n\n` +
    `Generá un título corto (4-7 palabras, sin comillas, sin punto final) ` +
    `que describa de qué trata esta consulta. Solo el título, nada más.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 40,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw = response.content?.[0]?.text?.trim() || '';
    // Limpiar posibles comillas o puntos que igual meta el modelo
    return raw.replace(/^["'«»]|["'«».]$/g, '').trim() || fallbackTitle(userMessage, fileNames);
  } catch (_) {
    return fallbackTitle(userMessage, fileNames);
  }
}

function fallbackTitle(message, fileNames) {
  if (fileNames.length) return `📎 ${fileNames[0].slice(0, 40)}`;
  return message.slice(0, 60);
}

module.exports = { generateTitle };