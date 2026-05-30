const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { signToken, authMiddleware } = require('../auth');
const { sendLoginCode } = require('../sms');
const { normalizePhone, makeCode, formatPublicUser } = require('../utils');
const { isValidPhone, isValidCode, sanitizeString } = require('../validators');
const config = require('../config');
const { ensureSuperadminModerationMembership } = require('../moderationService');

function hashLoginCode(code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(String(code)).digest('hex');
}

const router = express.Router();

function buildSessionTitle(req) {
  const ua = String(req.headers['user-agent'] || 'Browser');
  return ua.slice(0, 120);
}

async function ensureSuperadmin(user) {
  if (!user) return user;
  if (user.is_superadmin) return user;
  const superadmins = await query('SELECT COUNT(*)::int AS count FROM users WHERE is_superadmin = TRUE');
  const totalUsers = await query('SELECT COUNT(*)::int AS count FROM users');
  const shouldPromote = (config.supportPhone && user.phone === config.supportPhone) || (Number(superadmins.rows[0]?.count || 0) === 0 && Number(totalUsers.rows[0]?.count || 0) <= 1);
  if (!shouldPromote) return user;
  const updated = await query('UPDATE users SET is_superadmin = TRUE WHERE id = $1 RETURNING *', [user.id]);
  return updated.rows[0] || user;
}

router.post('/request-code', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Введите корректный номер телефона' });
    }

    const existingUser = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    const userExists = Boolean(existingUser.rows[0]);
    const code = makeCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await query(
      `INSERT INTO login_codes (phone, code, expires_at, attempts, requested_at)
       VALUES ($1, $2, $3, 0, NOW())
       ON CONFLICT (phone)
       DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, attempts = 0, requested_at = NOW()`,
      [phone, hashLoginCode(code), expiresAt]
    );

    let delivery;
    try {
      delivery = await sendLoginCode(phone, code);
    } catch (error) {
      // Обработка типизированных ошибок из sms.js
      if (error.code === 'NEEDS_BINDING') {
        return res.status(error.statusCode || 400).json({
          error: error.message,
          code: 'NEEDS_BINDING',
          botUsername: config.telegram?.botUsername || null,
          userExists
        });
      }
      if (error.code === 'NO_DELIVERY') {
        return res.status(error.statusCode || 503).json({
          error: error.message,
          code: 'NO_DELIVERY'
        });
      }
      if (error.code === 'TELEGRAM_FAIL') {
        return res.status(error.statusCode || 502).json({
          error: error.message,
          code: 'TELEGRAM_FAIL'
        });
      }
      throw error;
    }

    return res.json({
      ok: true,
      userExists,
      deliveryMode: delivery.mode,
      ...(delivery.mode === 'dev' && config.allowDevCodeResponse && !config.isProduction
          ? { devCode: code }
          : {})
    });
  } catch (error) {
    console.error('[auth] request-code error:', error.message);
    return res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

router.post('/verify-code', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    const displayNameInput = sanitizeString(req.body.displayName || '', 120);

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Введите корректный номер телефона' });
    }
    if (!isValidCode(code)) {
      return res.status(400).json({ error: 'Укажите корректный код подтверждения' });
    }

    const codeResult = await query('SELECT * FROM login_codes WHERE phone = $1', [phone]);
    const stored = codeResult.rows[0];
    if (!stored) {
      return res.status(400).json({ error: 'Код не запрошен' });
    }
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Срок действия кода истёк' });
    }
    if (stored.attempts >= 5) {
      return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код' });
    }
    if (stored.code !== hashLoginCode(code)) {
      await query('UPDATE login_codes SET attempts = attempts + 1 WHERE phone = $1', [phone]);
      return res.status(400).json({ error: 'Неверный код' });
    }

    let userResult = await query('SELECT * FROM users WHERE phone = $1', [phone]);
    let user = userResult.rows[0];
    let isNewUser = false;

    if (!user) {
      if (!displayNameInput) {
        return res.status(400).json({ error: 'Для регистрации укажите имя' });
      }
      const insert = await query(
        'INSERT INTO users (id, phone, display_name) VALUES ($1, $2, $3) RETURNING *',
        [uuidv4(), phone, displayNameInput]
      );
      user = insert.rows[0];
      isNewUser = true;
    }

    user = await ensureSuperadmin(user);
    if (user.is_superadmin) {
      await ensureSuperadminModerationMembership(user.id);
    }

    await query('DELETE FROM login_codes WHERE phone = $1', [phone]);
    await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    const sessionId = uuidv4();
    await query(
      'INSERT INTO user_sessions (id, user_id, title, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, user.id, buildSessionTitle(req), String(req.headers['user-agent'] || ''), String(req.ip || '')]
    );

    const token = signToken(user, sessionId);
    return res.json({
      ok: true,
      token,
      isNewUser,
      user: formatPublicUser(user)
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Не удалось выполнить вход' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

router.post('/logout', authMiddleware, async (req, res) => {
  await query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1', [req.sessionId]);
  res.json({ ok: true });
});

router.get('/sessions', authMiddleware, async (req, res) => {
  const result = await query(
    'SELECT id, title, ip_address, created_at, last_seen_at, revoked_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ sessions: result.rows, currentSessionId: req.sessionId });
});

router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
  await query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2', [req.params.sessionId, req.user.id]);
  res.json({ ok: true });
});

router.post('/logout-all', authMiddleware, async (req, res) => {
  await query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id <> $2', [req.user.id, req.sessionId]);
  res.json({ ok: true, revokedAll: true });
});

module.exports = router;
