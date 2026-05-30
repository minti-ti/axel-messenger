/**
 * Чистые вспомогательные функции для работы с чатами.
 * Вынесены из routes/chats.js для уменьшения размера роутера.
 */

const { query } = require('./db');
const { normalizePhone, normalizeUsername } = require('./utils');

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

function classifyAttachment(name = '') {
  const value = String(name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(value)) return 'photo';
  if (/\.(mp3|ogg|wav|m4a|webm|aac)$/i.test(value)) return 'audio';
  if (/\.(mp4|mov|avi|mkv|webm)$/i.test(value)) return 'video';
  return 'file';
}

function extractLinks(text = '') {
  return String(text || '').match(/https?:\/\/[^\s]+/g) || [];
}

function validateInputLength(input, maxLen, field) {
  if (typeof input !== 'string' || input.length > maxLen) {
    throw new Error(`Invalid ${field}: must be string with max ${maxLen} characters`);
  }
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.trim().substring(0, 1000);
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

async function checkJoinRestriction(chatId, userId) {
  const result = await query('SELECT banned_until, ban_reason FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  const row = result.rows[0];
  if (row?.banned_until && new Date(row.banned_until).getTime() > Date.now()) {
    return { blocked: true, reason: row.ban_reason || 'Вы заблокированы в этом чате' };
  }
  return { blocked: false };
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
  canManageChat,
  canPinInChat,
  canAddMembers,
  canModerateMessages,
  classifyAttachment,
  extractLinks,
  validateInputLength,
  sanitizeInput,
  resolveUsers,
  ensureUniqueChatUsername,
  checkJoinRestriction,
  fetchPublicChatByUsername
};
