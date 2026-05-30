const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authMiddleware } = require('../auth');
const config = require('../config');
const { normalizePhone, normalizeUsername, isValidUsername, formatPublicUser } = require('../utils');
const { isValidUUID, sanitizeString } = require('../validators');
const {
  isChatMember,
  getChatById,
  listChats,
  findOrCreatePrivateChat,
  findOrCreateSavedChat,
  canPostToChat,
  formatMessage,
  listMessages,
  isBlocked
} = require('../chatService');
const { saveUpload } = require('../storage');

const router = express.Router();

// In-memory счётчики rate-limit. Ограничены по размеру и времени, чтобы не утекали.
const userMessageBuckets = new Map();
const suspiciousActivityLog = new Map();
const RATE_LIMIT_MAX_USERS = 5000;      // защита от утечки памяти
const SUSPICIOUS_MAX_KEYS = 2000;
const { generateEncryptionKey } = require('../encryption');

// Периодически чистим старые записи (раз в 10 минут).
// Не используем setInterval на require-этапе, чтобы не блокировать выход процесса в тестах.
let cleanupTimer = null;
function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    // Чистим старше 1 минуты тАФ лимит работает в окне 15 секунд
    for (const [userId, timestamps] of userMessageBuckets) {
      const fresh = timestamps.filter((ts) => now - ts < 60000);
      if (!fresh.length) userMessageBuckets.delete(userId);
      else userMessageBuckets.set(userId, fresh);
    }
    // Если карты слишком разрослись тАФ удаляем самые старые
    if (userMessageBuckets.size > RATE_LIMIT_MAX_USERS) {
      const toDelete = userMessageBuckets.size - RATE_LIMIT_MAX_USERS;
      const keys = Array.from(userMessageBuckets.keys()).slice(0, toDelete);
      keys.forEach((k) => userMessageBuckets.delete(k));
    }
    // Подозрительные события старше 24 часов тАФ выбрасываем
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

const upload = multer({ storage: multer.memoryStorage(), fileFilter: (_, file, cb) => allowAttachment(file, cb), limits: { fileSize: 20 * 1024 * 1024 } });
const avatarUpload = multer({ storage: multer.memoryStorage(), fileFilter: (_, file, cb) => allowAttachment(file, cb), limits: { fileSize: 5 * 1024 * 1024 } });

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
 * @param {string} chatId - ID чата
 * @param {string} chatType - 'private' | 'group' | 'channel'
 * @returns {Promise<string|null>} hex-ключ или null для неприватных чатов
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

// Кэш для getChatPermission на время одного запроса
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
  setTimeout(() => permissionCache.delete(cacheKey), 5000);
  
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

router.use(authMiddleware);

// Валидация UUID-параметров на уровне роутера
router.param('chatId', (req, res, next, val) => {
  if (!isValidUUID(val)) return res.status(400).json({ error: 'Некорректный идентификатор чата' });
  next();
});
router.param('messageId', (req, res, next, val) => {
  if (!isValidUUID(val)) return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
  next();
});

router.get('/search/messages', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ messages: [] });

    const result = await query(
      `SELECT m.*, c.title, c.type, c.username
       FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
       JOIN chats c ON c.id = m.chat_id
       WHERE m.deleted_at IS NULL AND m.is_encrypted = FALSE AND LOWER(m.content) LIKE LOWER($2)
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.user.id, `%${q}%`]
    );

    res.json({
      messages: result.rows.map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        content: row.content,
        createdAt: row.created_at,
        chatTitle: row.title || (row.type === 'private' ? 'Личный чат' : row.type),
        chatUsername: row.username
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось выполнить поиск' });
  }
});

router.get('/saved', async (req, res) => {
  try {
    const chatId = await findOrCreateSavedChat(req.user.id);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось открыть избранное' });
  }
});

router.get('/public/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const chat = await fetchPublicChatByUsername(username, req.user.id);
    if (!chat) return res.status(404).json({ error: 'Публичный чат не найден' });
    res.json({
      chat: {
        id: chat.id,
        title: chat.title,
        username: chat.username,
        description: chat.description,
        avatarUrl: chat.avatar_url,
        type: chat.type,
        memberCount: Number(chat.member_count || 0),
        ownerDisplayName: chat.owner_display_name,
        ownerUsername: chat.owner_username,
        isMember: Boolean(chat.is_member)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось открыть публичную ссылку' });
  }
});

router.post('/public/:username/join', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const chat = await fetchPublicChatByUsername(username, req.user.id);
    if (!chat) return res.status(404).json({ error: 'Публичный чат не найден' });

    const restriction = await checkJoinRestriction(chat.id, req.user.id);
    if (restriction.blocked) return res.status(403).json({ error: restriction.reason });
    await query(
      'INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (chat_id, user_id) DO UPDATE SET banned_until = NULL, ban_reason = NULL',
      [chat.id, req.user.id, 'member']
    );
    const fullChat = await getChatById(chat.id, req.user.id);
    await emitChatRefresh(req.app, chat.id);
    res.json({ chat: fullChat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось вступить в чат' });
  }
});

router.get('/join/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const inviteResult = await query(
      `SELECT ci.token, c.id, c.title, c.username, c.description, c.avatar_url, c.type,
              (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = c.id) AS member_count,
              EXISTS(SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2) AS is_member
       FROM chat_invites ci
       JOIN chats c ON c.id = ci.chat_id
       WHERE ci.token = $1 AND ci.revoked_at IS NULL`,
      [token, req.user.id]
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: 'Приглашение не найдено или отозвано' });
    res.json({
      invite: {
        token: invite.token,
        chat: {
          id: invite.id,
          title: invite.title,
          username: invite.username,
          description: invite.description,
          avatarUrl: invite.avatar_url,
          type: invite.type,
          memberCount: Number(invite.member_count || 0),
          isMember: Boolean(invite.is_member)
        }
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить информацию по приглашению' });
  }
});

router.post('/join/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const inviteResult = await query(
      `SELECT ci.*, c.type
       FROM chat_invites ci
       JOIN chats c ON c.id = ci.chat_id
       WHERE ci.token = $1 AND ci.revoked_at IS NULL`,
      [token]
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: 'Приглашение не найдено или отозвано' });

    const restriction = await checkJoinRestriction(invite.chat_id, req.user.id);
    if (restriction.blocked) return res.status(403).json({ error: restriction.reason });
    await query(
      'INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (chat_id, user_id) DO UPDATE SET banned_until = NULL, ban_reason = NULL',
      [invite.chat_id, req.user.id, 'member']
    );
    const chat = await getChatById(invite.chat_id, req.user.id);
    await emitChatRefresh(req.app, invite.chat_id);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось присоединиться по ссылке' });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json({ chats: await listChats(req.user.id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить список чатов' });
  }
});

router.post('/private', async (req, res) => {
  try {
    let targetUserId = req.body.userId || null;
    const phone = normalizePhone(req.body.phone);
    const username = normalizeUsername(req.body.username || req.body.query || '');

    if (!targetUserId && phone) {
      const userResult = await query('SELECT id FROM users WHERE phone = $1', [phone]);
      targetUserId = userResult.rows[0]?.id || null;
    }
    if (!targetUserId && username) {
      const userResult = await query(
        `SELECT u.id
         FROM users u
         LEFT JOIN user_settings s ON s.user_id = u.id
         WHERE LOWER(u.username) = LOWER($1)
           AND COALESCE(s.allow_username_lookup, TRUE) = TRUE`,
        [username]
      );
      targetUserId = userResult.rows[0]?.id || null;
    }

    if (!targetUserId) return res.status(404).json({ error: 'Пользователь не найден' });
    if (targetUserId === req.user.id) {
      const savedChatId = await findOrCreateSavedChat(req.user.id);
      const savedChat = await getChatById(savedChatId, req.user.id);
      return res.json({ chat: savedChat });
    }

    // Проверка блокировки: если targetUserId заблокировал текущего пользователя — чат не создаём.
    const blockedResult = await query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [targetUserId, req.user.id]);
    if (blockedResult.rows[0]) {
      return res.status(403).json({ error: 'Пользователь ограничил возможность писать ему' });
    }

    const chatId = await findOrCreatePrivateChat(req.user.id, targetUserId);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать личный чат' });
  }
});

router.post('/', async (req, res) => {
  try {
    const type = String(req.body.type || '').trim();
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const username = normalizeUsername(req.body.username || '');
    const isPublic = type === 'channel' ? Boolean(req.body.isPublic) : false;
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
    const memberPhones = Array.isArray(req.body.memberPhones) ? req.body.memberPhones : [];
    const memberUsernames = Array.isArray(req.body.memberUsernames) ? req.body.memberUsernames : [];

    if (!['group', 'channel'].includes(type)) return res.status(400).json({ error: 'Доступны только group или channel' });
    if (!title) return res.status(400).json({ error: 'Введите название' });
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Username должен быть 4-32 символа: ╨╗╨░╤В╨╕╨╜╨╕╤Ж╨░, ╤Ж╨╕╤Д╤А╤Л ╨╕ _' });
    }

    await ensureUniqueChatUsername(username || null);

    const chatId = uuidv4();
    await query(
      'INSERT INTO chats (id, type, title, username, description, owner_user_id, is_public) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [chatId, type, title, username || null, description, req.user.id, isPublic]
    );
    await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)', [chatId, req.user.id, 'owner']);

    const usersToAdd = (await resolveUsers({ memberIds, memberPhones, memberUsernames })).filter((id) => id !== req.user.id);
    for (const memberId of usersToAdd) {
      await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [chatId, memberId, 'member']);
    }

    const systemMessageId = uuidv4();
    await query('INSERT INTO messages (id, chat_id, user_id, content, message_type) VALUES ($1, $2, $3, $4, $5)', [systemMessageId, chatId, req.user.id, `${req.user.displayName} создал${type === 'channel' ? ' канал' : ' группу'}`, 'system']);

    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.status(201).json({ chat });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Не удалось создать чат' });
  }
});

router.get('/username/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const publicChat = await fetchPublicChatByUsername(username, req.user.id);
    if (!publicChat) return res.status(404).json({ error: 'Чат не найден' });
    if (!publicChat.is_member) {
      return res.json({
        publicChat: {
          id: publicChat.id,
          title: publicChat.title,
          username: publicChat.username,
          description: publicChat.description,
          avatarUrl: publicChat.avatar_url,
          type: publicChat.type,
          memberCount: Number(publicChat.member_count || 0),
          isMember: false
        }
      });
    }
    const chat = await getChatById(publicChat.id, req.user.id);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось открыть чат по username' });
  }
});

router.get('/:chatId', async (req, res) => {
  try {
    const chat = await getChatById(req.params.chatId, req.user.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить данные чата' });
  }
});

router.delete('/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });

    if (permission.type === 'private') {
      await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
      const count = await query('SELECT COUNT(*)::int AS count FROM chat_members WHERE chat_id = $1', [chatId]);
      if (Number(count.rows[0]?.count || 0) === 0) {
        await query('DELETE FROM chats WHERE id = $1', [chatId]);
      }
      return res.json({ ok: true, removed: 'private' });
    }

    if (permission.role === 'owner') {
      await query('DELETE FROM chats WHERE id = $1', [chatId]);
      return res.json({ ok: true, removed: 'chat' });
    }

    await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true, removed: 'membership' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить чат' });
  }
});

router.get('/drafts/all', async (req, res) => {
  try {
    const result = await query('SELECT chat_id, content, updated_at FROM user_drafts WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.id]);
    res.json({ drafts: result.rows.map((row) => ({ chatId: row.chat_id, content: row.content, updatedAt: row.updated_at })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╤З╨╡╤А╨╜╨╛╨▓╨╕╨║╨╕' });
  }
});

router.put('/:chatId/draft', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });
    const content = String(req.body.content || '');
    if (!content.trim()) {
      await query('DELETE FROM user_drafts WHERE user_id = $1 AND chat_id = $2', [req.user.id, chatId]);
      return res.json({ ok: true, removed: true });
    }
    await query(
      `INSERT INTO user_drafts (user_id, chat_id, content, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, chat_id)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [req.user.id, chatId, content]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Б╨╛╤Е╤А╨░╨╜╨╕╤В╤М ╤З╨╡╤А╨╜╨╛╨▓╨╕╨║' });
  }
});

router.delete('/:chatId/draft', async (req, res) => {
  try {
    await query('DELETE FROM user_drafts WHERE user_id = $1 AND chat_id = $2', [req.user.id, req.params.chatId]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Г╨┤╨░╨╗╨╕╤В╤М ╤З╨╡╤А╨╜╨╛╨▓╨╕╨║' });
  }
});

router.delete('/:chatId/invites/:token', async (req, res) => {
  try {
    const permission = await getChatPermission(req.params.chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Ф╨╗╤П ╨╗╨╕╤З╨╜╨╛╨│╨╛ ╤З╨░╤В╨░ ╤Б╤Б╤Л╨╗╨║╨╕ ╨╜╨╡╨┤╨╛╤Б╤В╤Г╨┐╨╜╤Л' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });
    await query('UPDATE chat_invites SET revoked_at = NOW() WHERE chat_id = $1 AND token = $2', [req.params.chatId, req.params.token]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Г╨┤╨░╨╗╨╕╤В╤М ╤Б╤Б╤Л╨╗╨║╤Г-╨┐╤А╨╕╨│╨╗╨░╤И╨╡╨╜╨╕╨╡' });
  }
});

router.patch('/:chatId/preferences', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });

    const archived = Boolean(req.body.archived);
    const favorite = Boolean(req.body.favorite);
    const pinned = Boolean(req.body.pinned);
    await query('UPDATE chat_members SET archived = $3, favorite = $4, pinned = $5 WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id, archived, favorite, pinned]);

    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Б╨╛╤Е╤А╨░╨╜╨╕╤В╤М ╨╜╨░╤Б╤В╤А╨╛╨╣╨║╨╕ ╤Б╨┐╨╕╤Б╨║╨░ ╤З╨░╤В╨╛╨▓' });
  }
});

router.patch('/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Личный чат ╨╜╨╡╨╗╤М╨╖╤П ╤А╨╡╨┤╨░╨║╤В╨╕╤А╨╛╨▓╨░╤В╤М' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });

    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const username = normalizeUsername(req.body.username || '');
    const isPublic = Boolean(req.body.isPublic);
    const membersCanAddMembers = Boolean(req.body.membersCanAddMembers);
    const membersCanPinMessages = Boolean(req.body.membersCanPinMessages);
    const adminsCanManageMessages = req.body.adminsCanManageMessages !== false;
    const commentsEnabled = Boolean(req.body.commentsEnabled);
    if (!title) return res.status(400).json({ error: '╨Э╨░╨╖╨▓╨░╨╜╨╕╨╡ ╨╜╨╡ ╨╝╨╛╨╢╨╡╤В ╨▒╤Л╤В╤М ╨┐╤Г╤Б╤В╤Л╨╝' });
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Username должен быть 4-32 символа: ╨╗╨░╤В╨╕╨╜╨╕╤Ж╨░, ╤Ж╨╕╤Д╤А╤Л ╨╕ _' });
    }
    await ensureUniqueChatUsername(username || null, chatId);

    await query(
      'UPDATE chats SET title = $2, description = $3, username = $4, is_public = $5, members_can_add_members = $6, members_can_pin_messages = $7, admins_can_manage_messages = $8, comments_enabled = $9 WHERE id = $1',
      [chatId, title, description, username || null, isPublic, membersCanAddMembers, membersCanPinMessages, adminsCanManageMessages, commentsEnabled]
    );
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╛╨▒╨╜╨╛╨▓╨╕╤В╤М ╤З╨░╤В' });
  }
});

router.post('/:chatId/avatar', avatarUpload.single('avatar'), async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Ф╨╗╤П ╨╗╨╕╤З╨╜╨╛╨│╨╛ ╤З╨░╤В╨░ ╨░╨▓╨░╤В╨░╤А ╨╝╨╡╨╜╤П╤В╤М ╨╜╨╡╨╗╤М╨╖╤П' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });
    if (!req.file) return res.status(400).json({ error: '╨д╨░╨╣╨╗ ╨╜╨╡ ╨▓╤Л╨▒╤А╨░╨╜' });

    const stored = await saveUpload(req.file, { folder: 'chat-avatars' });
    await query('UPDATE chats SET avatar_url = $2 WHERE id = $1', [chatId, stored.url]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╖╨░╨│╤А╤Г╨╖╨╕╤В╤М ╨░╨▓╨░╤В╨░╤А ╤З╨░╤В╨░' });
  }
});

router.get('/:chatId/invites', async (req, res) => {
  try {
    const permission = await getChatPermission(req.params.chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.json({ invites: [] });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });

    const result = await query('SELECT * FROM chat_invites WHERE chat_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC', [req.params.chatId]);
    res.json({ invites: result.rows.map((row) => ({ token: row.token, createdAt: row.created_at })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╨┐╤А╨╕╨│╨╗╨░╤И╨╡╨╜╨╕╤П' });
  }
});

router.post('/:chatId/invites', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Ф╨╗╤П ╨╗╨╕╤З╨╜╨╛╨│╨╛ ╤З╨░╤В╨░ ╤Б╤Б╤Л╨╗╨║╨╕ ╨╜╨╡╨┤╨╛╤Б╤В╤Г╨┐╨╜╤Л' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });

    const token = uuidv4().replace(/-/g, '');
    const inviteId = uuidv4();
    await query('INSERT INTO chat_invites (id, token, chat_id, created_by_user_id) VALUES ($1, $2, $3, $4)', [inviteId, token, chatId, req.user.id]);
    res.status(201).json({ token, url: `${config.appUrl}/join/${token}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Б╨╛╨╖╨┤╨░╤В╤М ╨┐╤А╨╕╨│╨╗╨░╤И╨╡╨╜╨╕╨╡' });
  }
});

router.post('/:chatId/pin/:messageId', async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!canPinInChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓ ╨┤╨╗╤П ╨╖╨░╨║╤А╨╡╨┐╨░' });
    const msgResult = await query('SELECT id FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!msgResult.rows[0]) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });

    await query('UPDATE chats SET pinned_message_id = $2 WHERE id = $1', [chatId, messageId]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:pinned', chat.pinnedMessage);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╖╨░╨║╤А╨╡╨┐╨╕╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.delete('/:chatId/pin', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!canPinInChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓ ╨┤╨╗╤П ╨╛╤В╨║╤А╨╡╨┐╨╗╨╡╨╜╨╕╤П' });
    await query('UPDATE chats SET pinned_message_id = NULL WHERE id = $1', [chatId]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:pinned', null);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╛╤В╨║╤А╨╡╨┐╨╕╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.post('/:chatId/members', async (req, res) => {
  try {
    const { chatId } = req.params;
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
    const memberPhones = Array.isArray(req.body.memberPhones) ? req.body.memberPhones : [];
    const memberUsernames = Array.isArray(req.body.memberUsernames) ? req.body.memberUsernames : [];
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Т ╨╗╨╕╤З╨╜╤Л╨╣ ╤З╨░╤В ╨╜╨╡╨╗╤М╨╖╤П ╨┤╨╛╨▒╨░╨▓╨╗╤П╤В╤М ╤Г╤З╨░╤Б╤В╨╜╨╕╨║╨╛╨▓' });
    if (!canAddMembers(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });

    const usersToAdd = (await resolveUsers({ memberIds, memberPhones, memberUsernames })).filter((id) => id !== req.user.id);
    for (const memberId of usersToAdd) {
      await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [chatId, memberId, 'member']);
    }

    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┤╨╛╨▒╨░╨▓╨╕╤В╤М ╤Г╤З╨░╤Б╤В╨╜╨╕╨║╨╛╨▓' });
  }
});

router.patch('/:chatId/members/:memberId', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Ф╨╗╤П ╨╗╨╕╤З╨╜╨╛╨│╨╛ ╤З╨░╤В╨░ ╤Н╤В╨╛ ╨╜╨╡╨┤╨╛╤Б╤В╤Г╨┐╨╜╨╛' });
    if (permission.role !== 'owner') return res.status(403).json({ error: '╨в╨╛╨╗╤М╨║╨╛ ╨▓╨╗╨░╨┤╨╡╨╗╨╡╤Ж ╨╝╨╛╨╢╨╡╤В ╨╝╨╡╨╜╤П╤В╤М ╤А╨╛╨╗╨╕' });

    const role = String(req.body.role || '').trim();
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: '╨Ф╨╛╨┐╤Г╤Б╤В╨╕╨╝╤Л╨╡ ╤А╨╛╨╗╨╕: admin ╨╕╨╗╨╕ member' });

    const canManageMessages = req.body.canManageMessages !== false;
    const canAddMembers = req.body.canAddMembers !== false;
    const canPinMessages = req.body.canPinMessages !== false;

    await query(
      'UPDATE chat_members SET role = $3, can_manage_messages = $4, can_add_members = $5, can_pin_messages = $6 WHERE chat_id = $1 AND user_id = $2 AND role <> $7',
      [chatId, memberId, role, canManageMessages, canAddMembers, canPinMessages, 'owner']
    );
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╕╨╖╨╝╨╡╨╜╨╕╤В╤М ╤А╨╛╨╗╤М ╤Г╤З╨░╤Б╤В╨╜╨╕╨║╨░' });
  }
});

router.patch('/:chatId/members/:memberId/restrictions', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });
    if (memberId === permission.owner_user_id) return res.status(400).json({ error: '╨Э╨╡╨╗╤М╨╖╤П ╨┐╤А╨╕╨╝╨╡╨╜╤П╤В╤М ╨╛╨│╤А╨░╨╜╨╕╤З╨╡╨╜╨╕╤П ╨║ ╨▓╨╗╨░╨┤╨╡╨╗╤М╤Ж╤Г' });

    const mode = String(req.body.mode || '').trim();
    const minutes = Math.max(Number(req.body.minutes || 0), 0);
    const reason = String(req.body.reason || '').trim();
    let mutedUntil = null;
    let bannedUntil = null;
    if (mode === 'mute' && minutes > 0) mutedUntil = new Date(Date.now() + minutes * 60 * 1000);
    if (mode === 'ban' && minutes > 0) bannedUntil = new Date(Date.now() + minutes * 60 * 1000);
    await query(
      'UPDATE chat_members SET muted_until = $3, mute_reason = $4, banned_until = $5, ban_reason = $6 WHERE chat_id = $1 AND user_id = $2',
      [chatId, memberId, mutedUntil, mode === 'mute' ? reason : null, bannedUntil, mode === 'ban' ? reason : null]
    );
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╤А╨╕╨╝╨╡╨╜╨╕╤В╤М ╨╛╨│╤А╨░╨╜╨╕╤З╨╡╨╜╨╕╤П' });
  }
});

router.delete('/:chatId/members/:memberId', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: '╨Ф╨╗╤П ╨╗╨╕╤З╨╜╨╛╨│╨╛ ╤З╨░╤В╨░ ╤Н╤В╨╛ ╨╜╨╡╨┤╨╛╤Б╤В╤Г╨┐╨╜╨╛' });
    if (!canManageChat(permission)) return res.status(403).json({ error: '╨Э╨╡╨┤╨╛╤Б╤В╨░╤В╨╛╤З╨╜╨╛ ╨┐╤А╨░╨▓' });
    if (memberId === permission.owner_user_id) return res.status(400).json({ error: '╨Э╨╡╨╗╤М╨╖╤П ╤Г╨┤╨░╨╗╨╕╤В╤М ╨▓╨╗╨░╨┤╨╡╨╗╤М╤Ж╨░' });

    await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, memberId]);
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Г╨┤╨░╨╗╨╕╤В╤М ╤Г╤З╨░╤Б╤В╨╜╨╕╨║╨░' });
  }
});

router.get('/:chatId/media', async (req, res) => {
  try {
    const member = await isChatMember(req.params.chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });

    const attachments = await query(
      `SELECT m.id, m.content, m.attachment_url, m.attachment_name, m.created_at, u.display_name, u.username
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1 AND m.attachment_url IS NOT NULL AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.params.chatId]
    );
    const linkMessages = await query(
      `SELECT m.id, m.content, m.created_at, u.display_name, u.username
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1 AND m.deleted_at IS NULL AND m.content ~* 'https?://[^\s]+'
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.params.chatId]
    );

    const items = attachments.rows.map((row) => ({
      id: row.id,
      type: classifyAttachment(row.attachment_name),
      content: row.content,
      attachmentUrl: row.attachment_url,
      attachmentName: row.attachment_name,
      createdAt: row.created_at,
      authorName: row.display_name || row.username
    }));
    for (const row of linkMessages.rows) {
      for (const link of extractLinks(row.content)) {
        items.push({
          id: `${row.id}:${link}`,
          type: 'link',
          url: link,
          content: row.content,
          createdAt: row.created_at,
          authorName: row.display_name || row.username
        });
      }
    }

    res.json({ items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╨╝╨╡╨┤╨╕╨░' });
  }
});

router.get('/messages/:messageId/comments', async (req, res) => {
  try {
    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });
    const member = await isChatMember(source.chat_id, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });
    const result = await query(
      `SELECT m.id
       FROM messages m
       WHERE m.reply_to_message_id = $1 AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC`,
      [req.params.messageId]
    );
    const comments = [];
    for (const row of result.rows) comments.push(await formatMessage(row.id));
    res.json({ comments });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╨║╨╛╨╝╨╝╨╡╨╜╤В╨░╤А╨╕╨╕' });
  }
});

router.post('/messages/:messageId/comments', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: '╨Ъ╨╛╨╝╨╝╨╡╨╜╤В╨░╤А╨╕╨╣ ╨┐╤Г╤Б╤В╨╛╨╣' });
    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });
    const permission = await getChatPermission(source.chat_id, req.user.id);
    if (!permission) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });
    if (permission.type !== 'channel') return res.status(400).json({ error: '╨Ъ╨╛╨╝╨╝╨╡╨╜╤В╨░╤А╨╕╨╕ ╨┤╨╛╤Б╤В╤Г╨┐╨╜╤Л ╤В╨╛╨╗╤М╨║╨╛ ╨▓ канал╨░╤Е' });
    if (!permission.comments_enabled) return res.status(403).json({ error: '╨Ъ╨╛╨╝╨╝╨╡╨╜╤В╨░╤А╨╕╨╕ ╨┤╨╗╤П канал╨░ ╨╛╤В╨║╨╗╤О╤З╨╡╨╜╤Л' });

    const messageId = uuidv4();
    await query(
      `INSERT INTO messages (id, chat_id, user_id, content, message_type, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, source.chat_id, req.user.id, content, 'text', source.id]
    );
    const message = await formatMessage(messageId);
    req.app.get('io').to(source.chat_id).emit('message:new', message);
    await emitChatRefresh(req.app, source.chat_id);
    res.status(201).json({ message });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┤╨╛╨▒╨░╨▓╨╕╤В╤М ╨║╨╛╨╝╨╝╨╡╨╜╤В╨░╤А╨╕╨╣' });
  }
});

router.post('/:chatId/scheduled', async (req, res) => {
  try {
    const permission = await canPostToChat(req.params.chatId, req.user.id);
    if (!permission.allowed) return res.status(403).json({ error: permission.reason });
    const content = String(req.body.content || '').trim();
    const scheduledFor = new Date(req.body.scheduledFor || '');
    if (!content) return res.status(400).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨┐╤Г╤Б╤В╨╛╨╡' });
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() + 10000) {
      return res.status(400).json({ error: '╨Т╤А╨╡╨╝╤П ╨╛╤В╨╗╨╛╨╢╨╡╨╜╨╜╨╛╨╣ ╨╛╤В╨┐╤А╨░╨▓╨║╨╕ ╨┤╨╛╨╗╨╢╨╜╨╛ ╨▒╤Л╤В╤М ╨╝╨╕╨╜╨╕╨╝╤Г╨╝ ╨╜╨░ 10 ╤Б╨╡╨║╤Г╨╜╨┤ ╨┐╨╛╨╖╨╢╨╡ ╤В╨╡╨║╤Г╤Й╨╡╨│╨╛' });
    }
    const id = uuidv4();
    await query(
      `INSERT INTO scheduled_messages (id, chat_id, user_id, content, reply_to_message_id, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.params.chatId, req.user.id, content, req.body.replyToMessageId || null, scheduledFor]
    );
    res.status(201).json({ scheduled: { id, chatId: req.params.chatId, scheduledFor } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╖╨░╨┐╨╗╨░╨╜╨╕╤А╨╛╨▓╨░╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});


router.post('/messages/delete-bulk', async (req, res) => {
  try {
    const messageIds = Array.isArray(req.body.messageIds) ? req.body.messageIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!messageIds.length || messageIds.length > 100) return res.status(400).json({ error: 'Некорректный список сообщений (max 100)' });

    const deleted = [];
    for (const messageId of messageIds) {
      const result = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
      const message = result.rows[0];
      if (!message) continue;

      const permission = await getChatPermission(message.chat_id, req.user.id);
      if (!permission && !req.user?.isSuperadmin) continue;

      // Логируем
      const logId = require('uuid').v4();
      await query(
        'INSERT INTO message_deletion_logs (id, message_id, chat_id, deleted_by_user_id, deleted_at) VALUES ($1, $2, $3, $4, NOW())',
        [logId, messageId, message.chat_id, req.user.id]
      );

      // Soft delete
      await query(`UPDATE messages SET deleted_at = NOW(), content = '', attachment_url = NULL, attachment_name = NULL WHERE id = $1`, [messageId]);
      await query('DELETE FROM reactions WHERE message_id = $1', [messageId]);
      
      req.app.get('io').to(message.chat_id).emit('message:deleted', { messageId, chatId: message.chat_id });
      deleted.push(messageId);
    }

    res.json({ ok: true, deletedCount: deleted.length, deletedIds: deleted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить сообщения' });
  }
});

router.post('/messages/forward-bulk', async (req, res) => {
  try {
    const targetChatId = String(req.body.targetChatId || '').trim();
    const messageIds = Array.isArray(req.body.messageIds) ? req.body.messageIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!targetChatId || !messageIds.length || messageIds.length > 100) return res.status(400).json({ error: '╨Э╨╡ ╨▓╤Л╨▒╤А╨░╨╜╤Л ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤П ╨╕╨╗╨╕ ╤З╨░╤В ╨╜╨░╨╖╨╜╨░╤З╨╡╨╜╨╕╤П' });
    const permission = await canPostToChat(targetChatId, req.user.id);
    if (!permission.allowed) return res.status(403).json({ error: permission.reason });

    const created = [];
    for (const messageId of messageIds) {
      const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
      const source = sourceResult.rows[0];
      if (!source) continue;
      const sourceMember = await isChatMember(source.chat_id, req.user.id);
      if (!sourceMember) continue;
      const newMessageId = uuidv4();
      await query(
        `INSERT INTO messages
         (id, chat_id, user_id, content, message_type, attachment_url, attachment_name, forwarded_from_user_id, forwarded_from_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [newMessageId, targetChatId, req.user.id, source.content, source.message_type, source.attachment_url, source.attachment_name, source.user_id, source.id]
      );
      const formatted = await formatMessage(newMessageId);
      created.push(formatted);
      req.app.get('io').to(targetChatId).emit('message:new', formatted);
    }
    await emitChatRefresh(req.app, targetChatId);
    res.status(201).json({ messages: created });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╡╤А╨╡╤Б╨╗╨░╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤П' });
  }
});

// Получить одно сообщение по id. Используется в модерационной панели
// для предварительного просмотра текста перед редактированием.
router.get('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === "") return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    const result = await query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Сообщение не найдено' });

    // Доступ имеют: участники чата, либо суперадмин (модератор).
    const permission = await getChatPermission(row.chat_id, req.user.id);
    if (!permission && !req.user?.isSuperadmin) {
      return res.status(403).json({ error: 'Нет доступа к сообщению' });
    }

    const message = await formatMessage(messageId);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    res.json({ message });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить сообщение' });
  }
});

router.patch('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === "") return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: '╨в╨╡╨║╤Б╤В ╨╜╨╡ ╨╝╨╛╨╢╨╡╤В ╨▒╤Л╤В╤М ╨┐╤Г╤Б╤В╤Л╨╝' });

    const result = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });

    const permission = await getChatPermission(message.chat_id, req.user.id);
    const canModerate = canModerateMessages(permission);
    // Суперадмин (модератор) тоже может редактировать любое сообщение,
    // в том числе из чата, в котором не состоит — это нужно для
    // обработки жалоб в модерационном чате.
    if (message.user_id !== req.user.id && !canModerate && !req.user?.isSuperadmin) {
      return res.status(403).json({ error: 'Недостаточно прав для редактирования чужого сообщения' });
    }

    await query('UPDATE messages SET content = $2, edited_at = NOW() WHERE id = $1', [messageId, content]);
    const formatted = await formatMessage(messageId);
    req.app.get('io').to(message.chat_id).emit('message:update', formatted);
    await emitChatRefresh(req.app, message.chat_id);
    res.json({ message: formatted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╛╤В╤А╨╡╨┤╨░╨║╤В╨╕╤А╨╛╨▓╨░╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.delete('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === "") return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    const result = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });

    // Разрешаем удалять любое сообщение любому участнику чата.
    // Достаточно того, что пользователь состоит в этом чате.
    // Суперадмин (модератор) может удалять сообщения из любого чата,
    // даже если он в нём не состоит — это нужно для обработки жалоб.
    const permission = await getChatPermission(message.chat_id, req.user.id);
    if (!permission && !req.user?.isSuperadmin) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления сообщения' });
    }

    // ╨Ы╨╛╨│╨╕╤А╤Г╨╡╨╝ ╤Г╨┤╨░╨╗╨╡╨╜╨╕╨╡ ╨┤╨╗╤П ╨░╤Г╨┤╨╕╤В╨░ ╨▒╨╡╨╖╨╛╨┐╨░╤Б╨╜╨╛╤Б╤В╨╕
    const logId = require('uuid').v4();
    await query(
      'INSERT INTO message_deletion_logs (id, message_id, chat_id, deleted_by_user_id, deleted_at) VALUES ($1, $2, $3, $4, NOW())',
      [logId, messageId, message.chat_id, req.user.id]
    );

    // ╨Я╨Ю╨Ы╨Э╨Ю╨Х ╨г╨Ф╨Р╨Ы╨Х╨Э╨Ш╨Х ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤П (╨╜╨╡ soft delete)
    // ╨б╨╜╨░╤З╨░╨╗╨░ ╤Г╨┤╨░╨╗╤П╨╡╨╝ ╨▓╤Б╨╡ ╤Б╨▓╤П╨╖╨░╨╜╨╜╤Л╨╡ ╨┤╨░╨╜╨╜╤Л╨╡
    await query('DELETE FROM reactions WHERE message_id = $1', [messageId]);
    await query('DELETE FROM messages WHERE reply_to_message_id = $1', [messageId]);
    
    // ╨Ч╨░╤В╨╡╨╝ ╤Г╨┤╨░╨╗╤П╨╡╨╝ ╤Б╨░╨╝╨╛ ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡
    await query('DELETE FROM messages WHERE id = $1', [messageId]);

    // ╨г╨▓╨╡╨┤╨╛╨╝╨╗╤П╨╡╨╝ ╨╛╨▒ ╤Г╨┤╨░╨╗╨╡╨╜╨╕╨╕
    req.app.get('io').to(message.chat_id).emit('message:deleted', { messageId, chatId: message.chat_id });
    await emitChatRefresh(req.app, message.chat_id);
    
    res.json({ ok: true, messageId, deletedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╤Г╨┤╨░╨╗╨╕╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.post('/messages/:messageId/reactions', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === "") return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: '╨г╨║╨░╨╢╨╕╤В╨╡ emoji' });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = msgResult.rows[0];
    if (!message) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });

    const member = await isChatMember(message.chat_id, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤О' });

    const existing = await query('SELECT emoji FROM reactions WHERE message_id = $1 AND user_id = $2 LIMIT 1', [messageId, req.user.id]);
    if (existing.rows[0]?.emoji === emoji) {
      await query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2', [messageId, req.user.id]);
    } else {
      await query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2', [messageId, req.user.id]);
      await query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, req.user.id, emoji]);
    }

    const formatted = await formatMessage(messageId);
    req.app.get('io').to(message.chat_id).emit('message:update', formatted);
    res.json({ message: formatted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╤Б╤В╨░╨▓╨╕╤В╤М ╤А╨╡╨░╨║╤Ж╨╕╤О' });
  }
});

router.post('/messages/:messageId/forward', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === "") return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    const targetChatId = String(req.body.targetChatId || '').trim();
    if (!targetChatId) return res.status(400).json({ error: '╨Э╨╡ ╤Г╨║╨░╨╖╨░╨╜ ╤Ж╨╡╨╗╨╡╨▓╨╛╨╣ ╤З╨░╤В' });

    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜╨╛' });
    const sourceMember = await isChatMember(source.chat_id, req.user.id);
    if (!sourceMember) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╨╕╤Б╤Е╨╛╨┤╨╜╨╛╨╝╤Г ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤О' });

    const permission = await canPostToChat(targetChatId, req.user.id);
    if (!permission.allowed) return res.status(403).json({ error: permission.reason });

    const newMessageId = uuidv4();
    await query(
      `INSERT INTO messages
       (id, chat_id, user_id, content, message_type, attachment_url, attachment_name, forwarded_from_user_id, forwarded_from_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newMessageId,
        targetChatId,
        req.user.id,
        source.content,
        source.message_type,
        source.attachment_url,
        source.attachment_name,
        source.user_id,
        source.id
      ]
    );

    const message = await formatMessage(newMessageId);
    req.app.get('io').to(targetChatId).emit('message:new', message);
    await emitChatRefresh(req.app, targetChatId);
    res.status(201).json({ message });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╡╤А╨╡╤Б╨╗╨░╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.get('/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });
    const messages = await listMessages(chatId, req.user.id, Math.min(Number(req.query.limit || 50), 200));
    await emitChatRefresh(req.app, chatId);
    if (String(req.query.silent || '0') !== '1') {
      req.app.get('io').to(chatId).emit('chat:read', { chatId, userId: req.user.id });
    }
    res.json({ messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╤П' });
  }
});

router.post('/:chatId/read', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });
    await query('UPDATE chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:read', { chatId, userId: req.user.id });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╛╤В╨╝╨╡╤В╨╕╤В╤М ╨┐╤А╨╛╤З╨╕╤В╨░╨╜╨╜╤Л╨╝' });
  }
});

router.delete('/:chatId/clear', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Вы не состоите в этом чате' });
    await query('DELETE FROM messages WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось очистить историю' });
  }
});

router.post('/:chatId/messages', upload.array('attachment', 10), async (req, res) => {
  try {
    const { chatId } = req.params;
    let content = String(req.body.content || '').trim();
    const replyToMessageId = req.body.replyToMessageId || null;
    let permission = await canPostToChat(chatId, req.user.id);
    const chatPermission = await getChatPermission(chatId, req.user.id);
    
    if (!permission.allowed) {
      const canComment = chatPermission && chatPermission.type === 'channel' && chatPermission.comments_enabled === true && replyToMessageId;
      if (!canComment) return res.status(403).json({ error: permission.reason });
      permission = { allowed: true, role: chatPermission.role, type: chatPermission.type };
    }

    if (chatPermission?.type === 'private' && !chatPermission.isSaved) {
      const peerId = chatPermission.peer_id;
      if (await isBlocked(peerId, req.user.id)) {
        return res.status(403).json({ error: 'Вы заблокированы этим пользователем' });
      }
    }
    
    const files = Array.isArray(req.files) ? req.files : [];
    if (!content && !files.length) return res.status(400).json({ error: '╨б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡ ╨┐╤Г╤Б╤В╨╛╨╡' });
    if (isRateLimited(req.user.id)) return res.status(429).json({ error: '╨б╨╗╨╕╤И╨║╨╛╨╝ ╤З╨░╤Б╤В╨░╤П ╨╛╤В╨┐╤А╨░╨▓╨║╨░ ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╣. ╨Я╨╛╨┐╤А╨╛╨▒╤Г╨╣╤В╨╡ ╤З╤Г╤В╤М ╨┐╨╛╨╖╨╢╨╡.' });
    if (content.length > 10000) return res.status(400).json({ error: "Сообщение слишком длинное (max 10000 символов)" });

    const createdMessages = [];
    const canCreateAlbum = files.length > 1 && files.every((file) => String(file.mimetype || '').startsWith('image/'));
    const albumId = canCreateAlbum ? uuidv4() : null;

    // Сообщения сохраняются в открытом виде.
    //
    // Раньше приватные чаты «шифровались» на сервере ключом из той же БД
    // (encryption_keys). Это не давало реальной защиты (админ/дамп БД = и ключ,
    // и шифротекст) и при этом ЛОМАЛО чтение: decryptMessage на сервере не
    // вызывался, а клиент не получал ключ — поэтому сообщения отображались как
    // «[Зашифрованное сообщение]».
    //
    // Старые зашифрованные записи по-прежнему читаются: chatService.js
    // расшифровывает их на лету по флагу is_encrypted (decryptLegacyRows).
    // Для настоящей приватности нужен полноценный E2E (ключи на клиенте).
    const isEncrypted = false;

    if (!files.length) {
      const messageId = uuidv4();
      await query(
        `INSERT INTO messages
         (id, chat_id, user_id, content, is_encrypted, encryption_key_version, message_type, attachment_url, attachment_name, reply_to_message_id, album_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [messageId, chatId, req.user.id, content, isEncrypted, isEncrypted ? 1 : null, 'text', null, null, replyToMessageId, null]
      );
      createdMessages.push(await formatMessage(messageId));
    } else {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const messageId = uuidv4();
        const stored = await saveUpload(file, { folder: 'chat-files' });
        const attachmentUrl = stored.url;
        const attachmentName = file.originalname;
        
        let msgContent = i === 0 ? content : '';
        let msgType = 'file';
        if (files.length === 1 && !content && String(file.mimetype || '').startsWith('audio/')) {
          msgType = 'voice';
        }
        
        await query(
          `INSERT INTO messages
           (id, chat_id, user_id, content, is_encrypted, encryption_key_version, message_type, attachment_url, attachment_name, reply_to_message_id, album_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [messageId, chatId, req.user.id, msgContent, isEncrypted, isEncrypted ? 1 : null, msgType, attachmentUrl, attachmentName, i === 0 ? replyToMessageId : null, albumId]
        );
        createdMessages.push(await formatMessage(messageId));
      }
    }

    createdMessages.forEach((message) => req.app.get('io').to(chatId).emit('message:new', message));
    await emitChatRefresh(req.app, chatId);
    res.status(201).json({ message: createdMessages[0], messages: createdMessages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨╛╤В╨┐╤А╨░╨▓╨╕╤В╤М ╤Б╨╛╨╛╨▒╤Й╨╡╨╜╨╕╨╡' });
  }
});

router.get('/:chatId/members', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: '╨Э╨╡╤В ╨┤╨╛╤Б╤В╤Г╨┐╨░ ╨║ ╤З╨░╤В╤Г' });

    const result = await query(
      `SELECT u.*, cm.role, cm.joined_at, cm.can_manage_messages, cm.can_add_members, cm.can_pin_messages
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1
       ORDER BY CASE cm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.display_name ASC`,
      [chatId]
    );

    res.json({
      members: result.rows.map((row) => ({
        ...formatPublicUser(row),
        role: row.role,
        joinedAt: row.joined_at,
        permissions: {
          canManageMessages: row.can_manage_messages !== false,
          canAddMembers: row.can_add_members !== false,
          canPinMessages: row.can_pin_messages !== false
        }
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '╨Э╨╡ ╤Г╨┤╨░╨╗╨╛╤Б╤М ╨┐╨╛╨╗╤Г╤З╨╕╤В╤М ╤Г╤З╨░╤Б╤В╨╜╨╕╨║╨╛╨▓' });
  }
});

module.exports = router;
