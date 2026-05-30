const express = require('express');
const { query } = require('../db');
const { normalizeUsername, formatPublicUser } = require('../utils');
const { onlineUsers } = require('../socket');

const router = express.Router();

async function getSettings(userId) {
  const result = await query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  return result.rows[0] || {
    phone_visibility: 'everyone',
    last_seen_visibility: 'everyone',
    allow_username_lookup: true
  };
}

router.get('/users/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const result = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const settings = await getSettings(user.id);
    if (settings.allow_username_lookup === false) {
      return res.status(403).json({ error: 'Публичный профиль скрыт владельцем' });
    }

    const base = formatPublicUser(user);
    res.json({
      user: {
        ...base,
        phone: settings.phone_visibility === 'everyone' ? base.phone : null,
        lastSeen: settings.last_seen_visibility === 'everyone' ? base.lastSeen : null,
        isOnline: onlineUsers.has(user.id)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить публичный профиль' });
  }
});

router.get('/chats/:username', async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const result = await query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = c.id) AS member_count,
              u.display_name AS owner_display_name,
              u.username AS owner_username
       FROM chats c
       LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE LOWER(c.username) = LOWER($1)
         AND c.type IN ('group', 'channel')
       LIMIT 1`,
      [username]
    );
    const chat = result.rows[0];
    if (!chat) return res.status(404).json({ error: 'Публичный чат не найден' });

    res.json({
      chat: {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        username: chat.username,
        description: chat.description,
        avatarUrl: chat.avatar_url,
        memberCount: Number(chat.member_count || 0),
        ownerDisplayName: chat.owner_display_name,
        ownerUsername: chat.owner_username
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось получить публичный чат' });
  }
});


// GET /api/public/link-preview?url=... — OG meta для превью ссылок
router.get('/link-preview', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL обязателен' });

    // Простой fetch с таймаутом
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AxelMessenger/1.0 LinkPreview' }
    });
    clearTimeout(timeout);

    if (!response.ok) return res.json({ title: null });
    const html = await response.text();

    // Парсим OG-теги
    const getOg = (prop) => {
      const match = html.match(new RegExp('<meta[^>]*property=["\'"]og:' + prop + '["\'"\s][^>]*content=["\'"]([^"\']*)["\'"]', 'i'))
        || html.match(new RegExp('<meta[^>]*content=["\'"]([^"\']*)["\'"][^>]*property=["\'"]og:' + prop + '["\'"\s]', 'i'));
      return match ? match[1] : null;
    };
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    res.json({
      title: getOg('title') || (titleMatch ? titleMatch[1].trim() : null),
      description: getOg('description') || null,
      image: getOg('image') || null,
      siteName: getOg('site_name') || null
    });
  } catch (error) {
    res.json({ title: null });
  }
});

module.exports = router;
