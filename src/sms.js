const config = require('./config');
const { query } = require('./db');

/**
 * Отправляет код входа. Возвращает один из вариантов:
 *   { mode: 'telegram' }         — код успешно отправлен в Telegram
 *   { mode: 'dev' }              — dev-режим (код только в логах); работает
 *                                  только если allowDevCodeResponse=true и не production
 *
 * Кидает ошибку с .code:
 *   error.code = 'NO_DELIVERY'   — бот не настроен на сервере вообще
 *   error.code = 'NEEDS_BINDING' — бот настроен, но у этого номера нет привязки
 *                                  (пользователь должен сначала открыть бота и нажать /start)
 *   error.code = 'TELEGRAM_FAIL' — сам бот ответил ошибкой (редко)
 */
async function sendLoginCode(phone, code) {
  const hasToken = config.telegram?.botToken && config.telegram.botToken !== 'your_bot_token_here';

  if (hasToken) {
    // Проверяем, есть ли у этого номера привязка к Telegram
    const chatId = await findChatIdByPhone(phone);
    if (!chatId) {
      // Если разрешён dev-режим — используем его как fallback (для разработки)
      if (config.allowDevCodeResponse && !config.isProduction) {
        console.log(`[DEV OTP] ${phone}: ${code} (no telegram binding)`);
        return { mode: 'dev' };
      }
      // В production — честная ошибка с инструкцией
      const err = new Error('Сначала откройте Telegram-бота и привяжите номер');
      err.code = 'NEEDS_BINDING';
      err.statusCode = 400;
      throw err;
    }

    // Привязка есть — пытаемся отправить
    try {
      const message = `🔐 Ваш код для входа в Axel Messenger:\n\n<pre>${code}</pre>\n\nНикому не сообщайте этот код!`;
      await sendTelegramMessage(chatId, message);
      return { mode: 'telegram' };
    } catch (error) {
      console.error('[Telegram Bot] Send failed:', error.message);
      // В dev можно упасть в dev-режим, в production — честная ошибка
      if (config.allowDevCodeResponse && !config.isProduction) {
        console.log(`[DEV OTP fallback] ${phone}: ${code}`);
        return { mode: 'dev' };
      }
      const err = new Error('Не удалось отправить код через Telegram. Попробуйте позже.');
      err.code = 'TELEGRAM_FAIL';
      err.statusCode = 502;
      throw err;
    }
  }

  // Бот вообще не настроен на сервере
  if (config.allowDevCodeResponse && !config.isProduction) {
    console.log(`[DEV OTP] ${phone}: ${code}`);
    return { mode: 'dev' };
  }

  const err = new Error('Сервис отправки кодов временно недоступен');
  err.code = 'NO_DELIVERY';
  err.statusCode = 503;
  throw err;
}

async function sendTelegramMessage(chatId, message) {
  const { botToken } = config.telegram;
  if (!chatId) throw new Error('No chat id');

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
