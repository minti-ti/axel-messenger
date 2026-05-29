const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./config');
const { initDb, query } = require('./db');
const { authMiddleware } = require('./auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const chatRoutes = require('./routes/chats');
const publicRoutes = require('./routes/public');
const { attachSocket } = require('./socket');
const { formatMessage, listChats } = require('./chatService');
const { streamStoredFile, sanitizeStorageKey } = require('./storage');
const { handleTelegramWebhook, setupWebhook } = require('./telegramBot');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);

// CORS для Socket.IO. В production пускаем только наш фронтенд (config.appUrl),
// в dev — разрешаем localhost/любой origin для удобства.
const socketCorsOrigin = config.isProduction
  ? [config.appUrl]
  : true; // в dev — отражаем Origin запроса

const io = new Server(server, {
  cors: {
    origin: socketCorsOrigin,
    credentials: true
  },
  maxHttpBufferSize: 25 * 1024 * 1024
});

app.set('io', io);
attachSocket(io);

if (config.isProduction) {
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

// Дополнительные security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

function sendPublicAsset(res, filename, type) {
  res.type(type);
  if (!config.isProduction) res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(process.cwd(), 'public', filename));
}

app.get('/styles.css', (_, res) => sendPublicAsset(res, 'styles.css', 'text/css'));
app.get('/app.js', (_, res) => sendPublicAsset(res, 'app.js', 'application/javascript'));
app.get('/public-profile.js', (_, res) => sendPublicAsset(res, 'public-profile.js', 'application/javascript'));
app.get('/public-chat.js', (_, res) => sendPublicAsset(res, 'public-chat.js', 'application/javascript'));

// ---- Авторизованные раздачи файлов ----
// Раньше /uploads/* и /files/* были полностью публичны, что позволяло
// скачать любое вложение, зная имя файла. Теперь оба требуют:
//   1) валидный JWT (authMiddleware)
//   2) членство в чате, к которому привязано сообщение с этим вложением.

async function userCanAccessAttachment(userId, attachmentPath) {
  if (!userId || !attachmentPath) return false;

  // Аватары пользователей и чатов считаем публичным контентом (они и так видны в UI без авторизации),
  // но всё равно требуем валидную сессию через authMiddleware выше.
  if (attachmentPath.includes('avatar') || attachmentPath.includes('chat-avatars')) {
    return true;
  }

  // Ищем хотя бы одно сообщение, чьё attachment_url содержит наш путь, в чате где юзер — участник.
  const result = await query(
    `SELECT 1
     FROM messages m
     JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
     WHERE m.attachment_url LIKE $1
     LIMIT 1`,
    [`%${attachmentPath}%`, userId]
  );
  return Boolean(result.rows[0]);
}

const uploadsRouter = express.Router();
uploadsRouter.use(authMiddleware);
uploadsRouter.get('/:filename', async (req, res) => {
  try {
    const filename = sanitizeStorageKey(req.params.filename);
    const fullPath = `/uploads/${filename}`;
    const allowed = await userCanAccessAttachment(req.user.id, fullPath);
    if (!allowed) return res.status(403).json({ error: 'Доступ запрещён' });
    await streamStoredFile(filename, res);
  } catch (error) {
    if (error.message === 'Invalid key' || error.message === 'Empty key') {
      return res.status(400).json({ error: 'Некорректное имя файла' });
    }
    console.error('uploads error:', error.message);
    res.status(500).json({ error: 'Не удалось отдать файл' });
  }
});
app.use('/uploads', uploadsRouter);

const filesRouter = express.Router();
filesRouter.use(authMiddleware);
filesRouter.get('/*', async (req, res) => {
  try {
    const rawKey = decodeURIComponent(String(req.params[0] || ''));
    const fullPath = `/files/${rawKey}`;
    const allowed = await userCanAccessAttachment(req.user.id, fullPath);
    if (!allowed) return res.status(403).json({ error: 'Доступ запрещён' });
    await streamStoredFile(rawKey, res);
  } catch (error) {
    if (error.message === 'Invalid key' || error.message === 'Empty key') {
      return res.status(400).json({ error: 'Некорректное имя файла' });
    }
    console.error('files error:', error.message);
    res.status(500).json({ error: 'Не удалось отдать файл' });
  }
});
app.use('/files', filesRouter);

app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!config.isProduction) res.setHeader('Cache-Control', 'no-store');
  }
}));

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  skip: (req) => req.path === '/api/health'
});

const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много сообщений. Подождите.' }
});

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/api/health', (_, res) => {
  res.json({ ok: true, env: config.nodeEnv, now: new Date().toISOString() });
});

app.use('/api/public', publicRoutes);

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', apiLimiter, userRoutes);

// Rate limiting для критических операций в чатах
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
