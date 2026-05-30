/**
 * Axel Messenger — фронтенд, часть 02: UI-утилиты и базовые helpers.
 *
 * До рефакторинга весь клиент жил в одном public/js/app.js на 4134 строки.
 * Теперь он разрезан на 4 файла, которые подключаются строго по порядку
 * (см. <script src='/js/0X-...js'> в public/index.html).
 *
 * Содержит: api(), showToast, escapeHtml, кэш авторизованных медиа (auth-media), работа с file pickers, drag & drop, рендер чатов в сайдбаре, рендер сообщений, drawer, контекст-меню, модалки. Не вызывает функций из последующих модулей.
 *
 * ВАЖНО: модуль грузится как обычный <script>, без import/export. Все
 * объявленные тут переменные и функции остаются глобальными — так же,
 * как было в монолите. Это сознательное решение, чтобы рефакторинг
 * был safe-by-default (не меняет ни одной строки логики).
 */


function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.style.borderColor = isError ? 'rgba(239,83,80,0.45)' : 'rgba(77,163,255,0.35)';
  el.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.toast.classList.add('hidden'), 3200);
}

async function api(path, options = {}) {
  const headers = options.headers || {};
  const isForm = options.body instanceof FormData;
  if (!isForm) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(path, {
    ...options,
    headers,
    body: isForm ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || 'Ошибка запроса');
    err.data = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br/>');
}

function escapeValue(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


const AUTH_MEDIA_MAX_CACHE_ITEMS = 80;
const authMediaCache = new Map();
const authMediaPending = new Map();

function isPublicAvatarStoragePath(value = '') {
  return /(^|\/)(avatars?|chat-avatars?)(\/|-)/i.test(String(value || ''));
}

function isProtectedMediaUrl(url = '') {
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.origin);
    const pathname = decodeURIComponent(parsed.pathname || '');
    if (pathname.startsWith('/files/')) {
      return !isPublicAvatarStoragePath(pathname.slice('/files/'.length));
    }
    if (pathname.startsWith('/uploads/')) {
      return !isPublicAvatarStoragePath(pathname.slice('/uploads/'.length));
    }
    return false;
  } catch (_) {
    return false;
  }
}

function rememberAuthMediaEntry(sourceUrl, entry) {
  const existing = authMediaCache.get(sourceUrl);
  if (existing?.objectUrl && existing.objectUrl !== entry.objectUrl && String(existing.objectUrl).startsWith('blob:')) {
    try { URL.revokeObjectURL(existing.objectUrl); } catch {}
  }
  authMediaCache.delete(sourceUrl);
  authMediaCache.set(sourceUrl, entry);
  while (authMediaCache.size > AUTH_MEDIA_MAX_CACHE_ITEMS) {
    const oldest = authMediaCache.entries().next().value;
    if (!oldest) break;
    const [oldUrl, oldEntry] = oldest;
    authMediaCache.delete(oldUrl);
    if (oldEntry?.objectUrl && String(oldEntry.objectUrl).startsWith('blob:')) {
      try { URL.revokeObjectURL(oldEntry.objectUrl); } catch {}
    }
  }
  return entry;
}

function clearAuthMediaCache() {
  for (const entry of authMediaCache.values()) {
    if (entry?.objectUrl && String(entry.objectUrl).startsWith('blob:')) {
      try { URL.revokeObjectURL(entry.objectUrl); } catch {}
    }
  }
  authMediaCache.clear();
  authMediaPending.clear();
}
window.addEventListener('beforeunload', clearAuthMediaCache);

async function fetchMediaResponse(sourceUrl) {
  const headers = {};
  if (isProtectedMediaUrl(sourceUrl)) {
    if (!state.token) {
      const error = new Error('Требуется авторизация для загрузки вложения');
      error.status = 401;
      throw error;
    }
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(sourceUrl, { headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data.error || 'Не удалось загрузить вложение');
    err.data = data;
    err.status = response.status;
    throw err;
  }
  return response;
}

async function getAuthorizedMediaEntry(sourceUrl) {
  if (!isProtectedMediaUrl(sourceUrl)) return { objectUrl: sourceUrl, direct: true };
  if (authMediaCache.has(sourceUrl)) {
    const cached = authMediaCache.get(sourceUrl);
    authMediaCache.delete(sourceUrl);
    authMediaCache.set(sourceUrl, cached);
    return cached;
  }
  if (authMediaPending.has(sourceUrl)) return authMediaPending.get(sourceUrl);
  const pending = (async () => {
    const response = await fetchMediaResponse(sourceUrl);
    const blob = await response.blob();
    return rememberAuthMediaEntry(sourceUrl, {
      objectUrl: URL.createObjectURL(blob),
      blob,
      contentType: blob.type || response.headers.get('content-type') || '',
      fetchedAt: Date.now()
    });
  })().finally(() => authMediaPending.delete(sourceUrl));
  authMediaPending.set(sourceUrl, pending);
  return pending;
}

async function getMediaArrayBuffer(sourceUrl) {
  if (isProtectedMediaUrl(sourceUrl)) {
    const entry = await getAuthorizedMediaEntry(sourceUrl);
    if (!entry.arrayBufferPromise) {
      entry.arrayBufferPromise = entry.blob.arrayBuffer();
    }
    return entry.arrayBufferPromise;
  }
  const response = await fetchMediaResponse(sourceUrl);
  return response.arrayBuffer();
}

function mediaSourceAttrs(url = '') {
  if (!url) return '';
  return isProtectedMediaUrl(url)
    ? `data-protected-src="${escapeValue(url)}"`
    : `src="${escapeValue(url)}"`;
}

function mediaLinkAttrs(url = '', filename = '') {
  if (!url) return '';
  const safeUrl = escapeValue(url);
  const safeFilename = escapeValue(filename);
  return isProtectedMediaUrl(url)
    ? `href="${safeUrl}" data-protected-href="${safeUrl}" data-download-name="${safeFilename}" target="_blank" rel="noopener noreferrer"`
    : `href="${safeUrl}" target="_blank" rel="noopener noreferrer"`;
}

async function applyResolvedMediaToElement(element, sourceUrl) {
  if (!element || !sourceUrl) return;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  element.dataset.mediaRequestId = requestId;
  element.classList.add('media-loading');
  element.classList.remove('media-failed');
  try {
    const entry = await getAuthorizedMediaEntry(sourceUrl);
    if (element.dataset.mediaRequestId !== requestId) return;
    const resolvedUrl = entry.objectUrl || sourceUrl;
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
      if (element.getAttribute('src') !== resolvedUrl) {
        element.src = resolvedUrl;
        element.load?.();
      }
    } else if (element.tagName === 'IMG') {
      element.src = resolvedUrl;
    } else {
      element.setAttribute('src', resolvedUrl);
    }
    element.dataset.resolvedSrc = resolvedUrl;
    element.classList.remove('media-loading');
  } catch (error) {
    if (element.dataset.mediaRequestId !== requestId) return;
    element.classList.remove('media-loading');
    element.classList.add('media-failed');
    element.dataset.mediaError = error.message || 'Не удалось загрузить вложение';
    throw error;
  }
}

async function openProtectedMediaLink(link) {
  const sourceUrl = link?.dataset?.protectedHref;
  if (!sourceUrl) return;
  if (link.dataset.loading === '1') return;
  const originalText = link.dataset.originalText || link.textContent || 'Открыть';
  link.dataset.originalText = originalText;
  link.dataset.loading = '1';
  link.textContent = '⏳ Загрузка...';
  link.classList.add('is-loading');
  try {
    const entry = await getAuthorizedMediaEntry(sourceUrl);
    const filename = link.dataset.downloadName || '';
    const previewable = isImageAttachment(filename) || isVideoAttachment(filename) || isAudioAttachment(filename) || /\.pdf$/i.test(filename);
    if (previewable) {
      const popup = window.open(entry.objectUrl, '_blank', 'noopener');
      if (!popup) {
        const temp = document.createElement('a');
        temp.href = entry.objectUrl;
        temp.target = '_blank';
        temp.rel = 'noopener noreferrer';
        document.body.appendChild(temp);
        temp.click();
        temp.remove();
      }
    } else {
      const temp = document.createElement('a');
      temp.href = entry.objectUrl;
      temp.download = filename || 'download';
      document.body.appendChild(temp);
      temp.click();
      temp.remove();
    }
  } catch (error) {
    showToast(error.message || 'Не удалось открыть вложение', true);
  } finally {
    link.dataset.loading = '0';
    link.classList.remove('is-loading');
    link.textContent = originalText;
  }
}

function hydrateProtectedMedia(root = document) {
  root.querySelectorAll('[data-protected-src]').forEach((node) => {
    if (node.dataset.hydrated === '1') return;
    node.dataset.hydrated = '1';
    applyResolvedMediaToElement(node, node.dataset.protectedSrc).catch((error) => {
      node.dataset.hydrated = '0';
      console.warn('Protected media load failed:', error.message);
    });
  });
  root.querySelectorAll('a[data-protected-href]').forEach((link) => {
    if (link.dataset.bound === '1') return;
    link.dataset.bound = '1';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openProtectedMediaLink(link);
    });
  });
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function getInitials(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]).join('');
  return (letters || 'AM').toUpperCase();
}

function avatarMarkup(name, url, className = 'avatar') {
  if (url) return `<div class="${className}"><img src="${escapeHtml(url)}" alt="${escapeHtml(name || 'avatar')}" /></div>`;
  return `<div class="${className}">${escapeHtml(getInitials(name))}</div>`;
}

function userLabel(user) {
  return user?.displayName || user?.username || user?.phone || 'Пользователь';
}

function chatTypeLabel(chat) {
  if (chat?.isSaved) return 'Saved Messages';
  if (chat?.type === 'private') return 'Личный';
  if (chat?.type === 'group') return 'Группа';
  if (chat?.type === 'channel') return 'Канал';
  return 'Чат';
}

function roleLabel(role, chat) {
  if (role === 'owner') return 'Владелец';
  if (role === 'admin') return 'Администратор';
  if (chat?.type === 'channel') return 'Подписчик';
  return 'Участник';
}

function joinActionLabel(chatType) {
  return chatType === 'channel' ? 'Подписаться' : 'Вступить';
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function updateStoredUser(user) {
  state.user = user;
  localStorage.setItem('user', JSON.stringify(user));
}

function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((x) => x + x).join('') : value;
  const int = Number.parseInt(normalized, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function mixColor(hex, amount = 0.2) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function rgbaFromHex(hex, alpha = 0.14) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resetAuthForm() {
  state.authUserExists = null;
  el.codeStep.classList.add('hidden');
  el.displayNameStep.classList.add('hidden');
  el.codeInput.value = '';
  el.displayNameInput.value = '';
  el.devCodeHint.textContent = '';
  el.authModeHint.textContent = '';
}

function clearSession() {
  clearAuthMediaCache();
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  state.token = '';
  state.user = null;
  state.chats = [];
  state.currentChat = null;
  state.messagesByChat = {};
  state.typingUsers = {};
  state.userSearchResults = [];
  state.replyTo = null;
  resetAuthForm();
  closeDrawer(true);
  render();
}

function applySettings() {
  document.body.dataset.theme = state.settings.theme || 'dark';
  document.body.classList.toggle('compact-chats', Boolean(state.settings.compactChats));
  document.body.classList.toggle('hide-previews', !state.settings.showPreviews);
  const accent = /^#[0-9a-fA-F]{6}$/.test(state.settings.accentColor || '') ? state.settings.accentColor : '#4da3ff';
  const accentSoft = rgbaFromHex(accent, 0.14);
  document.body.style.setProperty('--primary', accent);
  document.body.style.setProperty('--primary-2', mixColor(accent, 0.1));
  document.body.style.setProperty('--primary-soft', accentSoft);
  document.body.style.setProperty('--bubble-self', rgbaFromHex(accent, 0.18));
  document.body.style.setProperty('--selection-accent', rgbaFromHex(accent, 0.26));
  document.body.style.setProperty('--chat-bg-glow', rgbaFromHex(accent, 0.11));
  document.body.style.setProperty('--chat-bg-soft', rgbaFromHex(accent, 0.05));
}

function saveFolders() {
  localStorage.setItem('chatFolders', JSON.stringify(state.chatFolders));
}

async function syncFolders() {
  try {
    const { folders } = await api('/api/users/me/folders', { method: 'PUT', body: { folders: state.chatFolders } });
    state.chatFolders = folders;
    saveFolders();
  } catch (error) {
    console.warn('Cannot sync folders', error);
  }
}

async function loadFolders() {
  try {
    const { folders } = await api('/api/users/me/folders');
    if (folders.length) {
      state.chatFolders = folders;
      saveFolders();
      return;
    }
    if (state.chatFolders.length) await syncFolders();
  } catch (error) {
    console.warn('Cannot load folders', error);
  }
}

function queueFolderSync() {
  clearTimeout(state.folderSaveTimer);
  state.folderSaveTimer = setTimeout(() => { syncFolders(); }, 250);
}

function saveDrafts() {
  localStorage.setItem('chatDrafts', JSON.stringify(state.drafts));
}

function getDraft(chatId) {
  return String(state.drafts[chatId] || '');
}


function normalizeChatMessages(messages = []) {
  return Array.isArray(messages) ? messages.filter((message) => message && !message.deletedAt) : [];
}

function setDraft(chatId, value, sync = true) {
  if (!chatId) return;
  const text = String(value || '');
  if (text) state.drafts[chatId] = text;
  else delete state.drafts[chatId];
  saveDrafts();
  updateChatListItem(chatId);
  if (!sync) return;
  clearTimeout(state.draftSaveTimers[chatId]);
  state.draftSaveTimers[chatId] = setTimeout(async () => {
    try {
      if (text) await api(`/api/chats/${chatId}/draft`, { method: 'PUT', body: { content: text } });
      else await api(`/api/chats/${chatId}/draft`, { method: 'DELETE' });
    } catch (error) {
      console.warn('Draft sync failed', error);
    }
  }, 350);
}

async function loadDrafts() {
  try {
    const { drafts } = await api('/api/chats/drafts/all');
    state.drafts = Object.fromEntries(drafts.map((draft) => [draft.chatId, draft.content]));
    saveDrafts();
  } catch (error) {
    console.warn('Cannot load drafts', error);
  }
}

function isAudioAttachment(name = '') {
  return /\.(mp3|ogg|wav|m4a|webm|aac)$/i.test(String(name || ''));
}

function isImageAttachment(name = '') {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(name || ''));
}

function notificationAllowed() {
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Старая функция: только запрос разрешения у браузера. Оставлена для совместимости
 * с in-app уведомлениями (maybeNotifyMessage), которые работают, пока вкладка
 * открыта.
 */
function requestBrowserNotifications() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  return Notification.requestPermission();
}

// ===================================================================
// iOS / PWA detection helpers
// ===================================================================

/**
 * Определяем iOS (iPhone, iPad, iPod).
 * iPad с iOS 13+ притворяется Mac, поэтому проверяем и maxTouchPoints.
 */
function isIOSDevice() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Проверяем, запущено ли приложение в standalone-режиме (PWA).
 * На iOS это обязательное условие для Web Push.
 */
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

// ===================================================================
// Web Push (background-уведомления через Service Worker)
// ===================================================================

// Кэшируем зарегистрированный SW, чтобы не дёргать navigator.serviceWorker
// при каждом обращении.
let __swRegistrationPromise = null;
function pushSupported() {
  // На iOS push работает ТОЛЬКО из установленной PWA (standalone).
  // В обычном Safari вкладке PushManager есть, но subscribe() упадёт.
  if (isIOSDevice() && !isStandalonePWA()) return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function ensureServiceWorker() {
  // SW регистрируется ВСЕГДА (не только для push) — он нужен для PWA cache,
  // offline fallback и foreground-уведомлений через showNotification.
  if (!('serviceWorker' in navigator)) return null;
  if (!__swRegistrationPromise) {
    __swRegistrationPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((error) => {
        __swRegistrationPromise = null;
        console.warn('[push] SW registration failed:', error);
        return null;
      });
  }
  return __swRegistrationPromise;
}

// Сервер отдаёт ключ в base64url (RFC 7515). PushManager.subscribe требует
// Uint8Array — конвертируем.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

/**
 * Полная подписка: SW → permission → PushManager.subscribe → POST на сервер.
 * Идемпотентна: если уже подписаны — переотправляем подписку на сервер
 * (это лечит ситуацию «бэкенд почистил БД, а браузер думает, что подписан»).
 *
 * iOS Safari 16.4+: push работает ТОЛЬКО из PWA standalone. Кроме того,
 * Notification.requestPermission() ОБЯЗАН вызываться из user gesture (клик).
 * Поэтому эту функцию зовём только из onclick обработчиков.
 *
 * Возвращает: 'granted' | 'denied' | 'unsupported' | 'unconfigured' | 'error' | 'ios-not-standalone'
 */
async function enablePushNotifications() {
  // Специальная проверка для iOS: в обычном Safari push не работает
  if (isIOSDevice() && !isStandalonePWA()) {
    return 'ios-not-standalone';
  }

  if (!pushSupported()) return 'unsupported';

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return permission; // 'denied' | 'default'

    // 1. Service Worker
    const reg = await ensureServiceWorker();
    if (!reg) return 'error';

    // Ждём, пока SW активируется (на iOS первый install может быть медленным)
    if (reg.installing || reg.waiting) {
      await new Promise((resolve) => {
        const sw = reg.installing || reg.waiting;
        sw.addEventListener('statechange', function handler() {
          if (sw.state === 'activated') {
            sw.removeEventListener('statechange', handler);
            resolve();
          }
        });
        // Таймаут на случай если уже activated
        setTimeout(resolve, 3000);
      });
    }

    // 2. Получить public VAPID-ключ с сервера. Без него — ничего не делаем.
    const keyRes = await fetch('/api/users/push/public-key');
    if (keyRes.status === 503) return 'unconfigured';
    if (!keyRes.ok) return 'error';
    const { publicKey } = await keyRes.json();
    if (!publicKey) return 'unconfigured';

    // 3. Подписка через PushManager. Если уже подписаны на этот же ключ —
    // вернётся существующая subscription без повторного запроса.
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true, // обязательно для Web Push — каждый push должен приводить к видимому уведомлению
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    // 4. Отправить подписку на сервер. POST идемпотентен по endpoint.
    const subJson = subscription.toJSON();
    await api('/api/users/me/push-subscriptions', {
      method: 'POST',
      body: { subscription: subJson }
    });

    return 'granted';
  } catch (error) {
    console.warn('[push] enable failed:', error);
    return 'error';
  }
}

/**
 * Отписка: убираем подписку из браузера и из БД.
 * Возвращает true если что-то реально удалили.
 */
async function disablePushNotifications() {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return false;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return false;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api('/api/users/me/push-subscriptions', {
      method: 'DELETE',
      body: { endpoint }
    }).catch(() => {});
    return true;
  } catch (error) {
    console.warn('[push] disable failed:', error);
    return false;
  }
}

/**
 * Проверка: подписана ли эта вкладка/браузер на push (и есть ли валидная
 * подписка в PushManager). Используется в настройках для показа статуса.
 */
async function getPushStatus() {
  if (!pushSupported()) return { supported: false };
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      subscribed = Boolean(sub);
    }
  } catch (_) { /* ignore */ }
  return { supported: true, permission, subscribed };
}

// Обработчик сообщений от SW (например, клик по уведомлению).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'push:navigate' && data.url) {
      try {
        const u = new URL(data.url, window.location.origin);
        const chatId = u.searchParams.get('chat');
        if (chatId && typeof openChat === 'function') {
          openChat(chatId).catch(() => {});
          return;
        }
        window.location.href = u.pathname + u.search;
      } catch (_) { /* ignore */ }
    }
    if (data.type === 'push:resubscribed') {
      // Перерегистрируем подписку на сервере — у SW нет JWT-токена.
      enablePushNotifications().catch(() => {});
    }
  });
}

async function copyText(value) {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  return ok;
}

function isMobileViewport() {
  return window.innerWidth <= 920;
}

function syncMobileLayout() {
  const mobile = isMobileViewport();
  document.body.classList.toggle('mobile-mode', mobile);
  document.body.classList.toggle('mobile-chat-open', mobile && Boolean(state.currentChat));
  if (mobile) {
    if (!state.mobileToolsOpen) el.composerSideActions.classList.add('hidden');
  } else {
    el.composerSideActions.classList.remove('hidden');
    closeMobileTools();
  }
}

function closeMobileTools() {
  state.mobileToolsOpen = false;
  el.composerSideActions.classList.remove('open');
  if (isMobileViewport()) el.composerSideActions.classList.add('hidden');
  else el.composerSideActions.classList.remove('hidden');
  el.mobileToolsOverlay.classList.add('hidden');
  el.mobileToolsBtn?.classList.remove('active');
}

function openMobileTools() {
  if (!isMobileViewport()) return;
  state.mobileToolsOpen = true;
  el.composerSideActions.classList.remove('hidden');
  el.mobileToolsOverlay.classList.remove('hidden');
  requestAnimationFrame(() => el.composerSideActions.classList.add('open'));
  el.mobileToolsBtn?.classList.add('active');
}

function toggleMobileTools() {
  if (!isMobileViewport()) return;
  if (state.mobileToolsOpen) closeMobileTools();
  else openMobileTools();
}

async function openAudioFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.multiple = true;
  input.click();
  input.onchange = () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    addPendingFiles(files);
  };
}

function isVideoAttachment(name = '') {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(String(name || ''));
}

function isAudioFile(file) {
  return String(file?.type || '').startsWith('audio/') || isAudioAttachment(file?.name || '');
}

function isImageFile(file) {
  return String(file?.type || '').startsWith('image/') || isImageAttachment(file?.name || '');
}

function isVideoFile(file) {
  return String(file?.type || '').startsWith('video/') || isVideoAttachment(file?.name || '');
}

function fileKind(file) {
  if (isImageFile(file)) return 'image';
  if (isVideoFile(file)) return 'video';
  if (isAudioFile(file)) return 'audio';
  return 'file';
}

function clearPendingFiles() {
  state.pendingFiles.forEach((item) => { try { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); } catch {} });
  state.pendingFiles = [];
  renderPendingFiles();
}

function addPendingFiles(files) {
  const incoming = Array.from(files || []);
  const mapped = incoming.map((file) => ({
    id: crypto.randomUUID(),
    file,
    kind: fileKind(file),
    previewUrl: ['image','video','audio'].includes(fileKind(file)) ? URL.createObjectURL(file) : ''
  }));
  state.pendingFiles = [...state.pendingFiles, ...mapped].slice(0, 10);
  renderPendingFiles();
}

function removePendingFile(id) {
  const item = state.pendingFiles.find((entry) => entry.id === id);
  if (item?.previewUrl) { try { URL.revokeObjectURL(item.previewUrl); } catch {} }
  state.pendingFiles = state.pendingFiles.filter((entry) => entry.id !== id);
  renderPendingFiles();
}

function drawWaveformOnCanvas(canvas, data) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--primary').trim() || '#4da3ff';
  const bars = Math.min(data.length, 56);
  const step = Math.max(1, Math.floor(data.length / bars));
  const barWidth = width / bars;
  for (let i = 0; i < bars; i += 1) {
    const value = Math.min(1, Math.abs(data[i * step] || 0));
    const barHeight = Math.max(4, value * (height - 4));
    const x = i * barWidth + 1;
    const y = (height - barHeight) / 2;
    ctx.fillRect(x, y, Math.max(2, barWidth - 2), barHeight);
  }
}

async function ensureWaveform(src) {
  if (state.waveformCache[src]) return state.waveformCache[src];
  const buffer = await getMediaArrayBuffer(src);
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioContext.decodeAudioData(buffer.slice(0));
  const channel = decoded.getChannelData(0);
  const sampleCount = 200;
  const block = Math.max(1, Math.floor(channel.length / sampleCount));
  const samples = new Array(sampleCount).fill(0).map((_, idx) => {
    let sum = 0;
    const start = idx * block;
    const end = Math.min(start + block, channel.length);
    for (let i = start; i < end; i += 1) sum += Math.abs(channel[i]);
    return sum / Math.max(1, end - start);
  });
  state.waveformCache[src] = samples;
  try { await audioContext.close(); } catch {}
  return samples;
}

function mountWaveforms(root = document) {
  root.querySelectorAll('canvas[data-waveform-src]').forEach(async (canvas) => {
    if (canvas.dataset.ready === '1') return;
    canvas.dataset.ready = '1';
    try {
      const data = await ensureWaveform(canvas.dataset.waveformSrc);
      drawWaveformOnCanvas(canvas, data);
    } catch (error) {
      canvas.dataset.ready = '0';
    }
  });
}

async function compressImageFile(file) {
  if (!isImageFile(file)) return file;
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  bitmap.close();
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

function renderPendingFiles() {
  if (!state.pendingFiles.length) {
    el.pendingFilesBar.classList.add('hidden');
    el.pendingFilesBar.innerHTML = '';
    return;
  }
  el.pendingFilesBar.classList.remove('hidden');
  el.pendingFilesBar.innerHTML = state.pendingFiles.map((item) => `
    <div class="pending-file-card">
      <button type="button" class="pending-file-remove" data-remove-id="${item.id}">✕</button>
      <div class="pending-file-preview">${item.kind === 'image' ? `<img class=\"pending-preview-image\" src=\"${item.previewUrl}\" alt=\"${escapeHtml(item.file.name)}\" />` : item.kind === 'video' ? `<video class=\"pending-preview-video\" src=\"${item.previewUrl}\" muted playsinline></video>` : item.kind === 'audio' ? `<canvas width=\"180\" height=\"44\" data-waveform-src=\"${item.previewUrl}\"></canvas>` : `<div class=\"pending-file-generic\">📎</div>`}</div>
      <div class="pending-file-name">${escapeHtml(item.file.name)}</div>
      <div class="pending-file-size muted">${Math.round(item.file.size / 1024)} KB</div>
    </div>
  `).join('');
  el.pendingFilesBar.querySelectorAll('[data-remove-id]').forEach((button) => {
    button.onclick = () => removePendingFile(button.dataset.removeId);
  });
  mountWaveforms(el.pendingFilesBar);
}

function showSkeleton(target, type = 'messages') {
  target.className = type === 'messages' ? 'message-list skeleton-list' : 'members-box skeleton-list';
  target.innerHTML = `<div class="skeleton-block"></div><div class="skeleton-block"></div><div class="skeleton-block"></div>`;
}

function insertAtCursor(value) {
  const input = el.messageInput;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  const next = input.value.slice(0, start) + value + input.value.slice(end);
  input.value = next;
  input.selectionStart = input.selectionEnd = start + value.length;
  input.focus();
  if (state.currentChat) setDraft(state.currentChat.id, input.value);
}

function isStickerContent(value) {
  const trimmed = String(value || '').trim();
  return STICKER_SET.includes(trimmed) || /^:sticker:/.test(trimmed);
}

function normalizeStickerDisplay(value) {
  const trimmed = String(value || '').trim();
  return trimmed.replace(/^:sticker:/, '');
}

async function sendSticker(sticker) {
  if (!state.currentChat) return;
  await api(`/api/chats/${state.currentChat.id}/messages`, { method: 'POST', body: (() => { const fd = new FormData(); fd.append('content', `:sticker:${sticker}`); return fd; })() });
}

function downloadBlob(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportData() {
  const response = await fetch('/api/users/me/export', { headers: { Authorization: `Bearer ${state.token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error('Не удалось экспортировать данные');
  downloadBlob(`arena-export-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`, text);
}

async function importData(file) {
  const formData = new FormData();
  formData.append('file', file);
  const result = await api('/api/users/me/import', { method: 'POST', body: formData });
  state.settings = result.settings || state.settings;
  state.chatFolders = result.folders || state.chatFolders;
  await loadDrafts();
  render();
}

function collectViewerImages() {
  return Array.from(document.querySelectorAll('[data-viewer-src]')).map((node) => ({
    src: node.dataset.viewerSrc,
    caption: node.dataset.viewerCaption || '',
    alt: node.alt || node.dataset.viewerCaption || 'Изображение'
  }));
}

function updateImageViewer() {
  const item = state.viewerImages[state.viewerIndex];
  if (!item) return closeImageViewer();
  el.imageViewerImg.removeAttribute('src');
  el.imageViewerImg.classList.remove('media-failed');
  el.imageViewerImg.classList.add('media-loading');
  el.imageViewerImg.alt = item.alt || 'Изображение';
  el.imageViewerCaption.textContent = item.caption || '';
  const many = state.viewerImages.length > 1;
  el.prevImageBtn.classList.toggle('hidden', !many);
  el.nextImageBtn.classList.toggle('hidden', !many);
  el.imageViewerCount.classList.toggle('hidden', !many);
  if (many) el.imageViewerCount.textContent = `${state.viewerIndex + 1} / ${state.viewerImages.length}`;
  if (isProtectedMediaUrl(item.src)) {
    applyResolvedMediaToElement(el.imageViewerImg, item.src).catch((error) => {
      console.warn('Viewer image load failed:', error.message);
      showToast('Не удалось загрузить изображение', true);
    });
  } else {
    el.imageViewerImg.src = item.src;
    el.imageViewerImg.classList.remove('media-loading');
  }
}

function openImageViewerFromSrc(src) {
  state.viewerImages = collectViewerImages();
  state.viewerIndex = Math.max(state.viewerImages.findIndex((item) => item.src === src), 0);
  el.imageViewer.classList.remove('hidden');
  document.body.classList.add('viewer-open');
  el.imageViewer.dataset.touchStartX = '';
  updateImageViewer();
}

function closeImageViewer() {
  state.viewerImages = [];
  state.viewerIndex = -1;
  el.imageViewer.classList.add('hidden');
  el.imageViewerImg.removeAttribute('src');
  el.imageViewerCaption.textContent = '';
  document.body.classList.remove('viewer-open');
}

function shiftImageViewer(direction) {
  if (!state.viewerImages.length) return;
  state.viewerIndex = (state.viewerIndex + direction + state.viewerImages.length) % state.viewerImages.length;
  updateImageViewer();
}

/**
 * Foreground-уведомление о новом сообщении.
 *
 * На десктопных браузерах можно использовать `new Notification()` напрямую,
 * но на iOS Safari 16.4+ (и вообще PWA standalone) это НЕ работает —
 * уведомления там обязаны идти через ServiceWorkerRegistration.showNotification().
 *
 * Поэтому используем SW showNotification если доступен, иначе fallback
 * на обычный new Notification (для старых десктопных браузеров).
 */
function maybeNotifyMessage(message) {
  if (!state.settings.notificationsEnabled) return;
  if (!notificationAllowed()) return;
  if (message.userId === state.user?.id) return;
  if (document.visibilityState === 'visible' && state.currentChat?.id === message.chatId) return;
  
  const chat = state.chats.find((item) => item.id === message.chatId);
  
  // Проверяем фильтры для типов чатов
  if (chat?.type === 'private' && !state.settings.notifyPrivateChats) return;
  if (['group', 'channel'].includes(chat?.type) && !state.settings.notifyGroups) return;
  
  // Проверяем упоминания
  if (state.settings.notifyMentions && !message.content?.includes(`@${state.user?.username || ''}`)) {
    if (['group', 'channel'].includes(chat?.type)) return;
  }
  
  const senderName = message.authorName || 'Новое сообщение';
  const body = message.content || message.attachmentName || 'Новое сообщение';
  const title = chat?.type === 'private' ? senderName : `${senderName} в ${chat?.title || 'чате'}`;
  
  if (state.settings.notifySound) {
    const audio = new Audio('data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAAAAA==');
    audio.play().catch(() => {});
  }

  // Показываем уведомление через SW (обязательно для iOS PWA).
  // Fallback на new Notification() если SW недоступен.
  const notifOptions = {
    body: body.slice(0, 100),
    tag: `msg-${message.chatId}`,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    data: { url: `/?chat=${message.chatId}`, tag: `chat:${message.chatId}` }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration('/').then((reg) => {
      if (reg) {
        reg.showNotification(title, notifOptions).catch(() => {
          // Fallback: если SW.showNotification упал — пробуем обычный
          _fallbackNotification(title, notifOptions, message.chatId);
        });
      } else {
        _fallbackNotification(title, notifOptions, message.chatId);
      }
    }).catch(() => {
      _fallbackNotification(title, notifOptions, message.chatId);
    });
  } else {
    _fallbackNotification(title, notifOptions, message.chatId);
  }
}

function _fallbackNotification(title, options, chatId) {
  try {
    const notification = new Notification(title, {
      body: options.body,
      tag: options.tag,
      icon: options.icon
    });
    notification.onclick = () => {
      window.focus();
      openChat(chatId).catch(() => {});
      notification.close();
    };
  } catch (_) { /* iOS will throw here — that's expected */ }
}

function canModerateMessagesInCurrentChat() {
  if (!state.currentChat) return false;
  if (state.currentChat.type === 'private') return false;
  return state.currentChat.restrictions?.adminsCanManageMessages !== false && ['owner', 'admin'].includes(state.currentChat.viewerRole);
}

function messageStatusLabel(message) {
  if (!state.currentChat || message.userId !== state.user.id || state.currentChat.isSaved) return '';
  if (message.deletedAt) return '';
  const delivered = Number(message.delivery?.deliveredCount || 0);
  const read = Number(message.delivery?.readCount || 0);
  if (state.currentChat.type === 'private') {
    if (read > 0) return '✓✓';
    if (delivered > 0) return '✓';
    return '○';
  }
  if (read > 0) return `✓✓ ${read}`;
  if (delivered > 0) return `✓ ${delivered}`;
  return '';
}

function folderChipId(folderId) {
  return `folder:${folderId}`;
}

function getFolderNameByFilter(filter) {
  const id = String(filter || '').replace(/^folder:/, '');
  return state.chatFolders.find((folder) => folder.id === id)?.name || 'Папка';
}

function upsertFolder(folder) {
  const index = state.chatFolders.findIndex((item) => item.id === folder.id);
  if (index >= 0) state.chatFolders[index] = folder;
  else state.chatFolders.push(folder);
  saveFolders();
  queueFolderSync();
  render();
}

function openFoldersModal(selectedChatId = state.currentChat?.id || null) {
  const list = state.chatFolders.map((folder) => `
    <label class="member-row">
      <div><strong>${escapeHtml(folder.name)}</strong></div>
      ${selectedChatId ? `<input type="checkbox" data-folder-id="${folder.id}" ${folder.chatIds.includes(selectedChatId) ? 'checked' : ''} />` : `<button type="button" class="ghost-btn small delete-folder-btn" data-folder-id="${folder.id}">Удалить</button>`}
    </label>
  `).join('');
  openModal(
    'Папки чатов',
    `
      <form class="modal-grid">
        <div class="form-card form-row">
          <label>Новая папка</label>
          <input name="folderName" placeholder="Например: Работа" />
        </div>
        <div class="form-card form-row">
          <div><strong>Существующие папки</strong></div>
          <div id="foldersBox" class="members-box">${list || '<div class=\"muted\">Пока нет папок.</div>'}</div>
        </div>
        <button class="primary-btn" type="submit">Сохранить</button>
      </form>
    `,
    async (formData) => {
      const folderName = String(formData.get('folderName') || '').trim();
      if (folderName) {
        upsertFolder({ id: crypto.randomUUID(), name: folderName, chatIds: selectedChatId ? [selectedChatId] : [] });
      }
      if (selectedChatId) {
        state.chatFolders = state.chatFolders.map((folder) => ({
          ...folder,
          chatIds: formData.getAll('folder').includes(folder.id) ? Array.from(new Set([...(folder.chatIds || []), selectedChatId])) : (folder.chatIds || []).filter((id) => id !== selectedChatId)
        }));
        saveFolders();
        queueFolderSync();
      }
      closeModal();
      render();
    }
  );
  const box = document.getElementById('foldersBox');
  box.querySelectorAll('.delete-folder-btn').forEach((button) => {
    button.onclick = () => {
      state.chatFolders = state.chatFolders.filter((folder) => folder.id !== button.dataset.folderId);
      saveFolders();
      queueFolderSync();
      openFoldersModal(selectedChatId);
    };
  });
  if (selectedChatId) {
    box.querySelectorAll('[data-folder-id]').forEach((checkbox) => {
      checkbox.name = 'folder';
      checkbox.value = checkbox.dataset.folderId;
    });
  }
}

function formatChatTime(date) {
  if (!date) return '';
  const value = new Date(date);
  const now = new Date();
  if (value.toDateString() === now.toDateString()) {
    return value.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return value.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function formatMessageTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatLastSeen(user) {
  if (!user) return '';
  if (user.isOnline || state.presence[user.id]?.isOnline) return 'В сети';
  if (!user.lastSeen) return 'Недавно был(а) в сети';
  return `Был(а) в сети ${new Date(user.lastSeen).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
}

function chatPreviewText(chat) {
  const draft = getDraft(chat.id);
  if (draft) return `Черновик: ${draft}`;
  if (chat.lastMessage?.content) return chat.lastMessage.content;
  if (chat.lastMessage?.attachmentName) return `📎 ${chat.lastMessage.attachmentName}`;
  if (chat.pinnedMessage?.content) return `📌 ${chat.pinnedMessage.content}`;
  if (chat.description) return chat.description;
  if (chat.username) return `@${chat.username}`;
  return chatTypeLabel(chat);
}

function currentChatOnlineText() {
  if (!state.currentChat?.peer?.id) return '';
  const peerId = state.currentChat.peer.id;
  return state.presence[peerId]?.isOnline ? ' · в сети' : '';
}

function canPinCurrentChat() {
  if (!state.currentChat) return false;
  if (state.currentChat.type === 'private') return true;
  return ['owner', 'admin'].includes(state.currentChat.viewerRole);
}

function closeContextMenu() {
  state.contextMenuOpen = false;
  el.contextMenu.classList.add('hidden');
  el.contextMenu.innerHTML = '';
}

function openContextMenu(items, x, y) {
  state.contextMenuOpen = true;
  el.contextMenu.innerHTML = items.map((item, index) => `<button type="button" class="context-menu-item ${item.danger ? 'danger' : ''}" data-index="${index}">${item.label}</button>`).join('');
  el.contextMenu.classList.remove('hidden');
  el.contextMenu.style.left = `${Math.max(12, x)}px`;
  el.contextMenu.style.top = `${Math.max(12, y)}px`;
  requestAnimationFrame(() => {
    const rect = el.contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) el.contextMenu.style.left = `${Math.max(12, window.innerWidth - rect.width - 12)}px`;
    if (rect.bottom > window.innerHeight - 12) el.contextMenu.style.top = `${Math.max(12, window.innerHeight - rect.height - 12)}px`;
  });
  el.contextMenu.querySelectorAll('[data-index]').forEach((button) => {
    button.onclick = () => {
      const item = items[Number(button.dataset.index)];
      closeContextMenu();
      item.onClick?.();
    };
  });
}

function shouldIgnoreMessageContextTarget(target) {
  return Boolean(target.closest('button, a, audio, video, canvas, input, textarea, select'));
}

