/**
 * Axel Messenger — Service Worker.
 *
 * Выполняет три задачи:
 *   1) PWA — кэширует app-shell для быстрого старта и offline-fallback,
 *   2) принимает push-уведомления от Web Push API и показывает их,
 *   3) при клике по уведомлению переводит пользователя в нужный чат.
 *
 * Стратегия кэширования — «Network First, Cache Fallback»:
 *   • Навигационные запросы (HTML) — сеть → кэш → offline.html
 *   • App-shell (JS, CSS) — precache при install, потом stale-while-revalidate
 *   • Всё остальное (API, WebSocket, файлы) — network only, не кэшируем
 */

/* eslint-env serviceworker */

// Версия кэша — при каждом деплое бампим, чтобы инвалидировать старый кэш.
// Совпадает с querystring на скриптах в index.html (?v=YYYYMMDD).
const CACHE_VERSION = 'v20260530';
const CACHE_NAME = `axel-shell-${CACHE_VERSION}`;

// App-shell: файлы, которые кэшируются при установке SW.
// Это UI-каркас — без него приложение не отобразится.
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/js/01-state.js',
  '/js/02-ui-utils.js',
  '/js/03-chat.js',
  '/js/04-main.js',
  '/encryption-client.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/favicon.ico'
];

// ───────── Install: precache app-shell ─────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ───────── Activate: удаляем старые кэши ─────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('axel-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ───────── Fetch: network-first для навигации, stale-while-revalidate для shell ─────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Не кэшируем: POST, WebSocket, API, socket.io, chrome-extension, uploads/files
  if (
    request.method !== 'GET' ||
    request.url.includes('/api/') ||
    request.url.includes('/socket.io/') ||
    request.url.includes('/uploads/') ||
    request.url.includes('/files/') ||
    request.url.startsWith('chrome-extension://') ||
    request.url.includes('/telegram/')
  ) {
    return; // Не перехватываем — пусть идёт в сеть напрямую
  }

  // Навигация (HTML-страницы) — Network First → Cache → offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Кладём свежий ответ в кэш
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request)
            .then((cached) => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // App-shell ресурсы (JS, CSS, иконки) — Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached); // Если сеть недоступна — вернём из кэша

      return cached || fetchPromise;
    })
  );
});

// ───────── Push notifications ─────────
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
    icon: data.icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    // tag нужен, чтобы новые сообщения из того же чата ЗАМЕНЯЛИ предыдущее
    // уведомление, а не накапливали 50 копий.
    tag: data.tag || 'axel-message',
    // renotify: true — при замене уведомления с тем же tag снова воспроизведётся
    // звук/вибрация. Важно для iOS где push приходит даже если WS ещё «жив».
    renotify: true,
    timestamp: Number(data.timestamp) || Date.now(),
    data: {
      url: data.url || '/',
      tag: data.tag || null
    }
  };

  // На iOS Safari 16.4+ showNotification обязателен для каждого push-события.
  // Если не показать уведомление — iOS может отозвать push-подписку.
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
