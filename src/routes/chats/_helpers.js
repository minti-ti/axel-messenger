/**
 * Общая инфраструктура для подроутеров /api/chats/*:
 *   - multer (upload, avatarUpload)
 *   - in-memory rate-limit и suspicious activity log (с автоочисткой)
 *   - кэш разрешений на запрос (getChatPermission)
 *   - утилиты (canManageChat, canPinInChat, canAddMembers, canModerateMessages,
 *     classifyAttachment, extractLinks, resolveUsers, ensureUniqueChatUsername,
 *     fetchPublicChatByUsername, checkJoinRestriction, ensureEncryptionKey,
 *     emitChatRefresh).
 *
 * Этот модуль НЕ создаёт Express router и НЕ регистрирует HTTP-эндпоинтов.
 * Его реэкспортируют подмодули (messages.js, members.js, invites.js, chats.js).
 */

const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../db');
const config = require('../../config');
const { normalizePhone, normalizeUsername } = require('../../utils');
const { generateEncryptionKey } = require('../../encryption');
const { listChats } = require('../../chatService');

// --- Rate-limit и подозрительная активность ---
// In-memory счётчики rate-limit. Ограничены по размеру и времени, чтобы не утекали.
const userMessageBuckets = new Map();
const suspiciousActivityLog = new Map();
const RATE_LIMIT_MAX_USERS = 5000;      // защита от утечки памяти
const SUSPICIOUS_MAX_KEYS = 2000;

// Периодически чистим старые записи (раз в 10 минут).
// Не используем setInterval на require-этапе, чтобы не блокировать выход процесса в тестах.
let cleanupTimer = null;
function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    // Чистим старше 1 минуты — лимит работает в окне 15 секунд
    for (const [userId, timestamps] of userMessageBuckets) {
      const fresh = timestamps.filter((ts) => now - ts < 60000);
      if (!fresh.length) userMessageBuckets.delete(userId);
      else userMessageBuckets.set(userId, fresh);
    }
    if (userMessageBuckets.size > RATE_LIMIT_MAX_USERS) {
      const toDelete = userMessageBuckets.size - RATE_LIMIT_MAX_USERS;
      const keys = Array.from(userMessageBuckets.keys()).slice(0, toDelete);
      keys.forEach((k) => userMessageBuckets.delete(k));
    }
    // Подозрительные события старше 24 часов — выбрасываем
    for (const [key, entry] of suspiciousActivityLog) {
      if (now - (entry.lastSeen || 0) > 24 * 60 * 60 * 1000) {
        suspiciousActivityLog.delete(key);
      }
    }
    if (suspiciousActivityLog.size > SUSPICIOUS_MAX_KEYS) {
      const toDelete = suspiciousActivityLog.size - SUSPICIOUS_MAX_KEYS;
      const keys = Array.from(suspiciousActivityLog.keys()).slice(0, toDelete);
      keys.forEach((k) => suspiciousActivityLog.delete(k));
    }
  }, 10 * 60 * 1000);
  cleanupTimer.unref?.();
}
startCleanupTimer();

function logSuspiciousActivity(userId, reason, details = {}) {
  const key = `${userId}:${reason}`;
  const entry = suspiciousActivityLog.get(key) || { count: 0, firstSeen: Date.now() };
  entry.count++;
  entry.lastSeen = Date.now();
  suspiciousActivityLog.set(key, entry);

  if (config.isProduction && entry.count > 5) {
    console.warn(`[SECURITY] Suspicious activity detected - User: ${userId}, Reason: ${reason}, Count: ${entry.count}`, details);
  }
}

function isRateLimited(userId) {
  const now = Date.now();
  const bucket = (userMessageBuckets.get(userId) || []).filter((ts) => now - ts < 15000);
  if (bucket.length >= 12) {
    logSuspiciousActivity(userId, 'RATE_LIMIT_EXCEEDED');
    userMessageBuckets.set(userId, bucket);
    return true;
  }
  bucket.push(now);
  userMessageBuckets.set(userId, bucket);
  return false;
}

// --- Multer: разрешённые типы вложений и параметры загрузки ---
if (!fs.existsSync(config.uploadsDir)) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}

const allowedAttachmentTypes = [
  'image/', 'audio/', 'video/', 'application/pdf', 'text/plain', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

function allowAttachment(file, cb) {
  const mimetype = String(file.mimetype || '');
  if (mimetype === 'image/svg+xml') {
    return cb(new Error('SVG-файлы запрещены по соображениям безопасности'));
  }
  const ok = allowedAttachmentTypes.some((type) => type.endsWith('/') ? mimetype.startsWith(type) : mimetype === type);
  if (!ok) return cb(new Error('Тип файла не разрешён'));
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_, file, cb) => allowAttachment(file, cb),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_, file, cb) => allowAttachment(file, cb),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// --- Утилиты валидации/санитизации ---
function validateInputLength(input, maxLen, field) {
  if (typeof input !== 'string' || input.length > maxLen) {
    throw new Error(`Invalid ${field}: must be string with max ${maxLen} characters`);
  }
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.trim().substring(0, 1000);
}

/**
 * Управление ключами server-side шифрования.
 * ⚠️ ВАЖНО: Это SERVER-SIDE шифрование, НЕ end-to-end!
 */
async function ensureEncryptionKey(chatId, chatType) {
  if (chatType !== 'private') return null;

  const existing = await query('SELECT key_data FROM encryption_keys WHERE chat_id = $1 ORDER BY version DESC LIMIT 1', [chatId]);
  if (existing.rows[0]) {
    return existing.rows[0].key_data;
  }

  const newKey = generateEncryptionKey();
  await query(
    'INSERT INTO encryption_keys (id, chat_id, version, key_data, algorithm) VALUES ($1, $2, $3, $4, $5)',
    [uuidv4(), chatId, 1, newKey, 'AES-256-GCM']
  );

  return newKey;
}

async function emitChatRefresh(app, chatId) {
  const io = app.get('io');
  if (!io) return;
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  for (const row of members.rows) {
    io.to(`user:${row.user_id}`).emit('chats:update', await listChats(row.user_id));
  }
}

/**
 * Шлёт web-push офлайн-участникам чата при новом сообщении.
 *
 * Что значит «офлайн»: у пользователя нет ни одного открытого Socket.IO
 * соединения с этим инстансом сервера. Если он сейчас в браузере — он и так
 * получит сообщение по WS, push дублировать не нужно. Если в браузере, но в
 * другой вкладке/фоне — клиент сам решает, показывать ли in-app уведомление
 * (через maybeNotifyMessage).
 *
 * Fire-and-forget: возвращает Promise, но вызывающий код может его не
 * await'ить — мы не хотим блокировать HTTP-ответ на медленные push-сервисы.
 *
 * Не падает: все ошибки внутри pushService поглощаются.
 *
 * @param {Express.Application} app
 * @param {string} chatId
 * @param {{userId: string, content?: string, attachmentName?: string,
 *          chatTitle?: string, chatType?: string, authorName?: string}} message
 *   message — нормализованный объект из formatMessage(). Поля могут быть как
 *   в camelCase (id, userId, content), так и в snake_case если зовут из
 *   server.js до formatMessage.
 */
async function pushNotifyOfflineMembers(app, chatId, message) {
  try {
    // Ленивая загрузка, чтобы тесты на отдельные модули не тянули pg/web-push.
    // eslint-disable-next-line global-require
    const { isPushReady, sendPushToUsers } = require('../../pushService');
    if (!isPushReady()) return;

    // Берём участников чата кроме автора сообщения
    const authorId = message?.userId || message?.user_id || null;
    const members = await query(
      `SELECT cm.user_id, COALESCE(us.notifications_enabled, TRUE) AS notifications_enabled,
              COALESCE(us.notify_private_chats, TRUE) AS notify_private_chats,
              COALESCE(us.notify_groups, TRUE) AS notify_groups
       FROM chat_members cm
       LEFT JOIN user_settings us ON us.user_id = cm.user_id
       JOIN chats c ON c.id = cm.chat_id
       WHERE cm.chat_id = $1
         AND cm.user_id <> COALESCE($2, '')
         AND (cm.muted_until IS NULL OR cm.muted_until <= NOW())`,
      [chatId, authorId]
    );
    if (!members.rows.length) return;

    // Тип чата для проверки настроек notify_private_chats / notify_groups
    const chatRow = await query('SELECT type, title FROM chats WHERE id = $1', [chatId]);
    const chat = chatRow.rows[0];
    if (!chat) return;
    const chatType = chat.type;
    const chatTitle = message?.chatTitle || chat.title || (chatType === 'private' ? 'Личный чат' : '');

    // Фильтруем по настройкам уведомлений + по «офлайнности» через Socket.IO room.
    const io = app.get('io');
    const recipients = [];
    for (const row of members.rows) {
      if (!row.notifications_enabled) continue;
      if (chatType === 'private' && !row.notify_private_chats) continue;
      if ((chatType === 'group' || chatType === 'channel') && !row.notify_groups) continue;

      // Если у пользователя есть открытое WS-соединение — пропускаем push.
      // У нас на каждого юзера комната `user:<id>`.
      if (io && io.sockets && io.sockets.adapter) {
        const room = io.sockets.adapter.rooms.get(`user:${row.user_id}`);
        if (room && room.size > 0) continue;
      }
      recipients.push(row.user_id);
    }
    if (!recipients.length) return;

    const authorName = message?.authorName || message?.author?.displayName || '';
    const text = message?.content || (message?.attachmentName ? `📎 ${message.attachmentName}` : '');

    const title = chatType === 'private'
      ? (authorName || 'Новое сообщение')
      : (chatTitle ? `${authorName ? authorName + ' · ' : ''}${chatTitle}` : (authorName || 'Новое сообщение'));

    const payload = {
      title,
      body: text || 'Новое сообщение',
      url: `/?chat=${encodeURIComponent(chatId)}`,
      tag: `chat:${chatId}`
    };

    // Fire-and-forget. await нужен, чтобы исключения внутри не превратились
    // в unhandled rejection — сама функция sendPushToUsers их уже глотает.
    await sendPushToUsers(recipients, payload);
  } catch (error) {
    // Push не должен ронять отправку сообщения. Просто логируем.
    if (!require('../../config').isProduction) {
      console.warn('[push] notify offline members failed:', error.message);
    }
  }
}

async function resolveUsers({ memberIds = [], memberPhones = [], memberUsernames = [] }) {
  const ids = [...new Set(memberIds)].filter(Boolean);
  const phones = [...new Set(memberPhones.map(normalizePhone).filter(Boolean))];
  const usernames = [...new Set(memberUsernames.map(normalizeUsername).filter(Boolean))];
  let resolved = [...ids];
  if (phones.length) {
    const byPhone = await query('SELECT id FROM users WHERE phone = ANY($1::text[])', [phones]);
    resolved = [...resolved, ...byPhone.rows.map((row) => row.id)];
  }
  if (usernames.length) {
    const byUsername = await query('SELECT id FROM users WHERE LOWER(username) = ANY($1::text[])', [usernames.map((x) => x.toLowerCase())]);
    resolved = [...resolved, ...byUsername.rows.map((row) => row.id)];
  }
  return [...new Set(resolved)];
}

// --- Кэш разрешений в чате (короткоживущий, на 5 сек) ---
const permissionCache = new Map();

async function getChatPermission(chatId, userId) {
  const cacheKey = `${chatId}:${userId}`;
  if (permissionCache.has(cacheKey)) {
    return permissionCache.get(cacheKey);
  }

  const result = await query(
    `SELECT c.*, cm.role, cm.can_manage_messages, cm.can_add_members, cm.can_pin_messages
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [chatId, userId]
  );
  const permission = result.rows[0] || null;
  permissionCache.set(cacheKey, permission);

  // Очищаем кэш через 5 секунд
  setTimeout(() => permissionCache.delete(cacheKey), 5000).unref?.();

  return permission;
}

async function ensureUniqueChatUsername(username, excludeChatId = null) {
  if (!username) return;
  const result = await query(
    `SELECT id FROM chats WHERE LOWER(username) = LOWER($1) ${excludeChatId ? 'AND id <> $2' : ''} LIMIT 1`,
    excludeChatId ? [username, excludeChatId] : [username]
  );
  if (result.rows[0]) {
    const error = new Error('Этот username чата уже занят');
    error.statusCode = 409;
    throw error;
  }
}

// --- Permission helpers ---
function canManageChat(permission) {
  return permission && ['owner', 'admin'].includes(permission.role);
}

function canPinInChat(permission) {
  if (!permission) return false;
  if (permission.type === 'private') return true;
  if (permission.role === 'owner') return true;
  if (permission.role === 'admin') return permission.can_pin_messages !== false;
  return permission.members_can_pin_messages === true;
}

function canAddMembers(permission) {
  if (!permission) return false;
  if (permission.type === 'private') return false;
  if (permission.role === 'owner') return true;
  if (permission.role === 'admin') return permission.can_add_members !== false;
  return permission.members_can_add_members === true;
}

function canModerateMessages(permission) {
  if (!permission) return false;
  if (permission.type === 'private') return false;
  if (permission.role === 'owner') return true;
  if (permission.role === 'admin') return permission.admins_can_manage_messages !== false && permission.can_manage_messages !== false;
  return false;
}

async function checkJoinRestriction(chatId, userId) {
  const result = await query('SELECT banned_until, ban_reason FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  const row = result.rows[0];
  if (row?.banned_until && new Date(row.banned_until).getTime() > Date.now()) {
    return { blocked: true, reason: row.ban_reason || 'Вы заблокированы в этом чате' };
  }
  return { blocked: false };
}

function classifyAttachment(name = '') {
  const value = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(value)) return 'photo';
  if (/\.(mp3|ogg|wav|m4a|webm|aac|opus|flac)$/i.test(value)) return 'audio';
  if (/\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(value)) return 'video';
  return 'file';
}

function extractLinks(text = '') {
  return String(text || '').match(/https?:\/\/[^\s]+/g) || [];
}

async function fetchPublicChatByUsername(username, viewerUserId) {
  const result = await query(
    `SELECT
      c.*,
      EXISTS(SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2) AS is_member,
      (SELECT COUNT(*)::int FROM chat_members x WHERE x.chat_id = c.id) AS member_count,
      u.display_name AS owner_display_name,
      u.username AS owner_username
     FROM chats c
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE LOWER(c.username) = LOWER($1)
       AND c.type IN ('group', 'channel')
     LIMIT 1`,
    [username, viewerUserId]
  );
  return result.rows[0] || null;
}

module.exports = {
  // multer
  upload,
  avatarUpload,
  // rate-limit / suspicious
  isRateLimited,
  logSuspiciousActivity,
  // permissions / cache
  getChatPermission,
  ensureUniqueChatUsername,
  canManageChat,
  canPinInChat,
  canAddMembers,
  canModerateMessages,
  checkJoinRestriction,
  // utils
  resolveUsers,
  classifyAttachment,
  extractLinks,
  fetchPublicChatByUsername,
  ensureEncryptionKey,
  emitChatRefresh,
  pushNotifyOfflineMembers,
  validateInputLength,
  sanitizeInput
};
