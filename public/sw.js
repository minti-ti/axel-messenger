/**
 * Axel Messenger — Service Worker.
 *
 * Минимальный SW, нужен ровно для двух вещей:
 *   1) принять push-уведомление от Web Push API и показать его,
 *   2) при клике перевести пользователя в нужный чат / открыть приложение.
 *
 * Никакого offline-кэширования здесь сознательно нет: это отдельная задача
 * (PWA), и она требует продуманной инвалидации. Сейчас SW — просто «push-
 * приёмник».
 *
 * Контракт сообщения от сервера (см. pushService.js):
 *   { title: string, body: string, url?: string, tag?: string, icon?: string,
 *     timestamp: number }
 */

/* eslint-env serviceworker */

// При обновлении SW сразу активируем новую версию, не дожидаясь закрытия
// всех вкладок — иначе пользователь будет видеть старую версию неделями.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Основной обработчик push.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (_) {
    // Если payload не JSON (например, тестовая отправка из DevTools) —
    // просто покажем заглушку.
    data = { title: 'Axel Messenger', body: event.data ? event.data.text() : '' };
  }

  const title = String(data.title || 'Новое сообщение').slice(0, 120);
  const options = {
    body: String(data.body || '').slice(0, 240),
    icon: data.icon || '/favicon.ico',
    badge: data.icon || '/favicon.ico',
    // tag нужен, чтобы новые сообщения из того же чата ЗАМЕНЯЛИ предыдущее
    // уведомление, а не накапливали 50 копий.
    tag: data.tag || 'axel-message',
    renotify: Boolean(data.tag),
    timestamp: Number(data.timestamp) || Date.now(),
    data: {
      url: data.url || '/',
      tag: data.tag || null
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Клик по уведомлению — пытаемся вернуть существующую вкладку приложения,
// иначе открываем новую. notification.data.url задаётся сервером и обычно
// выглядит как /?chat=<chatId> — фронт это распарсит и откроет нужный чат.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // Если открытая вкладка с нашим origin уже есть — сфокусируем её и
    // отправим сообщение, чтобы фронт переключился на нужный чат без
    // полного перезагруза.
    for (const client of allClients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          client.postMessage({
            type: 'push:navigate',
            url: targetUrl,
            tag: event.notification.data?.tag || null
          });
          return;
        }
      } catch (_) { /* ignore malformed urls */ }
    }

    // Нет открытой вкладки — открываем новую.
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// Когда push-сервис отзывает подписку (пользователь выключил уведомления в
// настройках браузера / очистил данные сайта) — пытаемся переподписаться
// тем же applicationServerKey. Если фронт онлайн — он отдельно вызовет
// /api/users/me/push-subscriptions, чтобы синхронизировать БД.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const oldSub = event.oldSubscription;
      const applicationServerKey =
        (oldSub && oldSub.options && oldSub.options.applicationServerKey) || null;
      if (!applicationServerKey) return;
      await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
      // Уведомить фронт, чтобы он зарегистрировал новую подписку на сервере.
      const allClients = await self.clients.matchAll({ type: 'window' });
      allClients.forEach((c) => c.postMessage({ type: 'push:resubscribed' }));
    } catch (_) { /* silent */ }
  })());
});
