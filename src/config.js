const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const name = process.env.DB_NAME || 'messenger';
  const user = process.env.DB_USER || 'messenger';
  const password = process.env.DB_PASSWORD || 'messenger';
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'change_me_super_secret',
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
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || ''
  }
};
