const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// --- Жёсткая валидация критичных секретов в production ---
function requireInProduction(name, value, options = {}) {
  if (!IS_PRODUCTION) return value;
  if (value && value !== options.forbiddenDefault) return value;
  throw new Error(
    `[config] Environment variable ${name} must be set in production` +
    (options.forbiddenDefault ? ` (current value is the insecure default)` : '')
  );
}

const JWT_SECRET = requireInProduction(
  'JWT_SECRET',
  process.env.JWT_SECRET,
  { forbiddenDefault: 'change_me_super_secret' }
) || `dev-only-${crypto.randomBytes(24).toString('hex')}`;

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const name = process.env.DB_NAME || 'messenger';
  const user = process.env.DB_USER || 'messenger';
  const password = requireInProduction(
    'DB_PASSWORD (or DATABASE_URL)',
    process.env.DB_PASSWORD,
    { forbiddenDefault: 'messenger' }
  ) || 'messenger';
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  jwtSecret: JWT_SECRET,
  allowDevCodeResponse: String(process.env.ALLOW_DEV_CODE_RESPONSE || 'false') === 'true',
  databaseUrl: resolveDatabaseUrl(),
  uploadsDir: path.join(process.cwd(), 'uploads'),
  supportPhone: process.env.SUPPORT_PHONE || '',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || ''
  },
  storage: {
    mode: process.env.STORAGE_MODE || 'local',
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
  }
};
