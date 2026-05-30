const https = require('https');
const crypto = require('crypto');
const config = require('./config');
const { registerTelegramUser } = require('./sms');

const botStates = new Map();

// Секрет для проверки подлинности webhook. Если задан TELEGRAM_WEBHOOK_SECRET —
// используем его, иначе детерминированно деривируем из JWT_SECRET, чтобы
// значение не менялось между перезапусками одного и того же деплоя.
function getWebhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    return String(process.env.TELEGRAM_WEBHOOK_SECRET);
  }
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update('telegram-webhook-secret-v1')
    .digest('hex')
    .slice(0, 48); // 48 hex chars, безопасно по требованиям Telegram (1..256, A-Za-z0-9_-)
}

// Telegram присылает заголовок X-Telegram-Bot-Api-Secret-Token со значением,
// которое мы передали при setWebhook. Если он не совпадает — запрос
// поддельный (любой внешний актор мог постнуть JSON на /telegram/webhook).
function isAuthenticTelegramRequest(req) {
  const expected = getWebhookSecret();
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (!got || typeof got !== 'string') return false;
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Экранирование HTML-спецсимволов — нужно для parse_mode=HTML, иначе
// произвольный текст пользователя может ломать разметку или
// приводить к 400 Bad Request от Telegram.
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleTelegramWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // Защита от спуфинга: без валидного секрета — никаких действий.
  // Иначе любой может постнуть {"message": {"contact": {"phone_number": ...}}}
  // и привязать чужой Telegram chat_id к телефону жертвы, перехватив коды входа.
  if (!isAuthenticTelegramRequest(req)) {
    if (!config.isProduction) {
      console.warn('[Telegram Bot] webhook rejected: invalid or missing secret token');
    }
    return res.status(401).json({ ok: false });
  }

  // Минимальное логирование без PII (телефонов / chat_id пользователей).
  if (!config.isProduction) {
    const update = req.body || {};
    const kind = update.message?.contact ? 'contact'
      : update.message?.text ? `text:${String(update.message.text).slice(0, 16)}`
      : 'other';
    console.log(`[Telegram Bot] webhook update kind=${kind}`);
  }

  const update = req.body;
  const message = update?.message || update?.contact;
  if (!message) return res.json({ ok: true });

  const chatId = message.chat?.id;
  if (!chatId) return res.json({ ok: true });

  try {
    if (message.contact) {
      // ВАЖНО: принимаем номер только если контакт принадлежит самому отправителю,
      // а не «перенаправлен» из чужой карточки. Это закрывает попытку привязать
      // чужой номер к своему chat_id (или наоборот).
      const senderId = message.from?.id;
      const contactUserId = message.contact.user_id;
      if (contactUserId && senderId && contactUserId !== senderId) {
        sendMessage(chatId, 'Можно привязать только свой собственный номер телефона.');
        return res.json({ ok: true });
      }

      const phone = message.contact.phone_number;
      if (phone) {
        await registerTelegramUser(phone, chatId);
        sendMessage(chatId, '✅ Номер привязан! Теперь коды будут приходить сюда.');
        botStates.delete(chatId);
      }
      return res.json({ ok: true });
    }

    const text = message.text || '';

    if (text.startsWith('/start')) {
      botStates.set(chatId, 'awaiting_contact');
      sendContactRequest(chatId);
    } else if (text.startsWith('/help')) {
      sendMessage(
        chatId,
        '🤖 <b>Axel Messenger Bot</b>\n\n🔗 Привязка номера телефона\nОтправь /start чтобы привязать номер через встроенную кнопку.'
      );
    } else if (text.startsWith('/cancel')) {
      botStates.delete(chatId);
      sendMessage(chatId, '❌ Операция отменена.');
    } else {
      sendMessage(chatId, '👋 Привет! Отправь /start чтобы привязать номер телефона.');
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[Telegram Bot] webhook handler error:', error.message);
    res.json({ ok: true });
  }
}

function sendContactRequest(chatId) {
  const { botToken } = config.telegram;
  if (!botToken) return;

  const data = JSON.stringify({
    chat_id: chatId,
    text: '📱 Нажми кнопку ниже, чтобы отправить свой номер телефона для привязки к аккаунту.',
    reply_markup: {
      keyboard: [
        [
          {
            text: '📱 Отправить номер',
            request_contact: true
          }
        ],
        [
          {
            text: '❌ Отмена',
            callback_data: 'cancel'
          }
        ]
      ],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });
  req.on('error', (error) => console.error('[Telegram Bot] Error:', error.message));
  req.write(data);
  req.end();
}

// Шлём всё через parse_mode=HTML с экранированием — это безопаснее, чем
// Markdown (одиночный _ или * в тексте пользователя ломает разметку и
// возвращает 400 от Telegram).
function sendMessage(chatId, htmlText) {
  const { botToken } = config.telegram;
  if (!botToken) return;

  const data = JSON.stringify({
    chat_id: chatId,
    text: String(htmlText || ''),
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true }
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });
  req.on('error', (error) => console.error('[Telegram Bot] Error:', error.message));
  req.write(data);
  req.end();
}

function setupWebhook() {
  const { botToken } = config.telegram;
  if (!botToken || botToken === 'your_bot_token_here') return;

  const webhookUrl = `${config.appUrl.replace(/\/+$/, '')}/telegram/webhook`;
  if (!config.isProduction) {
    console.log(`[Telegram Bot] Setting webhook to: ${webhookUrl}`);
  }

  const data = JSON.stringify({
    url: webhookUrl,
    allowed_updates: ['message', 'contact'],
    // Telegram будет присылать этот токен в заголовке
    // X-Telegram-Bot-Api-Secret-Token каждого вебхук-запроса.
    secret_token: getWebhookSecret()
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/setWebhook`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };

  const req = https.request(options, (resp) => {
    let body = '';
    resp.on('data', (chunk) => body += chunk);
    resp.on('end', () => {
      try {
        const result = JSON.parse(body);
        if (result.ok) {
          console.log('[Telegram Bot] Webhook set OK:', webhookUrl);
        } else {
          console.error('[Telegram Bot] Webhook set FAILED:', result.description || body);
        }
      } catch (_) {
        console.error('[Telegram Bot] Webhook response parse error:', body.slice(0, 200));
      }
    });
  });
  req.on('error', (error) => console.error('[Telegram Bot] Webhook setup error:', error.message));
  req.write(data);
  req.end();
}

module.exports = { handleTelegramWebhook, setupWebhook, escapeHtml, getWebhookSecret };
