const { v4: uuidv4 } = require('uuid');
const { query } = require('./db');

async function isChatMember(chatId, userId) {
  const result = await query(
    'SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND (banned_until IS NULL OR banned_until < NOW())',
    [chatId, userId]
  );
  return result.rows[0] || null;
}

function mapChat(row) {
  if (!row) return null;
  const isPrivate = row.type === 'private';
  const isSaved = isPrivate && !row.peer_id;
  const title = isSaved ? row.title || 'Избранное' : isPrivate ? row.peer_display_name || row.peer_phone || 'Личный чат' : row.title;
  const avatarUrl = isSaved ? row.avatar_url : isPrivate ? row.peer_avatar_url : row.avatar_url;
  const username = isSaved ? null : isPrivate ? row.peer_username : row.username;

  return {
    id: row.id,
    type: row.type,
    isSaved,
    isPublic: Boolean(row.is_public),
    isModeration: row.description === '__system_moderation__',
    title,
    username,
    description: row.description,
    avatarUrl,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    viewerRole: row.viewer_role,
    memberCount: Number(row.member_count || 0),
    archived: Boolean(row.archived),
    favorite: Boolean(row.favorite),
    pinned: Boolean(row.pinned),
    restrictions: {
      membersCanAddMembers: Boolean(row.members_can_add_members),
      membersCanPinMessages: Boolean(row.members_can_pin_messages),
      adminsCanManageMessages: row.admins_can_manage_messages !== false,
      commentsEnabled: Boolean(row.comments_enabled)
    },
    moderation: {
      mutedUntil: row.muted_until,
      muteReason: row.mute_reason,
      bannedUntil: row.banned_until,
      banReason: row.ban_reason
    },
    peer: isPrivate && !isSaved
      ? {
          id: row.peer_id,
          username: row.peer_username,
          displayName: row.peer_display_name,
          phone: row.peer_phone,
          avatarUrl: row.peer_avatar_url
        }
      : null,
    pinnedMessage: row.pinned_message_id
      ? {
          id: row.pinned_message_id,
          content: row.pinned_message_content,
          attachmentName: row.pinned_message_attachment_name,
          createdAt: row.pinned_message_created_at
        }
      : null,
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          content: row.last_message_content,
          attachmentName: row.last_message_attachment,
          createdAt: row.last_message_at
        }
      : null
  };
}

function baseChatSelect() {
  return `SELECT
      c.*,
      cm.role AS viewer_role,
      cm.archived,
      cm.favorite,
      cm.pinned,
      cm.muted_until,
      cm.mute_reason,
      cm.banned_until,
      cm.ban_reason,
      cm.muted_until,
      cm.mute_reason,
      cm.banned_until,
      cm.ban_reason,
      peer.id AS peer_id,
      peer.username AS peer_username,
      peer.display_name AS peer_display_name,
      peer.phone AS peer_phone,
      peer.avatar_url AS peer_avatar_url,
      lm.id AS last_message_id,
      lm.content AS last_message_content,
      lm.attachment_name AS last_message_attachment,
      lm.created_at AS last_message_at,
      pm.id AS pinned_message_id,
      pm.content AS pinned_message_content,
      pm.attachment_name AS pinned_message_attachment_name,
      pm.created_at AS pinned_message_created_at,
      (SELECT COUNT(*)::int FROM chat_members x WHERE x.chat_id = c.id) AS member_count
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND (cm.banned_until IS NULL OR cm.banned_until < NOW())
    LEFT JOIN LATERAL (
      SELECT u.id, u.username, u.display_name, u.phone, u.avatar_url
      FROM chat_members x
      JOIN users u ON u.id = x.user_id
      WHERE x.chat_id = c.id AND u.id <> $1
      LIMIT 1
    ) peer ON c.type = 'private'
    LEFT JOIN LATERAL (
      SELECT m.*
      FROM messages m
      WHERE m.chat_id = c.id AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    LEFT JOIN messages pm ON pm.id = c.pinned_message_id`;
}

async function getChatById(chatId, viewerUserId) {
  const result = await query(`${baseChatSelect()} WHERE c.id = $2`, [viewerUserId, chatId]);
  return mapChat(result.rows[0]);
}

async function getUserChatIds(userId) {
  const result = await query('SELECT chat_id FROM chat_members WHERE user_id = $1', [userId]);
  return result.rows.map((row) => row.chat_id);
}

async function listChats(userId) {
  const result = await query(
    `SELECT
      c.*,
      cm.role AS viewer_role,
      cm.archived,
      cm.favorite,
      cm.pinned,
      peer.id AS peer_id,
      peer.username AS peer_username,
      peer.display_name AS peer_display_name,
      peer.phone AS peer_phone,
      peer.avatar_url AS peer_avatar_url,
      lm.id AS last_message_id,
      lm.content AS last_message_content,
      lm.attachment_name AS last_message_attachment,
      lm.created_at AS last_message_at,
      pm.id AS pinned_message_id,
      pm.content AS pinned_message_content,
      pm.attachment_name AS pinned_message_attachment_name,
      pm.created_at AS pinned_message_created_at,
      (SELECT COUNT(*)::int FROM chat_members x WHERE x.chat_id = c.id) AS member_count,
      (SELECT COUNT(*)::int FROM messages m2 WHERE m2.chat_id = c.id AND m2.deleted_at IS NULL AND m2.created_at > cm.last_read_at AND m2.user_id <> $1) AS unread_count
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND (cm.banned_until IS NULL OR cm.banned_until < NOW())
    LEFT JOIN LATERAL (
      SELECT u.id, u.username, u.display_name, u.phone, u.avatar_url
      FROM chat_members x
      JOIN users u ON u.id = x.user_id
      WHERE x.chat_id = c.id AND u.id <> $1
      LIMIT 1
    ) peer ON c.type = 'private'
    LEFT JOIN LATERAL (
      SELECT m.*
      FROM messages m
      WHERE m.chat_id = c.id AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    LEFT JOIN messages pm ON pm.id = c.pinned_message_id
    ORDER BY cm.pinned DESC, cm.favorite DESC, cm.archived ASC, COALESCE(lm.created_at, c.created_at) DESC`,
    [userId]
  );
  return result.rows.map((row) => ({ ...mapChat(row), unreadCount: Number(row.unread_count || 0) }));
}

async function findOrCreatePrivateChat(userIdA, userIdB) {
  const existing = await query(
    `SELECT c.id
     FROM chats c
     JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
     JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
     WHERE c.type = 'private'
       AND (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) = 2
     LIMIT 1`,
    [userIdA, userIdB]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const chatId = uuidv4();
  await query('INSERT INTO chats (id, type, owner_user_id) VALUES ($1, $2, $3)', [chatId, 'private', userIdA]);
  await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [chatId, userIdA, 'owner', userIdB, 'member']);
  return chatId;
}

async function findOrCreateSavedChat(userId) {
  const existing = await query(
    `SELECT c.id
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
     WHERE c.type = 'private'
       AND c.title = 'Избранное'
       AND (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) = 1
     LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const chatId = uuidv4();
  await query(
    'INSERT INTO chats (id, type, title, description, owner_user_id) VALUES ($1, $2, $3, $4, $5)',
    [chatId, 'private', 'Избранное', 'Личное облако файлов, голосовых сообщений и заметок', userId]
  );
  await query(
    'INSERT INTO chat_members (chat_id, user_id, role, favorite, pinned) VALUES ($1, $2, $3, $4, $5)',
    [chatId, userId, 'owner', true, true]
  );
  return chatId;
}

async function canPostToChat(chatId, userId) {
  const result = await query(
    `SELECT c.type, cm.role, cm.muted_until, cm.banned_until
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [chatId, userId]
  );
  const row = result.rows[0];
  if (!row) return { allowed: false, reason: 'Вы не состоите в чате' };
  if (row.banned_until && new Date(row.banned_until).getTime() > Date.now()) {
    return { allowed: false, reason: 'Вы заблокированы в этом чате' };
  }
  if (row.muted_until && new Date(row.muted_until).getTime() > Date.now()) {
    return { allowed: false, reason: 'Вы временно лишены возможности писать в этот чат' };
  }
  if (row.type === 'channel' && !['owner', 'admin'].includes(row.role)) {
    return { allowed: false, reason: 'Писать в канал может только владелец или администратор' };
  }
  return { allowed: true, role: row.role, type: row.type };
}

function mapMessageRow(msg, reactionsMap) {
  return {
    id: msg.id,
    chatId: msg.chat_id,
    userId: msg.user_id,
    author: {
      id: msg.user_id,
      username: msg.username,
      displayName: msg.display_name,
      phone: msg.phone,
      avatarUrl: msg.avatar_url
    },
    forwardedFrom: msg.forwarded_from_user_id
      ? {
          userId: msg.forwarded_from_user_id,
          username: msg.forwarded_from_username,
          displayName: msg.forwarded_from_name,
          phone: msg.forwarded_from_phone,
          messageId: msg.forwarded_from_message_id
        }
      : null,
    content: msg.deleted_at ? 'Сообщение удалено' : msg.content,
    albumId: msg.album_id,
    messageType: msg.message_type,
    attachmentUrl: msg.attachment_url,
    attachmentName: msg.attachment_name,
    replyToMessageId: msg.reply_to_message_id,
    replyPreview: msg.reply_to_message_id
      ? {
          content: msg.reply_content,
          attachmentName: msg.reply_attachment_name,
          authorName: msg.reply_author_name || msg.reply_author_username || msg.reply_author_phone
        }
      : null,
    createdAt: msg.created_at,
    editedAt: msg.edited_at,
    deletedAt: msg.deleted_at,
    reactions: reactionsMap.get(msg.id) || [],
    delivery: {
      deliveredCount: Number(msg.delivered_count || 0),
      readCount: Number(msg.read_count || 0)
    },
    commentsCount: Number(msg.comments_count || 0),
    report: msg.report_id ? {
      id: msg.report_id,
      status: msg.report_status,
      reason: msg.report_reason,
      details: msg.report_details,
      chatId: msg.report_chat_id,
      messageId: msg.report_message_id,
      reportedUserId: msg.report_reported_user_id,
      reporterName: msg.report_reporter_name || msg.report_reporter_username,
      reportedName: msg.report_reported_name || msg.report_reported_username
    } : null
  };
}

function messageSelect() {
  return `SELECT
      m.*,
      u.username,
      u.display_name,
      u.phone,
      u.avatar_url,
      rm.content AS reply_content,
      rm.attachment_name AS reply_attachment_name,
      ru.username AS reply_author_username,
      ru.display_name AS reply_author_name,
      ru.phone AS reply_author_phone,
      fu.username AS forwarded_from_username,
      fu.display_name AS forwarded_from_name,
      fu.phone AS forwarded_from_phone,
      r.id AS report_id,
      r.status AS report_status,
      r.reason AS report_reason,
      r.details AS report_details,
      r.chat_id AS report_chat_id,
      r.message_id AS report_message_id,
      r.reported_user_id AS report_reported_user_id,
      reporter.display_name AS report_reporter_name,
      reporter.username AS report_reporter_username,
      reported.display_name AS report_reported_name,
      reported.username AS report_reported_username,
      (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id <> m.user_id) AS delivered_count,
      (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id <> m.user_id AND cm.last_read_at >= m.created_at) AS read_count,
      (SELECT COUNT(*)::int FROM messages x WHERE x.reply_to_message_id = m.id AND x.deleted_at IS NULL) AS comments_count
     FROM messages m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
     LEFT JOIN users ru ON ru.id = rm.user_id
     LEFT JOIN users fu ON fu.id = m.forwarded_from_user_id
     LEFT JOIN user_reports r ON r.id = m.report_id
     LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
     LEFT JOIN users reported ON reported.id = r.reported_user_id`;
}

async function formatMessage(messageId) {
  const result = await query(`${messageSelect()} WHERE m.id = $1`, [messageId]);
  const msg = result.rows[0];
  if (!msg) return null;
  const reactionsResult = await query('SELECT message_id, user_id, emoji, created_at FROM reactions WHERE message_id = $1 ORDER BY created_at ASC', [messageId]);
  const reactionsMap = new Map([[messageId, reactionsResult.rows]]);
  return mapMessageRow(msg, reactionsMap);
}

async function listMessages(chatId, userId, limit = 50) {
  await query('UPDATE chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  const result = await query(
    `${messageSelect()}
     WHERE m.chat_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [chatId, limit]
  );
  const rows = result.rows.reverse();
  if (!rows.length) return [];
  const messageIds = rows.map((row) => row.id);
  const reactionsResult = await query(
    'SELECT message_id, user_id, emoji, created_at FROM reactions WHERE message_id = ANY($1::text[]) ORDER BY created_at ASC',
    [messageIds]
  );
  const reactionsMap = new Map();
  reactionsResult.rows.forEach((reaction) => {
    const list = reactionsMap.get(reaction.message_id) || [];
    list.push(reaction);
    reactionsMap.set(reaction.message_id, list);
  });
  return rows.map((msg) => mapMessageRow(msg, reactionsMap));
}

module.exports = {
  isChatMember,
  getChatById,
  getUserChatIds,
  listChats,
  findOrCreatePrivateChat,
  findOrCreateSavedChat,
  canPostToChat,
  formatMessage,
  listMessages,
  mapChat
};
