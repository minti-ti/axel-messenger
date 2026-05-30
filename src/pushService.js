/**
 * Web Push (VAPID) — единая точка работы с браузерными push-уведомлениями.
 *
 * Поток данных:
 *   1. Клиент в браузере просит у Notification API разрешение.
 *   2. Клиент подписывается через ServiceWorker.PushManager → получает
 *      PushSubscription { endpoint, keys: { p256dh, auth } }.
 *   3. Эту подписку клиент POST'ит на /api/users/me/push-subscriptions.
 *   4. Этот модуль сохраняет её в БД.
 *   5. Когда приходит новое сообщение, server-side вызывает sendPushToUser():
 *        — берём все его подписки из БД,
 *        — на каждый endpoint отправляем зашифрованный payload через web-push,
 *        — если push-сервис вернул 404/410 (Gone) — удаляем подписку,
 *          она больше не валидна (юзер отозвал, очистил кэш и т.д.).
 *
 * ВАЖНО про производительность:
 *   sendPushToUser() — fire-and-forget, не блокирует ответ HTTP.
 *   Если у пользователя N браузеров — будет N HTTP-запросов параллельно
 *   к push-сервисам Google/Mozilla/Apple. Это нормально, web-push сам
 *   делает это асинхронно. Главное — не await'ить результат в HTTP-роуте,
 *   иначе клиент будет ждать «доставки» в чужие браузеры.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('./db');
const config = require('./config');

let webpush = null;
let isConfigured = false;

/**
 * Инициализирует web-push с VAPID-ключами из конфига.
 * Безопасно вызывать многократно: повторные вызовы — no-op.
 * Если ключи не заданы — push отключён, но сервер работает.
 *
 * @returns {boolean} true если push активирован, false если ключей нет
 */
function initPush() {
  if (isConfigured) return true;
  const { publicKey, privateKey, subject } = config.push || {};
  if (!publicKey || !privateKey) {
    return false;
  }
  try {
    // require web-push только если ключи есть, чтобы dev без npm install
    // зависимости не падал на require-этапе.
    // eslint-disable-next-line global-require
    webpush = require('web-push');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    isConfigured = true;
    return true;
  } catch (error) {
    console.error('[push] failed to init web-push:', error.message);
    return false;
  }
}

/**
 * Проверка готовности push (для роутов, чтобы возвращать 503 если выключен).
 */
function isPushReady() {
  return isConfigured;
}

/**
 * Публичный VAPID-ключ. Клиент использует его при PushManager.subscribe().
 * @returns {string|null}
 */
function getPublicKey() {
  return isConfigured ? config.push.publicKey : null;
}

/**
 * Сохраняет подписку для пользователя.
 * Если endpoint уже есть в БД (тот же браузер) — обновляем владельца и ключи.
 *
 * @param {string} userId
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
 * @param {string} [userAgent]
 * @returns {Promise<{id: string}>}
 */
async function saveSubscription(userId, subscription, userAgent = '') {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    const err = new Error('Некорректная подписка');
    err.statusCode = 400;
    throw err;
  }

  const id = uuidv4();
  const truncatedUA = String(userAgent || '').slice(0, 240);

  // ON CONFLICT (endpoint) — если этот же браузер уже подписан, перевешиваем
  // подписку на актуального пользователя и обновляем ключи (они могли быть
  // ротированы Push-сервисом).
  const result = await query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, last_used_at, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)
     ON CONFLICT (endpoint)
     DO UPDATE SET user_id = EXCLUDED.user_id,
                   p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth,
                   user_agent = EXCLUDED.user_agent,
                   last_used_at = NOW(),
                   last_error = NULL
     RETURNING id`,
    [id, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, truncatedUA]
  );
  return { id: result.rows[0].id };
}

/**
 * Удаляет подписку конкретного пользователя по endpoint.
 * Удаление ограничено владельцем, чтобы нельзя было «отписать чужого».
 */
async function deleteSubscription(userId, endpoint) {
  if (!endpoint) {
    const err = new Error('endpoint обязателен');
    err.statusCode = 400;
    throw err;
  }
  await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, endpoint]
  );
}

/**
 * Список подписок пользователя (для UI и удаления через сервер).
 */
async function listUserSubscriptions(userId) {
  const result = await query(
    `SELECT id, endpoint, user_agent, created_at, last_used_at, last_error
     FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.user_agent || '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error
  }));
}

/**
 * Отправляет push на все подписки пользователя.
 * НЕ бросает исключения — все ошибки логируются, чтобы не ронять HTTP-роуты.
 *
 * @param {string} userId
 * @param {{title: string, body: string, url?: string, tag?: string, icon?: string}} payload
 *   url — куда отправить пользователя по клику; tag — для группировки/замены
 *   ранее показанных уведомлений (например, `chat:UUID`).
 * @returns {Promise<{sent: number, removed: number, failed: number}>}
 */
async function sendPushToUser(userId, payload) {
  if (!isConfigured) return { sent: 0, removed: 0, failed: 0 };

  const result = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (!result.rows.length) return { sent: 0, removed: 0, failed: 0 };

  // Сериализуем payload один раз — у разных подписок он одинаковый.
  // Ограничиваем размер: web-push рекомендует <= 4 KB, но реально лучше <2 KB.
  const safePayload = JSON.stringify({
    title: String(payload?.title || 'Новое уведомление').slice(0, 120),
    body: String(payload?.body || '').slice(0, 240),
    url: String(payload?.url || '/').slice(0, 400),
    tag: payload?.tag ? String(payload.tag).slice(0, 80) : undefined,
    icon: payload?.icon ? String(payload.icon).slice(0, 400) : undefined,
    timestamp: Date.now()
  });

  const stats = { sent: 0, removed: 0, failed: 0 };

  await Promise.all(result.rows.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    try {
      await webpush.sendNotification(subscription, safePayload, {
        TTL: 60 * 60 * 24, // сутки — push-сервис может буферизировать
        urgency: 'high'
      });
      stats.sent += 1;
      // last_used_at обновим лениво, чтобы не плодить N UPDATE на каждый push.
      // Достаточно вызывать раз в N часов либо при ошибке.
    } catch (error) {
      const status = error.statusCode || 0;
      // 404 Not Found, 410 Gone — подписка протухла окончательно
      if (status === 404 || status === 410) {
        try {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
          stats.removed += 1;
        } catch (delErr) {
          console.error('[push] delete stale subscription failed:', delErr.message);
        }
        return;
      }
      // Все остальные ошибки (413, 429, 5xx) — оставляем подписку, логируем
      stats.failed += 1;
      const reason = (error.body || error.message || String(error)).slice(0, 240);
      try {
        await query(
          'UPDATE push_subscriptions SET last_error = $2 WHERE id = $1',
          [row.id, reason]
        );
      } catch (_) { /* ignore */ }
      if (!config.isProduction) {
        console.warn(`[push] send failed (status=${status}):`, reason);
      }
    }
  }));

  return stats;
}

/**
 * Хелпер для отправки уведомлений нескольким пользователям сразу
 * (например, всем участникам чата). Возвращает агрегированную статистику.
 */
async function sendPushToUsers(userIds, payload) {
  const agg = { sent: 0, removed: 0, failed: 0 };
  await Promise.all(userIds.map(async (uid) => {
    const s = await sendPushToUser(uid, payload);
    agg.sent += s.sent;
    agg.removed += s.removed;
    agg.failed += s.failed;
  }));
  return agg;
}

module.exports = {
  initPush,
  isPushReady,
  getPublicKey,
  saveSubscription,
  deleteSubscription,
  listUserSubscriptions,
  sendPushToUser,
  sendPushToUsers
};
