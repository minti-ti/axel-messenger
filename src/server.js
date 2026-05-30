const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./config');
const { initDb, query, dbPing } = require('./db');
const { authMiddleware, fetchSession, fetchUserById } = require('./auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const chatRoutes = require('./routes/chats');
const publicRoutes = require('./routes/public');
const { attachSocket } = require('./socket');
const { formatMessage, listChats } = require('./chatService');
const { streamStoredFile, sanitizeStorageKey, buildFileUrlFromKey } = require('./storage');
const { handleTelegramWebhook, setupWebhook } = require('./telegramBot');
const { initPush, isPushReady } = require('./pushService');
const { pushNotifyOfflineMembers } = require('./routes/chats/_helpers');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);

// CORS для Socket.IO. В production пускаем только перечисленные домены
// (config.appUrls — основной APP_URL + список из APP_URLS через запятую,
// удобно для preview-деплоев Render и кастомных доменов).
// В dev — разрешаем любой origin для удобства локальной разработки.
const socketCorsOrigin = config.isProduction
  ? config.appUrls
  : true;

const io = new Server(server, {
  cors: {
    origin: socketCorsOrigin,
    credentials: true
  },
  maxHttpBufferSize: 1 * 1024 * 1024
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
        formAction: ["'self'"],
        // Нужно для регистрации /sw.js (Web Push Service Worker).
        // Без явного worker-src некоторые браузеры падают в script-src.
        workerSrc: ["'self'"]
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
// Простой JSON request logger. В production записывает метод, путь, статус и время.
// Не использует внешних зависимостей — замена для pino на текущем этапе.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (config.isProduction) {
      console.log(JSON.stringify({
        event: 'request',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
        ip: req.ip
      }));
    }
  });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Дополнительные security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProduction) {
    // 2 года + includeSubDomains + preload — рекомендованные значения
    // для регистрации на hstspreload.org.
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
});

function sendPublicAsset(res, filename, type) {
  res.type(type);
  if (!config.isProduction) res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, '..', 'public', filename));
}

app.get('/styles.css', (_, res) => sendPublicAsset(res, 'styles.css', 'text/css'));
// Старый алиас /app.js был привязан к монолитному public/app.js (которого
// уже нет в репо: исходник лежал в public/js/app.js). Теперь фронт разрезан
// на 4 файла public/js/0X-*.js, и каждый из них раздаётся express.static —
// отдельный alias не нужен.
app.get('/public-profile.js', (_, res) => sendPublicAsset(res, 'public-profile.js', 'application/javascript'));
app.get('/public-chat.js', (_, res) => sendPublicAsset(res, 'public-chat.js', 'application/javascript'));
// Service Worker для Web Push. Должен отдаваться из КОРНЯ ('/sw.js'),
// иначе его scope ограничится подпапкой, и pushSubscription из <main>-документа
// не сможет к нему привязаться. Также важен Service-Worker-Allowed=/ — но т.к.
// сам файл лежит в корне, scope наследуется автоматически.
// PWA Manifest
app.get("/manifest.json", (_, res) => {
  res.setHeader("Cache-Control", "no-cache");
  sendPublicAsset(res, "manifest.json", "application/manifest+json");
});
app.get('/sw.js', (_, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache'); // SW обновляется при каждом релизе
  sendPublicAsset(res, 'sw.js', 'application/javascript');
});

// ---- Авторизованные раздачи файлов ----
// Раньше /uploads/* и /files/* были полностью публичны, что позволяло
// скачать любое вложение, зная имя файла. Теперь оба требуют:
//   1) для аватарок (avatars/, chat-avatars/) — без авторизации, т.к. <img src>
//      не может слать Bearer-токен. Аватары и так публичный контент.
//   2) для вложений в сообщениях — требуем JWT + членство в чате.

function isPublicAvatarPath(p) {
  // Аватар может лежать как "avatars/...", "chat-avatars/..." (в S3 ключе)
  // или как "/uploads/avatar-XXX-YYY.jpg" / "/uploads/chat-avatar-..." (локально).
  return /(^|\/)(avatars?|chat-avatars?)(\/|-)/i.test(p);
}

async function userCanAccessAttachment(userId, attachmentPath) {
  if (!userId || !attachmentPath) return false;

  const normalizedCandidates = new Set([attachmentPath]);
  if (attachmentPath.startsWith('/files/')) {
    const rawKey = attachmentPath.slice('/files/'.length);
    normalizedCandidates.add(buildFileUrlFromKey(rawKey));
    normalizedCandidates.add(`/files/${encodeURIComponent(rawKey)}`); // legacy-формат старых сообщений
  }

  const candidates = Array.from(normalizedCandidates);
  const result = await query(
    `SELECT 1
     FROM messages m
     JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
     WHERE m.attachment_url = ANY($1::text[])
     LIMIT 1`,
    [candidates, userId]
  );
  return Boolean(result.rows[0]);
}

// Опциональная авторизация: если есть Bearer-токен — валидируем его так же,
// как в authMiddleware: подпись JWT + активная серверная сессия + существующий пользователь.
// Если токена нет или он невалиден — просто идём дальше без req.user.
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();

  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, config.jwtSecret);
    const session = await fetchSession(payload.sessionId, payload.userId);
    if (!session) return next();
    const user = await fetchUserById(payload.userId);
    if (!user) return next();
    req.user = user;
    req.userRaw = user;
    req.sessionId = session.id;
  } catch (_) {
    // Токен невалидный/просроченный — ведём себя как «без авторизации».
  }

  next();
}

const uploadsRouter = express.Router();
uploadsRouter.get('/:filename', optionalAuth, async (req, res) => {
  try {
    const filename = sanitizeStorageKey(req.params.filename);
    const fullPath = `/uploads/${filename}`;
    if (!isPublicAvatarPath(filename)) {
      // Не аватар — требуем авторизацию и членство в чате
      if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
      const allowed = await userCanAccessAttachment(req.user.id, fullPath);
      if (!allowed) return res.status(403).json({ error: 'Доступ запрещён' });
    }
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
filesRouter.get('/*', optionalAuth, async (req, res) => {
  try {
    const rawKey = decodeURIComponent(String(req.params[0] || ''));
    const fullPath = `/files/${rawKey}`;
    if (!isPublicAvatarPath(rawKey)) {
      // Не аватар — требуем авторизацию и членство в чате
      if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
      const allowed = await userCanAccessAttachment(req.user.id, fullPath);
      if (!allowed) return res.status(403).json({ error: 'Доступ запрещён' });
    }
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

app.use(express.static(path.join(__dirname, '..', 'public'), {
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

// Стартовое время процесса для uptime в health
const SERVICE_STARTED_AT = Date.now();

app.get('/api/health', async (_, res) => {
  const db = await dbPing();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    env: config.nodeEnv,
    now: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - SERVICE_STARTED_AT) / 1000),
    db
  });
});

// Версия — удобно увидеть какой коммит развёрнут (Render выставляет RENDER_GIT_COMMIT)
app.get('/api/version', (_, res) => {
  res.json({
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
    branch: process.env.RENDER_GIT_BRANCH || 'unknown',
    nodeVersion: process.version,
    startedAt: new Date(SERVICE_STARTED_AT).toISOString()
  });
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
  res.sendFile(path.join(__dirname, '..', 'public', 'public-profile.html'));
});
app.get(['/c/:username', '/g/:username'], (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'public-chat.html'));
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function emitChatRefresh(chatId) {
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  for (const row of members.rows) {
    io.to(`user:${row.user_id}`).emit('chats:update', await listChats(row.user_id));
  }
}

async function processScheduledMessages() {
  // ВАЖНО: атомарно «забираем» партию сообщений за этим инстансом.
  // Без этого при scale-out (несколько Web-инстансов на Render) оба воркера
  // прочитали бы одни и те же строки и отправили бы сообщение дважды.
  // UPDATE ... RETURNING выполняется внутри одной транзакции и берёт
  // ROW EXCLUSIVE lock на затронутые строки.
  const claimed = await query(
    `UPDATE scheduled_messages
       SET sent_at = NOW()
     WHERE id IN (
       SELECT id FROM scheduled_messages
       WHERE sent_at IS NULL AND scheduled_for <= NOW()
       ORDER BY scheduled_for ASC
       LIMIT 20
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, chat_id, user_id, content, reply_to_message_id, attachment_url, attachment_name`
  );

  for (const item of claimed.rows) {
    const messageId = item.id;
    try {
      await query(
        `INSERT INTO messages (id, chat_id, user_id, content, message_type, reply_to_message_id, attachment_url, attachment_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [messageId, item.chat_id, item.user_id, item.content, item.attachment_url ? 'file' : 'text', item.reply_to_message_id, item.attachment_url, item.attachment_name]
      );
      const formatted = await formatMessage(messageId);
      io.to(item.chat_id).emit('message:new', formatted);
      await emitChatRefresh(item.chat_id);
      // Отложенные сообщения тоже шлём push-ом офлайн-участникам.
      pushNotifyOfflineMembers(app, item.chat_id, formatted).catch(() => {});
    } catch (error) {
      // Если вставка упала — откатываем «выдачу», чтобы повторить позже.
      // Иначе сообщение будет считаться отправленным, а его нет.
      console.error('[scheduled] dispatch failed for', messageId, error.message);
      await query('UPDATE scheduled_messages SET sent_at = NULL WHERE id = $1', [messageId]).catch(() => {});
    }
  }
}

(async () => {
  try {
    await initDb();
    setupWebhook();
    const pushEnabled = initPush();
    if (!pushEnabled && config.isProduction) {
      console.warn('[push] VAPID keys not configured — web push notifications disabled. ' +
        'Generate: node -e "console.log(require(\'web-push\').generateVAPIDKeys())"');
    }
    setInterval(() => { processScheduledMessages().catch((error) => console.error('Scheduled dispatch error', error)); }, 5000);
    server.listen(config.port, () => {
      // Стартовый лог: показывает что в каком режиме работает.
      // Полезно сразу видеть в логах Render: storage режим, есть ли Telegram, какой APP_URL.
      const dbHost = (() => {
        try {
          return new URL(config.databaseUrl).host;
        } catch { return '(invalid)'; }
      })();
      console.log(JSON.stringify({
        event: 'server:started',
        port: config.port,
        env: config.nodeEnv,
        appUrl: config.appUrl,
        storage: config.storage.mode,
        s3Endpoint: config.storage.endpoint || null,
        telegramBot: Boolean(config.telegram.botToken && config.telegram.botToken !== 'your_bot_token_here'),
        webPush: isPushReady(),
        dbHost,
        nodeVersion: process.version
      }));
    });
  } catch (error) {
    console.error('Failed to start application', error);
    process.exit(1);
  }
})();
