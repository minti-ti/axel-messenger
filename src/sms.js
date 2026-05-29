const config = require('./config');
const { query } = require('./db');

async function sendLoginCode(phone, code) {
  // 1. Try to send via Telegram if a bot token is configured and not placeholder
  const hasToken = config.telegram?.botToken && config.telegram?.botToken !== 'your_bot_token_here';
  if (hasToken) {
    try {
      const message = `🔐 Ваш код для входа в Arena Messenger:\n\n<pre>${code}</pre>\n\nНикому не сообщайте этот код!`;
      await sendTelegramMessage(phone, message);
      return { mode: 'telegram' };
    } catch (error) {
      console.error('[Telegram Bot] Send failed:', error.message);
      // fall through to dev mode if allowed
    }
  }

  // 2. Dev mode – only if explicitly allowed via env var
  if (config.allowDevCodeResponse) {
    // Не логируем сам код в продовых логах. allowDevCodeResponse=true должен быть
    // выставлен только в dev/staging, и только там реально появится в консоли.
    if (!config.isProduction) {
      console.log(`[DEV OTP] ${phone}: ${code}`);
    }
    return { mode: 'dev' };
  }

  // 3. If neither Telegram nor dev mode is available, throw an error
  throw new Error('Unable to send login code: no valid delivery method configured');
}

async function sendTelegramMessage(phone, message) {
  const { botToken } = config.telegram;
  const chatId = await findChatIdByPhone(phone);
  if (!chatId) throw new Error(`User not found. Send /start to the bot first.`);

  const https = require('https');
  const data = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.ok) resolve(response);
          else reject(new Error(response.description || 'Telegram API error'));
        } catch (e) {
          reject(new Error('Invalid Telegram response'));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function normalizePhoneForLookup(phone) {
  return String(phone || '').replace(/^\+/, '').replace(/\D/g, '');
}

async function registerTelegramUser(phone, chatId) {
  const normalized = normalizePhoneForLookup(phone);
  if (!normalized || !chatId) return;
  await query(
    `INSERT INTO telegram_bindings (phone, telegram_chat_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = NOW()`,
    [normalized, String(chatId)]
  );
}

async function findChatIdByPhone(phone) {
  const normalized = normalizePhoneForLookup(phone);
  if (!normalized) return null;
  const result = await query(
    'SELECT telegram_chat_id FROM telegram_bindings WHERE phone = $1 LIMIT 1',
    [normalized]
  );
  return result.rows[0]?.telegram_chat_id || null;
}

module.exports = { sendLoginCode, registerTelegramUser, findChatIdByPhone };
