const { v4: uuidv4 } = require('uuid');
const { query } = require('./db');
const { formatMessage, listChats } = require('./chatService');

const MODERATION_CHAT_DESCRIPTION = '__system_moderation__';

async function getSuperadminIds() {
  const result = await query('SELECT id FROM users WHERE is_superadmin = TRUE');
  return result.rows.map((row) => row.id);
}

async function ensureModerationChat() {
  const existing = await query(
    `SELECT * FROM chats
     WHERE type = 'group' AND description = $1
     LIMIT 1`,
    [MODERATION_CHAT_DESCRIPTION]
  );

  let chat = existing.rows[0];
  const adminIds = await getSuperadminIds();
  if (!chat) {
    const ownerId = adminIds[0] || null;
    const chatId = uuidv4();
    const insert = await query(
      `INSERT INTO chats (id, type, title, description, owner_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [chatId, 'group', 'Жалобы и модерация', MODERATION_CHAT_DESCRIPTION, ownerId]
    );
    chat = insert.rows[0];
  }

  for (const adminId of adminIds) {
    const role = chat.owner_user_id === adminId ? 'owner' : 'admin';
    await query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [chat.id, adminId, role]
    );
  }

  return chat;
}

async function createReportSummary(reportId) {
  const result = await query(
    `SELECT
      r.*,
      reporter.display_name AS reporter_name,
      reporter.username AS reporter_username,
      reported.display_name AS reported_name,
      reported.username AS reported_username,
      m.content AS message_content,
      c.title AS chat_title
     FROM user_reports r
     LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
     LEFT JOIN users reported ON reported.id = r.reported_user_id
     LEFT JOIN messages m ON m.id = r.message_id
     LEFT JOIN chats c ON c.id = r.chat_id
     WHERE r.id = $1`,
    [reportId]
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    details: row.details,
    resolutionNote: row.resolution_note,
    reporterUserId: row.reporter_user_id,
    reporterName: row.reporter_name,
    reporterUsername: row.reporter_username,
    reportedUserId: row.reported_user_id,
    reportedName: row.reported_name,
    reportedUsername: row.reported_username,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    messageId: row.message_id,
    messageContent: row.message_content
  };
}

function makeReportMessageContent(report) {
  const lines = [
    `Новая жалоба: ${report.reason}`,
    `От: ${report.reporterName || report.reporterUsername || 'пользователь'}`,
    `На: ${report.reportedName || report.reportedUsername || 'контент'}`,
    report.chatTitle ? `Чат: ${report.chatTitle}` : null,
    report.messageContent ? `Сообщение: ${report.messageContent}` : null,
    report.details ? `Описание: ${report.details}` : null,
    `Статус: ${report.status}`
  ].filter(Boolean);
  return lines.join('\n');
}

async function emitChatRefresh(io, chatId) {
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  for (const row of members.rows) {
    io.to(`user:${row.user_id}`).emit('chats:update', await listChats(row.user_id));
  }
}

async function createModerationReportMessage(app, reportId) {
  const chat = await ensureModerationChat();
  const report = await createReportSummary(reportId);
  if (!chat || !report) return null;
  const messageId = uuidv4();

  await query(
    `INSERT INTO messages (id, chat_id, user_id, content, message_type, report_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [messageId, chat.id, chat.owner_user_id || report.reporterUserId, makeReportMessageContent(report), 'system', reportId]
  );
  await query('UPDATE user_reports SET moderation_message_id = $2 WHERE id = $1', [reportId, messageId]);

  const formatted = await formatMessage(messageId);
  const io = app.get('io');
  io.to(chat.id).emit('message:new', formatted);
  await emitChatRefresh(io, chat.id);
  return formatted;
}

async function refreshModerationReportMessage(app, reportId) {
  const report = await createReportSummary(reportId);
  if (!report?.moderationMessageId) {
    const reportRow = await query('SELECT moderation_message_id FROM user_reports WHERE id = $1', [reportId]);
    const moderationMessageId = reportRow.rows[0]?.moderation_message_id;
    if (!moderationMessageId) return null;
  }
  const result = await query('SELECT moderation_message_id FROM user_reports WHERE id = $1', [reportId]);
  const moderationMessageId = result.rows[0]?.moderation_message_id;
  if (!moderationMessageId) return null;
  await query('UPDATE messages SET content = $2 WHERE id = $1', [moderationMessageId, makeReportMessageContent(await createReportSummary(reportId))]);
  const formatted = await formatMessage(moderationMessageId);
  const io = app.get('io');
  io.to(formatted.chatId).emit('message:update', formatted);
  await emitChatRefresh(io, formatted.chatId);
  return formatted;
}

async function ensureSuperadminModerationMembership(userId) {
  const chat = await ensureModerationChat();
  if (!chat || !userId) return chat;
  const existing = await query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chat.id, userId]);
  if (!existing.rows[0]) {
    await query(
      'INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)',
      [chat.id, userId, chat.owner_user_id === userId ? 'owner' : 'admin']
    );
  }
  return chat;
}

module.exports = {
  MODERATION_CHAT_DESCRIPTION,
  ensureModerationChat,
  createModerationReportMessage,
  refreshModerationReportMessage,
  ensureSuperadminModerationMembership,
  createReportSummary
};
