const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

// В production требуем нормальной длины ключа
if (IS_PRODUCTION && JWT_SECRET.length < 32) {
  throw new Error(
    '[config] JWT_SECRET is too short (got ' + JWT_SECRET.length + ' chars, need >=32). ' +
    'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

function resolveDatabaseUrl() {
  let url;
  if (process.env.DATABASE_URL) {
    url = process.env.DATABASE_URL;
  } else {
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || '5432';
    const name = process.env.DB_NAME || 'messenger';
    const user = process.env.DB_USER || 'messenger';
    const password = requireInProduction(
      'DB_PASSWORD (or DATABASE_URL)',
      process.env.DB_PASSWORD,
      { forbiddenDefault: 'messenger' }
    ) || 'messenger';
    url = `postgresql://${user}:${password}@${host}:${port}/${name}`;
  }

  // Нормализуем sslmode: pg@8.x ругается, что 'require'/'prefer'/'verify-ca'
  // сейчас работают как 'verify-full', а в pg@9 поведение поменяется на
  // libpq-совместимое (без проверки цепочки = слабее). Явно фиксируем
  // verify-full, чтобы:
  //   1) убрать SECURITY WARNING из логов;
  //   2) после апгрейда драйвера поведение не деградировало.
  // Если в URL уже стоит явный 'verify-full' или 'disable' — ничего не делаем.
  try {
    const u = new URL(url);
    const sslmode = u.searchParams.get('sslmode');
    if (sslmode && /^(require|prefer|verify-ca)$/i.test(sslmode)) {
      u.searchParams.set('sslmode', 'verify-full');
      url = u.toString();
    }
  } catch (_) {
    // Невалидный URL — отдадим как есть; pg сам ругнётся понятнее.
  }
  return url;
}

// Список разрешённых origin'ов: основной APP_URL + опциональный APP_URLS
// (через запятую) — удобно для preview-деплоев Render и кастомных доменов.
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const APP_URLS = String(process.env.APP_URLS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const ALL_APP_URLS = Array.from(new Set([APP_URL.replace(/\/+$/, ''), ...APP_URLS]));

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  appUrl: APP_URL,
  appUrls: ALL_APP_URLS,
  jwtSecret: JWT_SECRET,
  allowDevCodeResponse: IS_PRODUCTION
    ? false
    : String(process.env.ALLOW_DEV_CODE_RESPONSE || 'false') === 'true',
  databaseUrl: resolveDatabaseUrl(),
  uploadsDir: path.join(__dirname, '..', 'uploads'),
  supportPhone: process.env.SUPPORT_PHONE || '',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || ''
  },
  storage: {
    mode: process.env.STORAGE_MODE || 'local', // local | s3 | b2
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
  },
  // --- Web Push (VAPID) ---
  // Если ключи не заданы — push отключается, но приложение работает как раньше.
  // Сгенерировать пару ключей можно командой:
  //   node -e "console.log(require('web-push').generateVAPIDKeys())"
  // Затем положить значения в Render Environment как VAPID_PUBLIC_KEY и
  // VAPID_PRIVATE_KEY.
  // VAPID_SUBJECT — обязательный mailto: или URL, RFC 8292. Используется
  // браузерным push-сервисом, чтобы при проблемах с твоими push можно было
  // тебя контактировать. Если не задан — берём APP_URL.
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || `mailto:admin@${(() => {
      try { return new URL(APP_URL).hostname; } catch { return 'example.com'; }
    })()}`
  }
};
