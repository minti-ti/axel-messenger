/**
 * Эндпоинты /api/chats для управления участниками:
 *   - добавление участников (по id / phone / username)
 *   - смена роли (admin/member)
 *   - mute/ban (restrictions)
 *   - удаление участников
 *   - список участников чата
 */

const express = require('express');
const { query } = require('../../db');
const { formatPublicUser } = require('../../utils');
const { isChatMember } = require('../../chatService');
const {
  resolveUsers,
  getChatPermission,
  canManageChat,
  canAddMembers,
  emitChatRefresh
} = require('./_helpers');

const router = express.Router();

router.post('/:chatId/members', async (req, res) => {
  try {
    const { chatId } = req.params;
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
    const memberPhones = Array.isArray(req.body.memberPhones) ? req.body.memberPhones : [];
    const memberUsernames = Array.isArray(req.body.memberUsernames) ? req.body.memberUsernames : [];
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'В личный чат нельзя добавлять участников' });
    if (!canAddMembers(permission)) return res.status(403).json({ error: 'Недостаточно прав' });

    const usersToAdd = (await resolveUsers({ memberIds, memberPhones, memberUsernames })).filter((id) => id !== req.user.id);
    for (const memberId of usersToAdd) {
      await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [chatId, memberId, 'member']);
    }

    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось добавить участников' });
  }
});

router.patch('/:chatId/members/:memberId', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Для личного чата это недоступно' });
    if (permission.role !== 'owner') return res.status(403).json({ error: 'Только владелец может менять роли' });

    const role = String(req.body.role || '').trim();
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Допустимые роли: admin или member' });

    const canManageMessages = req.body.canManageMessages !== false;
    // Эти константы нарочно тенюют импорты (canAddMembers/etc. — то функция, то bool).
    // Здесь это локальные boolean-флаги, передаваемые в SQL.
    const canAddMembersFlag = req.body.canAddMembers !== false;
    const canPinMessagesFlag = req.body.canPinMessages !== false;

    await query(
      'UPDATE chat_members SET role = $3, can_manage_messages = $4, can_add_members = $5, can_pin_messages = $6 WHERE chat_id = $1 AND user_id = $2 AND role <> $7',
      [chatId, memberId, role, canManageMessages, canAddMembersFlag, canPinMessagesFlag, 'owner']
    );
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось изменить роль участника' });
  }
});

router.patch('/:chatId/members/:memberId/restrictions', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });
    if (memberId === permission.owner_user_id) return res.status(400).json({ error: 'Нельзя применять ограничения к владельцу' });

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
    res.status(500).json({ error: 'Не удалось применить ограничения' });
  }
});

router.delete('/:chatId/members/:memberId', async (req, res) => {
  try {
    const { chatId, memberId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!permission) return res.status(404).json({ error: 'Чат не найден' });
    if (permission.type === 'private') return res.status(400).json({ error: 'Для личного чата это недоступно' });
    if (!canManageChat(permission)) return res.status(403).json({ error: 'Недостаточно прав' });
    if (memberId === permission.owner_user_id) return res.status(400).json({ error: 'Нельзя удалить владельца' });

    await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, memberId]);
    await emitChatRefresh(req.app, chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
});

router.get('/:chatId/members', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });

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
    res.status(500).json({ error: 'Не удалось получить участников' });
  }
});

module.exports = router;
