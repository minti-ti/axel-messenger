/**
 * Базовые операции с чатами:
 *   - GET /                       — список чатов пользователя
 *   - GET /saved                  — Saved Messages
 *   - GET /username/:username     — поиск чата по username (вернёт карточку или полный чат)
 *   - GET /:chatId                — получить чат
 *   - DELETE /:chatId             — удалить/покинуть чат
 *   - POST /private               — создать (или открыть) приватный чат
 *   - POST /                      — создать группу/канал
 *   - PATCH /:chatId              — обновить чат (settings)
 *   - PATCH /:chatId/preferences  — настройки пользователя для чата
 *                                   (archived/favorite/pinned)
 *   - POST /:chatId/avatar        — загрузить аватар чата
 *   - GET/PUT/DELETE drafts       — черновики
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../db');
const { normalizePhone, normalizeUsername, isValidUsername } = require('../../utils');
const {
  isChatMember,
  getChatById,
  listChats,
  findOrCreatePrivateChat,
  findOrCreateSavedChat
} = require('../../chatService');
const { saveUpload } = require('../../storage');
const {
  avatarUpload,
  resolveUsers,
  getChatPermission,
  canManageChat,
  ensureUniqueChatUsername,
  fetchPublicChatByUsername,
  emitChatRefresh
} = require('./_helpers');

const router = express.Router();

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

    // Если targetUserId заблокировал текущего пользователя — чат не создаём.
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
      return res.status(400).json({ error: 'Username должен быть 4-32 символа: латиница, цифры и _' });
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
    await query(
      'INSERT INTO messages (id, chat_id, user_id, content, message_type) VALUES ($1, $2, $3, $4, $5)',
      [systemMessageId, chatId, req.user.id, `${req.user.displayName} создал${type === 'channel' ? ' канал' : ' группу'}`, 'system']
    );

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

router.get('/drafts/all', async (req, res) => {
  try {
    const result = await query('SELECT chat_id, content, updated_at FROM user_drafts WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.id]);
    res.json({ drafts: result.rows.map((row) => ({ chatId: row.chat_id, content: row.content, updatedAt: row.updated_at })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить черновики' });
  }
});

router.put('/:chatId/draft', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });
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
    res.status(500).json({ error: 'Не удалось сохранить черновик' });
  }
});

router.delete('/:chatId/draft', async (req, res) => {
  try {
    await query('DELETE FROM user_drafts WHERE user_id = $1 AND chat_id = $2', [req.user.id, req.params.chatId]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить черновик' });
  }
});

router.patch('/:chatId/preferences', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });

    const archived = Boolean(req.body.archived);
    const favorite = Boolean(req.body.favorite);
    const pinned = Boolean(req.body.pinned);
    await query('UPDATE chat_members SET archived = $3, favorite = $4, pinned = $5 WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id, archived, favorite, pinned]);

    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось сохранить настройки списка чатов' });
  }
});

router.patch('/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Личный чат нельзя редактировать' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });

    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const username = normalizeUsername(req.body.username || '');
    const isPublic = Boolean(req.body.isPublic);
    const membersCanAddMembers = Boolean(req.body.membersCanAddMembers);
    const membersCanPinMessages = Boolean(req.body.membersCanPinMessages);
    const adminsCanManageMessages = req.body.adminsCanManageMessages !== false;
    const commentsEnabled = Boolean(req.body.commentsEnabled);
    if (!title) return res.status(400).json({ error: 'Название не может быть пустым' });
    if (username && !isValidUsername(username)) {
      return res.status(400).json({ error: 'Username должен быть 4-32 символа: латиница, цифры и _' });
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
    res.status(error.statusCode || 500).json({ error: error.message || 'Не удалось обновить чат' });
  }
});

router.post('/:chatId/avatar', avatarUpload.single('avatar'), async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Для личного чата аватар менять нельзя' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });

    const stored = await saveUpload(req.file, { folder: 'chat-avatars' });
    await query('UPDATE chats SET avatar_url = $2 WHERE id = $1', [chatId, stored.url]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить аватар чата' });
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

module.exports = router;
