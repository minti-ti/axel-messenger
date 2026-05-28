const jwt = require('jsonwebtoken');

const config = require('./config');

const { query } = require('./db');

const { formatPublicUser } = require('./utils');

function signToken(user, sessionId) {
  return jwt.sign({ userId: user.id, sessionId }, config.jwtSecret, { expiresIn: '30d' });
}

async function fetchUserById(userId) {
  const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function fetchSession(sessionId, userId) {
  if (!sessionId) return null;
  const result = await query(
    'SELECT * FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const payload = jwt.verify(token, config.jwtSecret);
    const session = await fetchSession(payload.sessionId, payload.userId);
    if (!session) {
      return res.status(401).json({ error: 'Сессия недействительна' });
    }
    const user = await fetchUserById(payload.userId);
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    await query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1', [session.id]);
    req.user = formatPublicUser(user);
    req.userRaw = user;
    req.sessionId = session.id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

function getTokenFromSocket(socket) {
  const token = socket.handshake?.auth?.token || socket.handshake?.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    return null;
  }
}

module.exports = {
  signToken,
  fetchUserById,
  authMiddleware,
  getTokenFromSocket,
  fetchSession
};
