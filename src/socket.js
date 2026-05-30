const { query } = require('./db');
const { getTokenFromSocket, fetchUserById, fetchSession } = require('./auth');
const { getUserChatIds, isChatMember, listChats } = require('./chatService');

const onlineUsers = new Map();
const wsRateLimits = new Map();

function checkWsRateLimit(userId, event, maxCount = 30, windowMs = 60000) {
  const key = `${userId}:${event}`;
  const now = Date.now();
  let record = wsRateLimits.get(key);
  if (!record) {
    record = { count: 1, resetAt: now + windowMs };
    wsRateLimits.set(key, record);
    return true;
  }
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
    return true;
  }
  record.count += 1;
  if (record.count > maxCount) return false;
  return true;
}

async function broadcastPresence(io, userId, isOnline) {
  const chatIds = await getUserChatIds(userId);
  for (const chatId of chatIds) {
    io.to(chatId).emit('presence:update', { userId, isOnline, at: new Date().toISOString() });
  }
}

function attachSocket(io) {
  io.use(async (socket, next) => {
    const payload = getTokenFromSocket(socket);
    if (!payload?.userId) return next(new Error('Unauthorized'));
    const session = await fetchSession(payload.sessionId, payload.userId);
    if (!session) return next(new Error('Unauthorized'));
    const user = await fetchUserById(payload.userId);
    if (!user) return next(new Error('Unauthorized'));
    socket.user = user;
    socket.sessionId = session.id;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

    const chats = await getUserChatIds(userId);
    chats.forEach((chatId) => socket.join(chatId));

    const count = onlineUsers.get(userId) || 0;
    onlineUsers.set(userId, count + 1);
    await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
    await query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1', [socket.sessionId]);
    await broadcastPresence(io, userId, true);

    socket.emit('chats:update', await listChats(userId));

    socket.on('chat:join', async ({ chatId }) => {
      if (!chatId) return;
      if (!checkWsRateLimit(userId, 'chat:join', 20, 60000)) return;
      const member = await isChatMember(chatId, userId);
      if (member) socket.join(chatId);
    });

    socket.on('typing:start', async ({ chatId }) => {
      if (!checkWsRateLimit(userId, 'typing', 30, 60000)) return;
      const member = await isChatMember(chatId, userId);
      if (!member) return;
      socket.to(chatId).emit('typing:update', {
        chatId,
        userId,
        displayName: socket.user.display_name,
        typing: true
      });
    });

    socket.on('typing:stop', async ({ chatId }) => {
      if (!checkWsRateLimit(userId, 'typing', 30, 60000)) return;
      const member = await isChatMember(chatId, userId);
      if (!member) return;
      socket.to(chatId).emit('typing:update', {
        chatId,
        userId,
        displayName: socket.user.display_name,
        typing: false
      });
    });

    socket.on('disconnect', async () => {
      const nextCount = Math.max((onlineUsers.get(userId) || 1) - 1, 0);
      if (nextCount === 0) {
        onlineUsers.delete(userId);
        await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
        await broadcastPresence(io, userId, false);
      } else {
        onlineUsers.set(userId, nextCount);
      }
    });
  });
}

module.exports = {
  attachSocket,
  onlineUsers
};
