require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ANTHROPIC_API_KEY',
  'PORT',
];

const OPTIONAL = [
  'NODE_ENV',
  'UPLOAD_DIR',
  'MAX_FILE_SIZE',
  'CORS_ORIGIN',
];

console.log('\nVARIABLES DE ENTORNO\n');
console.log('ESTADO   VARIABLE');
console.log('-'.repeat(60));

let missing = 0;

REQUIRED.forEach(key => {
  const val = process.env[key];
  if (!val) {
    console.log('[FALTA]  ' + key);
    missing++;
  } else {
    const isSecret = key.toLowerCase().includes('secret') || key.toLowerCase().includes('key');
    const preview  = isSecret
      ? val.slice(0, 8) + '...'
      : val.length > 40 ? val.slice(0, 40) + '...' : val;
    console.log('[ok]     ' + key.padEnd(26) + ' ' + preview);
  }
});

console.log('\nOPCIONALES:');
OPTIONAL.forEach(key => {
  const val = process.env[key];
  console.log('[' + (val ? 'ok' : '--') + ']     ' + key.padEnd(26) + ' ' + (val || '(no definida)'));
});

if (missing > 0) {
  console.log('\n' + missing + ' variable(s) requerida(s) faltante(s). Revisa tu .env\n');
  process.exit(1);
} else {
  console.log('\nTodo OK.\n');
}