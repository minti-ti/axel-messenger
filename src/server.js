const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');
const crypto = require('crypto');
const config = require('./config');
const { initDb, query } = require('./db');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const chatRoutes = require('./routes/chats');
const publicRoutes = require('./routes/public');
const { attachSocket } = require('./socket');
const { formatMessage, listChats } = require('./chatService');
const { streamStoredFile, isS3 } = require('./storage');
const { handleTelegramWebhook, setupWebhook } = require('./telegramBot');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 25 * 1024 * 1024
});

app.set('io', io);
attachSocket(io);

if (config.nodeEnv === 'production') {
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
} else {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
}
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware для безопасности запросов
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// CSRF токен для UI
app.get('/api/csrf-token', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  req.session = req.session || {};
  req.session.csrfToken = token;
  res.json({ csrfToken: token });
});

function sendPublicAsset(res, filename, type) {
  res.type(type);
  if (config.nodeEnv !== 'production') res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(process.cwd(), 'public', filename));
}

app.get('/styles.css', (_, res) => sendPublicAsset(res, 'styles.css', 'text/css'));
app.get('/app.js', (_, res) => sendPublicAsset(res, 'app.js', 'application/javascript'));
app.get('/public-profile.js', (_, res) => sendPublicAsset(res, 'public-profile.js', 'application/javascript'));
app.get('/public-chat.js', (_, res) => sendPublicAsset(res, 'public-chat.js', 'application/javascript'));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
  setHeaders: (res) => {
    if (config.nodeEnv !== 'production') res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (config.nodeEnv !== 'production') res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get('/files/*', async (req, res) => {
  try {
    const key = decodeURIComponent(String(req.params[0] || ''));
    await streamStoredFile(key, res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отдать файл' });
  }
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  skip: (req) => req.path === '/api/health'
});

const sensitiveOpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много операций. Подождите минуту.' }
});

const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много сообщений. Подождите.' }
});

app.get('/api/health', (_, res) => {
  res.json({ ok: true, env: config.nodeEnv, now: new Date().toISOString() });
});

app.use('/api/public', publicRoutes);
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', apiLimiter, userRoutes);

// Применяем rate limiting для критических операций в чатах
app.use('/api/chats', apiLimiter);
app.post('/api/chats/:chatId/messages', messageLimiter, chatRoutes);
app.use('/api/chats', chatRoutes);

// Telegram webhook
app.post('/telegram/webhook', handleTelegramWebhook);

app.get('/profile/:username', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'public-profile.html'));
});
app.get(['/c/:username', '/g/:username'], (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'public-chat.html'));
});

app.get('*', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

async function emitChatRefresh(chatId) {
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  for (const row of members.rows) {
    io.to(`user:${row.user_id}`).emit('chats:update', await listChats(row.user_id));
  }
}

async function processScheduledMessages() {
  const due = await query(
    `SELECT * FROM scheduled_messages
     WHERE sent_at IS NULL AND scheduled_for <= NOW()
     ORDER BY scheduled_for ASC
     LIMIT 20`
  );
  for (const item of due.rows) {
    const messageId = item.id;
    await query(
      `INSERT INTO messages (id, chat_id, user_id, content, message_type, reply_to_message_id, attachment_url, attachment_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [messageId, item.chat_id, item.user_id, item.content, item.attachment_url ? 'file' : 'text', item.reply_to_message_id, item.attachment_url, item.attachment_name]
    );
    await query('UPDATE scheduled_messages SET sent_at = NOW() WHERE id = $1', [item.id]);
    const formatted = await formatMessage(messageId);
    io.to(item.chat_id).emit('message:new', formatted);
    await emitChatRefresh(item.chat_id);
  }
}

(async () => {
  try {
    await initDb();
    setupWebhook();
    setInterval(() => { processScheduledMessages().catch((error) => console.error('Scheduled dispatch error', error)); }, 5000);
    server.listen(config.port, () => {
      console.log(`Messenger started on http://localhost:${config.port}`);
    });
  } catch (error) {
    console.error('Failed to start application', error);
    process.exit(1);
  }
})();
