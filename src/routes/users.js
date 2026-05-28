const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const { authMiddleware } = require('../auth');
const { formatPublicUser, normalizeUsername, isValidUsername } = require('../utils');
const { onlineUsers } = require('../socket');
const { saveUpload } = require('../storage');
const { createModerationReportMessage, refreshModerationReportMessage, ensureModerationChat } = require('../moderationService');
const config = require('../config');

const router = express.Router();

if (!fs.existsSync(config.uploadsDir)) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}

function allowAvatar(file, cb) {
  if (!String(file.mimetype || '').startsWith('image/')) return cb(new Error('Разрешены только изображения'));
  cb(null, true);
}

const upload = multer({ storage: multer.memoryStorage(), fileFilter: (_, file, cb) => allowAvatar(file, cb), limits: { fileSize: 5 * 1024 * 1024 } });
const jsonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function mapSettings(row) {
  return {
    theme: row?.theme || 'dark',
    compactChats: Boolean(row?.compact_chats),
    sendOnEnter: row?.send_on_enter !== false,
    showPreviews: row?.show_previews !== false,
    accentColor: row?.accent_color || '#4da3ff',
    showFavoriteTab: row?.show_favorite_tab !== false,
    showArchiveTab: row?.show_archive_tab !== false,
    phoneVisibility: row?.phone_visibility || 'everyone',
    lastSeenVisibility: row?.last_seen_visibility || 'everyone',
    allowUsernameLookup: row?.allow_username_lookup !== false,
    notificationsEnabled: row?.notifications_enabled !== false,
    notifyMentions: row?.notify_mentions !== false,
    notifyPrivateChats: row?.notify_private_chats !== false,
    notifyGroups: row?.notify_groups !== false,
    notifySound: row?.notify_sound !== false
  };
}

async function getOrCreateSettings(userId) {
  const result = await query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  if (result.rows[0]) return result.rows[0];
  const insert = await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *', [userId]);
  if (insert.rows[0]) return insert.rows[0];
  const fallback = await query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  return fallback.rows[0];
}

async function ensureUniqueUsername(username, excludeUserId = null) {
  if (!username) return;
  const result = await query(
    `SELECT id FROM users WHERE LOWER(username) = LOWER($1) ${excludeUserId ? 'AND id <> $2' : ''} LIMIT 1`,
    excludeUserId ? [username, excludeUserId] : [username]
  );
  if (result.rows[0]) {
    const error = new Error('Этот username уже занят');
    error.statusCode = 409;
    throw error;
  }
}

function canSeeField(viewerId, ownerId, visibility) {
  if (viewerId && viewerId === ownerId) return true;
  return visibility !== 'nobody';
}

function buildProfile(user, settings, viewerId, sharedChatsCount) {
  const base = formatPublicUser(user);
  return {
    ...base,
    phone: canSeeField(viewerId, user.id, settings.phone_visibility) ? base.phone : null,
    lastSeen: canSeeField(viewerId, user.id, settings.last_seen_visibility) ? base.lastSeen : null,
    isSelf: viewerId === user.id,
    isOnline: onlineUsers.has(user.id),
    sharedChatsCount: Number(sharedChatsCount || 0)
  };
}

async function loadProfileByUsername(username, viewerId = null) {
  const result = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  const user = result.rows[0];
  if (!user) return null;
  const settings = await getOrCreateSettings(user.id);
  if (viewerId !== user.id && settings.allow_username_lookup === false) {
    return { blocked: true };
  }
  const sharedChats = viewerId
    ? await query(
        `SELECT COUNT(*)::int AS count
         FROM chat_members a
         JOIN chat_members b ON b.chat_id = a.chat_id
         WHERE a.user_id = $1 AND b.user_id = $2`,
        [viewerId, user.id]
      )
    : { rows: [{ count: 0 }] };
  return buildProfile(user, settings, viewerId, sharedChats.rows[0]?.count);
}

async function listFolders(userId) {
  const folders = await query('SELECT * FROM user_folders WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC', [userId]);
  if (!folders.rows.length) return [];
  const ids = folders.rows.map((row) => row.id);
  const links = await query('SELECT folder_id, chat_id FROM user_folder_chats WHERE folder_id = ANY($1::text[])', [ids]);
  const map = new Map();
  links.rows.forEach((row) => {
    const list = map.get(row.folder_id) || [];
    list.push(row.chat_id);
    map.set(row.folder_id, list);
  });
  return folders.rows.map((row) => ({ id: row.id, name: row.name, chatIds: map.get(row.id) || [] }));
}

async function replaceFolders(userId, folders) {
  await query('DELETE FROM user_folders WHERE user_id = $1', [userId]);
  for (let i = 0; i < folders.length; i += 1) {
    const folder = folders[i];
    await query('INSERT INTO user_folders (id, user_id, name, sort_order) VALUES ($1, $2, $3, $4)', [folder.id, userId, folder.name, i]);
    for (const chatId of folder.chatIds || []) {
      await query('INSERT INTO user_folder_chats (folder_id, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [folder.id, chatId]);
    }
  }
}

router.get('/public/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const profile = await loadProfileByUsername(username, null);
    if (!profile) return res.status(404).json({ error: 'Пользователь не найден' });
    if (profile.blocked) return res.status(403).json({ error: 'Пользователь скрыл публичный профиль по username' });
    res.json({ user: profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить публичный профиль' });
  }
});

router.use(authMiddleware);

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const plain = q.replace(/^@+/, '');
    const result = await query(
      `SELECT u.*
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       WHERE u.id <> $1
         AND (
           LOWER(u.display_name) LIKE LOWER($2)
           OR u.phone LIKE $2
           OR ((COALESCE(s.allow_username_lookup, TRUE) = TRUE) AND LOWER(COALESCE(u.username, '')) LIKE LOWER($3))
         )
       ORDER BY u.display_name ASC
       LIMIT 20`,
      [req.user.id, `%${q}%`, `%${plain}%`]
    );
    res.json({ users: result.rows.map(formatPublicUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось выполнить поиск' });
  }
});

router.patch('/me', async (req, res) => {
  try {
    const displayName = String(req.body.displayName || '').trim();
    const bio = String(req.body.bio || '').trim();
    const usernameInput = normalizeUsername(req.body.username || '');
    if (!displayName) return res.status(400).json({ error: 'Имя не может быть пустым' });
    if (usernameInput && !isValidUsername(usernameInput)) {
      return res.status(400).json({ error: 'Username должен быть 4-32 символа: латиница, цифры и _' });
    }
    await ensureUniqueUsername(usernameInput || null, req.user.id);
    const result = await query(
      'UPDATE users SET display_name = $2, bio = $3, username = $4 WHERE id = $1 RETURNING *',
      [req.user.id, displayName, bio, usernameInput || null]
    );
    res.json({ user: formatPublicUser(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Не удалось обновить профиль' });
  }
});

router.post('/me/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл аватара не выбран' });
    const stored = await saveUpload(req.file, { folder: 'avatars' });
    const result = await query('UPDATE users SET avatar_url = $2 WHERE id = $1 RETURNING *', [req.user.id, stored.url]);
    res.json({ user: formatPublicUser(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить аватар' });
  }
});

router.get('/me/settings', async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.user.id);
    res.json({ settings: mapSettings(settings) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить настройки' });
  }
});

router.patch('/me/settings', async (req, res) => {
  try {
    const theme = ['dark', 'light', 'telegram'].includes(String(req.body.theme || '').trim()) ? String(req.body.theme || '').trim() : 'dark';
    const compactChats = Boolean(req.body.compactChats);
    const sendOnEnter = req.body.sendOnEnter !== false;
    const showPreviews = req.body.showPreviews !== false;
    const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(req.body.accentColor || '').trim()) ? String(req.body.accentColor || '').trim() : '#4da3ff';
    const showFavoriteTab = req.body.showFavoriteTab !== false;
    const showArchiveTab = req.body.showArchiveTab !== false;
    const phoneVisibility = ['everyone', 'nobody'].includes(String(req.body.phoneVisibility || '').trim()) ? String(req.body.phoneVisibility || '').trim() : 'everyone';
    const lastSeenVisibility = ['everyone', 'nobody'].includes(String(req.body.lastSeenVisibility || '').trim()) ? String(req.body.lastSeenVisibility || '').trim() : 'everyone';
    const allowUsernameLookup = req.body.allowUsernameLookup !== false;
    const result = await query(
      `INSERT INTO user_settings (user_id, theme, compact_chats, send_on_enter, show_previews, accent_color, show_favorite_tab, show_archive_tab, phone_visibility, last_seen_visibility, allow_username_lookup, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         theme = EXCLUDED.theme,
         compact_chats = EXCLUDED.compact_chats,
         send_on_enter = EXCLUDED.send_on_enter,
         show_previews = EXCLUDED.show_previews,
         accent_color = EXCLUDED.accent_color,
         show_favorite_tab = EXCLUDED.show_favorite_tab,
         show_archive_tab = EXCLUDED.show_archive_tab,
         phone_visibility = EXCLUDED.phone_visibility,
         last_seen_visibility = EXCLUDED.last_seen_visibility,
         allow_username_lookup = EXCLUDED.allow_username_lookup,
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, theme, compactChats, sendOnEnter, showPreviews, accentColor, showFavoriteTab, showArchiveTab, phoneVisibility, lastSeenVisibility, allowUsernameLookup]
    );
    res.json({ settings: mapSettings(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось сохранить настройки' });
  }
});

router.get('/moderation/chat', async (req, res) => {
  try {
    if (!ensureSuperadmin(req, res)) return;
    const chat = await ensureModerationChat();
    res.json({ chatId: chat.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось открыть чат модерации' });
  }
});

router.post('/moderation/reports/:reportId/action', async (req, res) => {
  try {
    if (!ensureSuperadmin(req, res)) return;
    const action = String(req.body.action || '').trim();
    const reportResult = await query('SELECT * FROM user_reports WHERE id = $1', [req.params.reportId]);
    const report = reportResult.rows[0];
    if (!report) return res.status(404).json({ error: 'Жалоба не найдена' });

    if (action === 'review') {
      await query('UPDATE user_reports SET status = $2, updated_at = NOW() WHERE id = $1', [report.id, 'reviewing']);
    } else if (action === 'resolve') {
      await query('UPDATE user_reports SET status = $2, updated_at = NOW() WHERE id = $1', [report.id, 'resolved']);
    } else if (action === 'dismiss') {
      await query('UPDATE user_reports SET status = $2, updated_at = NOW() WHERE id = $1', [report.id, 'dismissed']);
    } else if (action === 'mute_60' || action === 'ban_1440') {
      if (!report.chat_id || !report.reported_user_id) return res.status(400).json({ error: 'Для этой жалобы нельзя применить ограничение' });
      const minutes = action === 'mute_60' ? 60 : 1440;
      const mode = action === 'mute_60' ? 'mute' : 'ban';
      await query(
        'UPDATE chat_members SET muted_until = $3, mute_reason = $4, banned_until = $5, ban_reason = $6 WHERE chat_id = $1 AND user_id = $2',
        [report.chat_id, report.reported_user_id, mode === 'mute' ? new Date(Date.now() + minutes*60000) : null, mode === 'mute' ? `Жалоба: ${report.reason}` : null, mode === 'ban' ? new Date(Date.now() + minutes*60000) : null, mode === 'ban' ? `Жалоба: ${report.reason}` : null]
      );
      await query('UPDATE user_reports SET status = $2, updated_at = NOW() WHERE id = $1', [report.id, 'resolved']);
    }

    await refreshModerationReportMessage(req.app, report.id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось выполнить действие модерации' });
  }
});

router.get('/me/folders', async (req, res) => {
  try {
    res.json({ folders: await listFolders(req.user.id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить папки чатов' });
  }
});

function ensureSuperadmin(req, res) {
  if (req.user?.isSuperadmin) return true;
  res.status(403).json({ error: 'Недостаточно прав модератора' });
  return false;
}

router.post('/reports', async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const details = String(req.body.details || '').trim();
    const reportedUserId = req.body.reportedUserId || null;
    const chatId = req.body.chatId || null;
    const messageId = req.body.messageId || null;
    if (!reason) return res.status(400).json({ error: 'Укажите причину жалобы' });
    const id = require('uuid').v4();
    await query(
      `INSERT INTO user_reports (id, reporter_user_id, reported_user_id, chat_id, message_id, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.user.id, reportedUserId, chatId, messageId, reason, details]
    );
    await createModerationReportMessage(req.app, id);
    res.status(201).json({ ok: true, reportId: id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отправить жалобу' });
  }
});

router.get('/moderation/reports', async (req, res) => {
  try {
    if (!ensureSuperadmin(req, res)) return;
    const result = await query(
      `SELECT r.*,
              reporter.display_name AS reporter_name, reporter.username AS reporter_username,
              reported.display_name AS reported_name, reported.username AS reported_username
       FROM user_reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
       LEFT JOIN users reported ON reported.id = r.reported_user_id
       ORDER BY CASE r.status WHEN 'open' THEN 1 WHEN 'reviewing' THEN 2 ELSE 3 END, r.created_at DESC
       LIMIT 200`
    );
    res.json({ reports: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить жалобы' });
  }
});

router.patch('/moderation/reports/:reportId', async (req, res) => {
  try {
    if (!ensureSuperadmin(req, res)) return;
    const status = ['open','reviewing','resolved','dismissed'].includes(String(req.body.status || '').trim()) ? String(req.body.status || '').trim() : 'reviewing';
    const resolutionNote = String(req.body.resolutionNote || '').trim();
    const result = await query(
      'UPDATE user_reports SET status = $2, resolution_note = $3, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.reportId, status, resolutionNote]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Жалоба не найдена' });
    await refreshModerationReportMessage(req.app, req.params.reportId);
    res.json({ report: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось обновить жалобу' });
  }
});

router.put('/me/folders', async (req, res) => {
  try {
    const folders = Array.isArray(req.body.folders) ? req.body.folders : [];
    const sanitized = folders
      .map((folder, index) => ({
        id: String(folder.id || '').trim(),
        name: String(folder.name || '').trim(),
        chatIds: Array.isArray(folder.chatIds) ? folder.chatIds.map((id) => String(id || '').trim()).filter(Boolean) : []
      }))
      .filter((folder) => folder.id && folder.name)
      .slice(0, 20);
    await replaceFolders(req.user.id, sanitized);
    res.json({ folders: await listFolders(req.user.id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось сохранить папки чатов' });
  }
});

router.get('/me/export', async (req, res) => {
  try {
    const settings = mapSettings(await getOrCreateSettings(req.user.id));
    const folders = await listFolders(req.user.id);
    const draftsResult = await query('SELECT chat_id, content, updated_at FROM user_drafts WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.id]);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: req.user,
      settings,
      folders,
      drafts: draftsResult.rows.map((row) => ({ chatId: row.chat_id, content: row.content, updatedAt: row.updated_at }))
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=arena-export-${req.user.id}.json`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось экспортировать данные' });
  }
});

router.post('/me/import', jsonUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const data = JSON.parse(req.file.buffer.toString('utf8'));
    if (data.settings) {
      await query(
        `INSERT INTO user_settings (user_id, theme, compact_chats, send_on_enter, show_previews, accent_color, show_favorite_tab, show_archive_tab, phone_visibility, last_seen_visibility, allow_username_lookup, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET theme = EXCLUDED.theme, compact_chats = EXCLUDED.compact_chats, send_on_enter = EXCLUDED.send_on_enter, show_previews = EXCLUDED.show_previews, accent_color = EXCLUDED.accent_color, show_favorite_tab = EXCLUDED.show_favorite_tab, show_archive_tab = EXCLUDED.show_archive_tab, phone_visibility = EXCLUDED.phone_visibility, last_seen_visibility = EXCLUDED.last_seen_visibility, allow_username_lookup = EXCLUDED.allow_username_lookup, updated_at = NOW()`,
        [
          req.user.id,
          data.settings.theme || 'dark',
          Boolean(data.settings.compactChats),
          data.settings.sendOnEnter !== false,
          data.settings.showPreviews !== false,
          data.settings.accentColor || '#4da3ff',
          data.settings.showFavoriteTab !== false,
          data.settings.showArchiveTab !== false,
          data.settings.phoneVisibility || 'everyone',
          data.settings.lastSeenVisibility || 'everyone',
          data.settings.allowUsernameLookup !== false
        ]
      );
    }
    if (Array.isArray(data.folders)) await replaceFolders(req.user.id, data.folders);
    if (Array.isArray(data.drafts)) {
      await query('DELETE FROM user_drafts WHERE user_id = $1', [req.user.id]);
      for (const draft of data.drafts) {
        if (!draft.chatId || !draft.content) continue;
        await query('INSERT INTO user_drafts (user_id, chat_id, content, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, chat_id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()', [req.user.id, draft.chatId, draft.content]);
      }
    }
    res.json({ ok: true, settings: mapSettings(await getOrCreateSettings(req.user.id)), folders: await listFolders(req.user.id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось импортировать данные' });
  }
});

router.get('/username/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const profile = await loadProfileByUsername(username, req.user.id);
    if (!profile) return res.status(404).json({ error: 'Пользователь не найден' });
    if (profile.blocked) return res.status(403).json({ error: 'Пользователь скрыл поиск по username' });
    res.json({ user: profile });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить профиль по username' });
  }
});

router.get('/:userId', async (req, res) => {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const settings = await getOrCreateSettings(user.id);
    const sharedChats = await query(
      `SELECT COUNT(*)::int AS count
       FROM chat_members a
       JOIN chat_members b ON b.chat_id = a.chat_id
       WHERE a.user_id = $1 AND b.user_id = $2`,
      [req.user.id, req.params.userId]
    );
    res.json({ user: buildProfile(user, settings, req.user.id, sharedChats.rows[0]?.count) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить профиль пользователя' });
  }
});

module.exports = router;
