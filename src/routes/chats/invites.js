/**
 * Эндпоинты /api/chats для приглашений и публичных чатов:
 *   - GET/POST /join/:token            — вход по инвайт-ссылке
 *   - GET /public/:username            — карточка публичного чата
 *   - POST /public/:username/join      — присоединиться к публичному чату
 *   - GET/POST /:chatId/invites        — управление инвайт-ссылками
 *   - DELETE /:chatId/invites/:token   — отзыв инвайт-ссылки
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../db');
const config = require('../../config');
const { normalizeUsername } = require('../../utils');
const { getChatById } = require('../../chatService');
const {
  fetchPublicChatByUsername,
  checkJoinRestriction,
  getChatPermission,
  canManageChat,
  emitChatRefresh
} = require('./_helpers');

const router = express.Router();

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

router.delete('/:chatId/invites/:token', async (req, res) => {
  try {
    const permission = await getChatPermission(req.params.chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Для личного чата ссылки недоступны' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });
    await query('UPDATE chat_invites SET revoked_at = NOW() WHERE chat_id = $1 AND token = $2', [req.params.chatId, req.params.token]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить ссылку-приглашение' });
  }
});

router.get('/:chatId/invites', async (req, res) => {
  try {
    const permission = await getChatPermission(req.params.chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.json({ invites: [] });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });

    const result = await query('SELECT * FROM chat_invites WHERE chat_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC', [req.params.chatId]);
    res.json({ invites: result.rows.map((row) => ({ token: row.token, createdAt: row.created_at })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить приглашения' });
  }
});

router.post('/:chatId/invites', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Для личного чата ссылки недоступны' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });

    const token = uuidv4().replace(/-/g, '');
    const inviteId = uuidv4();
    await query('INSERT INTO chat_invites (id, token, chat_id, created_by_user_id) VALUES ($1, $2, $3, $4)', [inviteId, token, chatId, req.user.id]);
    res.status(201).json({ token, url: `${config.appUrl}/join/${token}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать приглашение' });
  }
});

module.exports = router;
