const https = require('https');
const config = require('./config');
const { registerTelegramUser } = require('./sms');

const botStates = new Map();

function handleTelegramWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const update = req.body;
  const message = update.message || update.contact;
  
  if (!message) return res.json({ ok: true });
  
  const chatId = message.chat?.id;
  if (!chatId) return res.json({ ok: true });

  if (message.contact) {
    const phone = message.contact.phone_number;
    if (phone) {
      registerTelegramUser(phone, chatId);
      sendMessage(chatId, `✅ Номер **${phone}** привязан! Теперь коды будут приходить сюда.`);
      botStates.delete(chatId);
    }
    return res.json({ ok: true });
  }

  const text = message.text || '';

  if (text.startsWith('/start')) {
    botStates.set(chatId, 'awaiting_contact');
    sendContactRequest(chatId);
  } else if (text.startsWith('/help')) {
    sendMessage(chatId, '🤖 **Arena Messenger Bot**\n\n🔗 Привязка номера телефона\nОтправь `/start` чтобы привязать номер через встроенную кнопку.');
  } else if (text.startsWith('/cancel')) {
    botStates.delete(chatId);
    sendMessage(chatId, '❌ Операция отменена.');
  } else {
    sendMessage(chatId, '👋 Привет! Отправь `/start` чтобы привязать номер телефона.');
  }
  res.json({ ok: true });
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
  req.on('error', (error) => console.error('[Telegram Bot] Error:', error));
  req.write(data);
  req.end();
}

function sendMessage(chatId, text) {
  const { botToken } = config.telegram;
  if (!botToken) return;
  
  const data = JSON.stringify({
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
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
  req.on('error', (error) => console.error('[Telegram Bot] Error:', error));
  req.write(data);
  req.end();
}

function setupWebhook() {
  const { botToken } = config.telegram;
  if (!botToken || botToken === 'your_bot_token_here') return;
  
  const webhookUrl = `${config.appUrl.replace(/\/+$/, '')}/telegram/webhook`;
  console.log(`[Telegram Bot] Setting webhook to: ${webhookUrl}`);
  
  const data = JSON.stringify({
    url: webhookUrl,
    allowed_updates: ['message', 'contact']
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/setWebhook`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });
  req.on('error', (error) => console.error('[Telegram Bot] Webhook setup error:', error));
  req.write(data);
  req.end();
}

module.exports = { handleTelegramWebhook, setupWebhook };
