const config = require('./config');

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
    console.log(`[DEV OTP] ${phone}: ${code}`);
    return { mode: 'dev' };
  }

  // 3. If neither Telegram nor dev mode is available, throw an error
  throw new Error('Unable to send login code: no valid delivery method configured');
}

async function sendTelegramMessage(phone, message) {
  const { botToken } = config.telegram;
  const chatId = await findChatIdByPhone(phone);
  if (!chatId) throw new Error(`User ${phone} not found. Send /start +79991234567 to the bot first.`);

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
        const response = JSON.parse(body);
        if (response.ok) resolve(response);
        else reject(new Error(response.description || 'Telegram API error'));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const phoneToChatId = new Map();
function registerTelegramUser(phone, chatId) { phoneToChatId.set(phone, String(chatId)); }
function findChatIdByPhone(phone) {
  const normalized = phone.replace(/^\+/, '');
  return phoneToChatId.get(normalized) || null;
}
module.exports = { sendLoginCode, registerTelegramUser, findChatIdByPhone };
