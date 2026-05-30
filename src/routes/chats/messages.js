/**
 * Эндпоинты /api/chats для работы с сообщениями.
 *
 * ВНУТРЕННИЙ ПОРЯДОК ВАЖЕН: сначала маршруты с литералами в первом сегменте
 * (/search/messages, /messages/*), потом параметризованные (/:chatId/*).
 * Это гарантирует, что запрос вроде `GET /messages/abc-def-...` попадёт
 * в `GET /messages/:messageId`, а не будет пытаться матчиться против
 * `/:chatId/messages`.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../../db');
const {
  isChatMember,
  canPostToChat,
  getChatById,
  formatMessage,
  listMessages,
  isBlocked
} = require('../../chatService');
const { saveUpload } = require('../../storage');
const {
  upload,
  isRateLimited,
  getChatPermission,
  canPinInChat,
  canModerateMessages,
  classifyAttachment,
  extractLinks,
  emitChatRefresh,
  pushNotifyOfflineMembers
} = require('./_helpers');

const router = express.Router();

// =====================================================================
// 1) Литеральные пути (/search/*, /messages/*)
// =====================================================================

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

router.get('/messages/:messageId/comments', async (req, res) => {
  try {
    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: 'Сообщение не найдено' });
    const member = await isChatMember(source.chat_id, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });
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
    res.status(500).json({ error: 'Не удалось получить комментарии' });
  }
});

router.post('/messages/:messageId/comments', async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Комментарий пустой' });
    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: 'Сообщение не найдено' });
    const permission = await getChatPermission(source.chat_id, req.user.id);
    if (!permission) return res.status(403).json({ error: 'Нет доступа к чату' });
    if (permission.type !== 'channel') return res.status(400).json({ error: 'Комментарии доступны только в каналах' });
    if (!permission.comments_enabled) return res.status(403).json({ error: 'Комментарии для канала отключены' });

    const messageId = uuidv4();
    await query(
      `INSERT INTO messages (id, chat_id, user_id, content, message_type, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, source.chat_id, req.user.id, content, 'text', source.id]
    );
    const message = await formatMessage(messageId);
    req.app.get('io').to(source.chat_id).emit('message:new', message);
    await emitChatRefresh(req.app, source.chat_id);
    // Fire-and-forget: push офлайн-участникам.
    pushNotifyOfflineMembers(req.app, source.chat_id, message).catch(() => {});
    res.status(201).json({ message });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось добавить комментарий' });
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

      const logId = uuidv4();
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
    if (!targetChatId || !messageIds.length || messageIds.length > 100) return res.status(400).json({ error: 'Не выбраны сообщения или чат назначения' });
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
    // Шлём push один раз на последний message — спам N уведомлений за bulk-forward
    // (до 100 сообщений) был бы плохим UX. Receiver всё равно увидит весь пакет
    // при заходе.
    if (created.length) {
      pushNotifyOfflineMembers(req.app, targetChatId, created[created.length - 1]).catch(() => {});
    }
    res.status(201).json({ messages: created });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось переслать сообщения' });
  }
});

// Получить одно сообщение по id. Используется в модерационной панели
// для предварительного просмотра текста перед редактированием.
router.get('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === '') return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
    const result = await query('SELECT chat_id FROM messages WHERE id = $1', [messageId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Сообщение не найдено' });

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
    if (!messageId || messageId.trim() === '') return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Текст не может быть пустым' });

    const result = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });

    const permission = await getChatPermission(message.chat_id, req.user.id);
    const canModerate = canModerateMessages(permission);
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
    res.status(500).json({ error: 'Не удалось отредактировать сообщение' });
  }
});

router.delete('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === '') return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
    const result = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });

    const permission = await getChatPermission(message.chat_id, req.user.id);
    if (!permission && !req.user?.isSuperadmin) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления сообщения' });
    }

    const logId = uuidv4();
    await query(
      'INSERT INTO message_deletion_logs (id, message_id, chat_id, deleted_by_user_id, deleted_at) VALUES ($1, $2, $3, $4, NOW())',
      [logId, messageId, message.chat_id, req.user.id]
    );

    await query('DELETE FROM reactions WHERE message_id = $1', [messageId]);
    await query('DELETE FROM messages WHERE reply_to_message_id = $1', [messageId]);
    await query('DELETE FROM messages WHERE id = $1', [messageId]);

    req.app.get('io').to(message.chat_id).emit('message:deleted', { messageId, chatId: message.chat_id });
    await emitChatRefresh(req.app, message.chat_id);

    res.json({ ok: true, messageId, deletedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось удалить сообщение' });
  }
});

router.post('/messages/:messageId/reactions', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === '') return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Укажите emoji' });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = msgResult.rows[0];
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });

    const member = await isChatMember(message.chat_id, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к сообщению' });

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
    res.status(500).json({ error: 'Не удалось поставить реакцию' });
  }
});

router.post('/messages/:messageId/forward', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!messageId || messageId.trim() === '') return res.status(400).json({ error: 'Некорректный идентификатор сообщения' });
    const targetChatId = String(req.body.targetChatId || '').trim();
    if (!targetChatId) return res.status(400).json({ error: 'Не указан целевой чат' });

    const sourceResult = await query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const source = sourceResult.rows[0];
    if (!source) return res.status(404).json({ error: 'Сообщение не найдено' });
    const sourceMember = await isChatMember(source.chat_id, req.user.id);
    if (!sourceMember) return res.status(403).json({ error: 'Нет доступа к исходному сообщению' });

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
    pushNotifyOfflineMembers(req.app, targetChatId, message).catch(() => {});
    res.status(201).json({ message });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось переслать сообщение' });
  }
});

// =====================================================================
// 2) Параметризованные пути с :chatId
// =====================================================================

router.post('/:chatId/pin/:messageId', async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!canPinInChat(permission)) return res.status(403).json({ error: 'Недостаточно прав для закрепа' });
    const msgResult = await query('SELECT id FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!msgResult.rows[0]) return res.status(404).json({ error: 'Сообщение не найдено' });

    await query('UPDATE chats SET pinned_message_id = $2 WHERE id = $1', [chatId, messageId]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:pinned', chat.pinnedMessage);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось закрепить сообщение' });
  }
});

router.delete('/:chatId/pin', async (req, res) => {
  try {
    const { chatId } = req.params;
    const permission = await getChatPermission(chatId, req.user.id);
    if (!canPinInChat(permission)) return res.status(403).json({ error: 'Недостаточно прав для открепления' });
    await query('UPDATE chats SET pinned_message_id = NULL WHERE id = $1', [chatId]);
    const chat = await getChatById(chatId, req.user.id);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:pinned', null);
    res.json({ chat });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось открепить сообщение' });
  }
});

router.get('/:chatId/media', async (req, res) => {
  try {
    const member = await isChatMember(req.params.chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });

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
          id: row.id + ':' + link,
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
    res.status(500).json({ error: 'Не удалось получить медиа' });
  }
});

router.post('/:chatId/scheduled', async (req, res) => {
  try {
    const permission = await canPostToChat(req.params.chatId, req.user.id);
    if (!permission.allowed) return res.status(403).json({ error: permission.reason });
    const content = String(req.body.content || '').trim();
    const scheduledFor = new Date(req.body.scheduledFor || '');
    if (!content) return res.status(400).json({ error: 'Сообщение пустое' });
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() + 10000) {
      return res.status(400).json({ error: 'Время отложенной отправки должно быть минимум на 10 секунд позже текущего' });
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
    res.status(500).json({ error: 'Не удалось запланировать сообщение' });
  }
});

router.get('/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });
    const messages = await listMessages(chatId, req.user.id, Math.min(Number(req.query.limit || 50), 200));
    await emitChatRefresh(req.app, chatId);
    if (String(req.query.silent || '0') !== '1') {
      req.app.get('io').to(chatId).emit('chat:read', { chatId, userId: req.user.id });
    }
    res.json({ messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить сообщения' });
  }
});

router.post('/:chatId/read', async (req, res) => {
  try {
    const { chatId } = req.params;
    const member = await isChatMember(chatId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Нет доступа к чату' });
    await query('UPDATE chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    await emitChatRefresh(req.app, chatId);
    req.app.get('io').to(chatId).emit('chat:read', { chatId, userId: req.user.id });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отметить прочитанным' });
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
    if (!content && !files.length) return res.status(400).json({ error: 'Сообщение пустое' });
    if (isRateLimited(req.user.id)) return res.status(429).json({ error: 'Слишком частая отправка сообщений. Попробуйте чуть позже.' });
    if (content.length > 10000) return res.status(400).json({ error: 'Сообщение слишком длинное (max 10000 символов)' });

    const createdMessages = [];
    const canCreateAlbum = files.length > 1 && files.every((file) => String(file.mimetype || '').startsWith('image/'));
    const albumId = canCreateAlbum ? uuidv4() : null;

    // Сообщения сохраняются в открытом виде.
    // См. подробный комментарий в исходном chats.js: server-side «E2E» убран
    // как не дающее реальной защиты и при этом ломавшее чтение.
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
    // Один push на сообщение (или альбом — последнее сообщение), не блокируя
    // HTTP-ответ. Если у пользователя открыт чат — push не пошлётся, см.
    // pushNotifyOfflineMembers (фильтрация по live WS-сессии).
    if (createdMessages.length) {
      pushNotifyOfflineMembers(req.app, chatId, createdMessages[createdMessages.length - 1]).catch(() => {});
    }
    res.status(201).json({ message: createdMessages[0], messages: createdMessages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отправить сообщение' });
  }
});

module.exports = router;
