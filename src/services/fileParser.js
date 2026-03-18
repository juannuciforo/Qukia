const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const ExcelJS  = require('exceljs');
const { parse: csvParse } = require('csv-parse/sync');
const pdfParse = require('pdf-parse');
const { upload: uploadConfig } = require('../config/env');

fs.mkdirSync(uploadConfig.dir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadConfig.dir),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + file.originalname.replace(/\s/g, '_');
    cb(null, safe);
  },
});

const ALLOWED_MIMES = new Set([
  // CSV / TSV
  'text/csv',
  'text/tab-separated-values',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PDF
  'application/pdf',
  // Texto plano / JSON / Markdown
  'text/plain',
  'application/json',
  'text/markdown',
  // Parquet (los browsers suelen mandar octet-stream)
  'application/octet-stream',
  'application/x-parquet',
  // ODS (LibreOffice Calc)
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const ALLOWED_EXTS = new Set([
  '.csv', '.tsv',
  '.xlsx', '.xls', '.ods',
  '.pdf',
  '.txt', '.md', '.json',
  '.parquet',
]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIMES.has(file.mimetype) || ALLOWED_EXTS.has(ext)) return cb(null, true);
  cb(new Error('Unsupported file type: ' + file.mimetype + ' (' + ext + ')'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: uploadConfig.maxSizeMb * 1024 * 1024 },
});

// ─── PARSERS ──────────────────────────────────────────────────────────────────

function detectDelimiter(sample) {
  // Contar ocurrencias de cada candidato en las primeras líneas
  const candidates = [',', ';', '\t', '|'];
  const lines = sample.split('\n').slice(0, 5).join('\n');
  let best = ',', bestCount = 0;
  for (const d of candidates) {
    const count = (lines.match(new RegExp('\\' + (d === '\t' ? 't' : d === '|' ? '|' : d), 'g')) || []).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

async function parseCSV(filePath, delimiter, maxRows) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Si no se fuerza un delimitador, autodetectar
  const sep = delimiter || detectDelimiter(content.slice(0, 2000));

  let records;
  try {
    records = csvParse(content, {
      columns:            true,
      skip_empty_lines:   true,
      bom:                true,
      delimiter:          sep,
      relax_column_count: true,
      trim:               true,
    });
  } catch(e) {
    // Si falla con el delimitador detectado, intentar con los otros
    const fallbacks = [',', ';', '\t', '|'].filter(d => d !== sep);
    for (const fb of fallbacks) {
      try {
        records = csvParse(content, {
          columns: true, skip_empty_lines: true, bom: true,
          delimiter: fb, relax_column_count: true, trim: true,
        });
        if (records.length > 0) break;
      } catch(_) {}
    }
    if (!records) throw new Error('No se pudo parsear el CSV con ningún delimitador conocido');
  }

  const limited = records.slice(0, maxRows);
  if (!limited.length) return '(empty file)';
  const headers = Object.keys(limited[0]);
  const rows    = limited.map(r => headers.map(h => r[h] ?? '').join('\t'));
  return [
    `Delimiter: "${sep}" · Rows: ${records.length} (showing first ${limited.length})`,
    headers.join('\t'),
    ...rows,
  ].join('\n');
}

async function parseTSV(filePath, maxRows) {
  return parseCSV(filePath, '\t', maxRows);
}

async function parseExcel(filePath, maxRows) {
  const workbook = new ExcelJS.Workbook();
  const ext      = path.extname(filePath).toLowerCase();
  if (ext === '.ods') await workbook.ods.readFile(filePath);
  else                await workbook.xlsx.readFile(filePath);

  const result = [];
  workbook.eachSheet((sheet, id) => {
    if (id > 5) return; // max 5 hojas
    result.push(`\n=== Sheet: ${sheet.name} ===`);
    let count = 0;
    sheet.eachRow(row => {
      if (count++ > maxRows) return;
      const vals = row.values.slice(1).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && v.result !== undefined) return v.result; // fórmulas
        if (typeof v === 'object' && v.text)    return v.text;                // rich text
        return String(v);
      });
      result.push(vals.join('\t'));
    });
    result.push(`(${Math.min(count, maxRows)} of ${sheet.rowCount} rows shown)`);
  });
  return result.join('\n');
}

async function parsePDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data   = await pdfParse(buffer);
  return [
    `Pages: ${data.numpages}`,
    data.text.slice(0, 50000),
  ].join('\n');
}

async function parseJSON(filePath) {
  const raw  = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw.slice(0, 50000); }

  // Si es array de objetos, mostrar como tabla
  if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object') {
    const limited = parsed.slice(0, 500);
    const headers = Object.keys(limited[0]);
    const rows    = limited.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join('\t'));
    return [`Rows: ${parsed.length} (showing first ${limited.length})`, headers.join('\t'), ...rows].join('\n');
  }
  return JSON.stringify(parsed, null, 2).slice(0, 50000);
}

async function parseParquet(filePath) {
  try {
    // Lazy require para no romper si no está instalado
    const parquet = require('@dsnp/parquetjs');
    const reader  = await parquet.ParquetReader.openFile(filePath);
    const cursor  = reader.getCursor();
    const schema  = reader.schema;
    const fields  = Object.keys(schema.fields);
    const rows    = [];
    let   record;
    while ((record = await cursor.next()) && rows.length < 500) {
      rows.push(record);
    }
    await reader.close();
    const lines = rows.map(r => fields.map(f => JSON.stringify(r[f] ?? '')).join('\t'));
    return [
      `Parquet — Fields: ${fields.join(', ')}`,
      `Rows shown: ${rows.length}`,
      fields.join('\t'),
      ...lines,
    ].join('\n');
  } catch (err) {
    return `[Parquet parse error: ${err.message}]`;
  }
}

// ─── DISPATCHER ───────────────────────────────────────────────────────────────

async function parseFile(filePath, mimeType, maxRows) {
  maxRows   = maxRows || 500;
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv' || mimeType === 'text/csv')                    return parseCSV(filePath, ',', maxRows);
  if (ext === '.tsv' || mimeType === 'text/tab-separated-values')   return parseTSV(filePath, maxRows);
  if (['.xlsx','.xls','.ods'].includes(ext))                        return parseExcel(filePath, maxRows);
  if (ext === '.pdf'  || mimeType === 'application/pdf')            return parsePDF(filePath);
  if (ext === '.json' || mimeType === 'application/json')           return parseJSON(filePath);
  if (ext === '.parquet')                                            return parseParquet(filePath);
  if (['.txt','.md'].includes(ext) || mimeType === 'text/plain')    return fs.readFileSync(filePath, 'utf8').slice(0, 50000);

  return '[Binary file — content not extractable as text]';
}

module.exports = { upload, parseFile };