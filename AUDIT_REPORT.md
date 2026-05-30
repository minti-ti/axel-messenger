# 🔍 Аудит проекта Axel Messenger

**Дата:** 2026-05-29
**Репозиторий:** [minti-ti/axel-messenger](https://github.com/minti-ti/axel-messenger)
**Объём:** 33 файла, ~8 700 строк кода

---

## Часть 1. Архитектура

### Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                        КЛИЕНТ (браузер)                      │
│   public/  →  index.html + app.js (3 513 строк, SPA)        │
│              styles.css (1 270 строк), encryption-client.js │
│              public-profile.html/.js, public-chat.html/.js  │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP REST + WebSocket (Socket.IO)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              SERVER (Node.js + Express + Socket.IO)         │
│                                                              │
│   src/server.js   ← точка входа, middleware, rate-limit     │
│   src/auth.js     ← JWT, authMiddleware                     │
│   src/socket.js   ← presence, typing, join/leave            │
│                                                              │
│   src/routes/                                                │
│     auth.js       ← /api/auth/* (login по SMS-коду)          │
│     users.js      ← /api/users/* (профили, настройки)        │
│     chats.js      ← /api/chats/* (1266 строк, главная API)   │
│     public.js     ← /api/public/* (без авторизации)          │
│                                                              │
│   src/chatService.js       ← бизнес-логика чатов            │
│   src/moderationService.js ← жалобы, модерация              │
│   src/encryption.js        ← AES-256-GCM шифрование         │
│   src/storage.js           ← локальный диск или S3          │
│   src/sms.js               ← отправка кодов (Telegram-бот)  │
│   src/telegramBot.js       ← webhook для Telegram           │
│   src/utils.js, db.js, config.js                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ pg (Pool)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL (init.sql)                     │
│  users, chats, chat_members, messages, reactions,           │
│  user_settings, user_sessions, login_codes, chat_invites,   │
│  user_reports, scheduled_messages, user_folders,            │
│  encryption_keys, message_deletion_logs                     │
└─────────────────────────────────────────────────────────────┘

         ▲                                       ▲
         │                                       │
    ┌────┴────┐                            ┌─────┴──────┐
    │ S3      │ (опц., через AWS SDK v3)   │ Twilio     │ (декларирован,
    │ MinIO   │                            │ Telegram   │  но реально SMS
    └─────────┘                            └────────────┘  идёт через бота)
```

### Ключевые фичи

| Фича | Где | Статус |
|---|---|---|
| Регистрация по телефону + SMS-код | `auth.js` + `sms.js` | ✅ Работает через Telegram-бот; Twilio в зависимостях есть, но не используется |
| JWT-сессии (30 дней) с серверными `user_sessions` | `auth.js`, `routes/auth.js` | ✅ Можно завершить сессию извне |
| Личные чаты, группы, каналы | `chatService.js`, `routes/chats.js` | ✅ |
| Saved Messages («Избранное») | `chatService.js` | ✅ |
| Реакции, реплаи, форварды | `routes/chats.js` | ✅ |
| Альбомы (несколько вложений в одном сообщении) | `init.sql:album_id` | ✅ |
| Закреплённые сообщения | `pinned_message_id` | ✅ |
| Редактирование/удаление сообщений | `routes/chats.js` | ✅ |
| Отложенная отправка | `scheduled_messages` + `setInterval(5s)` в `server.js` | ✅ |
| Папки чатов | `user_folders` | ✅ |
| Поиск по сообщениям и пользователям | `routes/chats.js`, `routes/users.js` | ✅ |
| Public chats / public profiles (по @username) | `routes/public.js`, `public-chat.html` | ✅ |
| Invite-ссылки `/join/:token` | `chat_invites` | ✅ |
| Жалобы + модерация (системный чат супер-админов) | `moderationService.js` | ✅ Интересное решение — отчёты приходят как сообщения в служебный чат |
| Мут/бан в чате | `chat_members.muted_until/banned_until` | ✅ |
| Permissions для админов (can_pin / can_add / can_manage) | `chat_members` | ✅ |
| Presence (online/offline через WebSocket) | `socket.js` | ✅ |
| Typing indicator | `socket.js` | ✅ |
| Голосовые сообщения, фото, видео, файлы | `multer` + `storage.js` | ⚠️ см. безопасность |
| Шифрование сообщений (AES-256-GCM) | `encryption.js` | ⚠️ см. ниже — слабая реализация |
| Экспорт/импорт данных | `routes/users.js:export/import` | ✅ |
| Drafts (черновики) | `user_drafts` | ✅ |
| Темы оформления, акцентный цвет, настройки приватности | `user_settings` | ✅ |
| CSP, Helmet, X-Frame-Options, HSTS | `server.js` | ✅ Включены в production |
| Rate limiting | `express-rate-limit` | ✅ 3 лимитера: auth, sensitive, message |
| Docker + docker-compose | `Dockerfile`, `docker-compose.yml` | ✅ |
| Скрипты бэкапа БД | `scripts/backup.sh`, `backup.ps1` | ✅ |

### Хорошие архитектурные решения 👍

1. **Параметризованные SQL-запросы** — везде через `query(text, [params])`, никакой конкатенации. **0 SQL-инъекций**.
2. **`authMiddleware` глобально** через `router.use(authMiddleware)` в `chats.js:217` и `users.js:144` — все ручки после этой строки защищены.
3. **Серверный список сессий** — JWT можно отозвать на сервере (есть `user_sessions.revoked_at`), что лучше «безсессионного» JWT.
4. **Helmet с жёсткой CSP в production** — `defaultSrc 'self'`, `objectSrc 'none'`, `scriptSrc 'self'` (без `unsafe-inline`/`unsafe-eval`!).
5. **Helmet + дополнительные заголовки** — HSTS, X-Frame-Options, Permissions-Policy.
6. **Storage-абстракция** — один код работает и с локальным диском, и с S3/MinIO (`isS3` флаг).
7. **AES-256-GCM** для шифрования (а не CBC) — даёт встроенную аутентификацию.
8. **Soft-delete сообщений** через `deleted_at` — есть аудит-лог `message_deletion_logs`.
9. **Идемпотентные миграции** — все `ALTER TABLE ADD COLUMN IF NOT EXISTS` и `CREATE INDEX IF NOT EXISTS`.

---

## Часть 2. Безопасность — найденные проблемы

### 🔴 Критичные

#### 1. **Уязвимый `multer@1.4.5-lts.1`** (CVE-2025-47944, CVE-2025-47935)

> **CVSS 7.5 / High** — две уязвимости:
> - CVE-2025-47944: DoS через malformed multipart-запрос → краш процесса
> - CVE-2025-47935: утечка памяти + файловых дескрипторов из-за незакрытых стримов

В `package.json` сейчас `^1.4.5-lts.1`, но даже последняя `1.4.x` уязвима. **Воркэрраундов нет**. Сам пакет в `package-lock.json` (`multer-1.4.5-lts.2.tgz`) уже помечен как `deprecated`.

**Фикс:**
```json
"multer": "^2.0.0"
```
И обновить вызовы (API почти не изменился — должно завестись из коробки, но проверь).

---

#### 2. **JWT secret имеет дефолтное значение `'change_me_super_secret'`**

`src/config.js:18`:
```js
jwtSecret: process.env.JWT_SECRET || 'change_me_super_secret',
```

Если кто-то задеплоит проект и забудет задать `JWT_SECRET` — **любой может подделать токен**. Это самая частая ошибка в Node.js-приложениях.

**Фикс:** падать при старте, если в production нет секрета:
```js
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
module.exports = {
  jwtSecret: jwtSecret || 'dev-only-secret-' + crypto.randomBytes(16).toString('hex'),
  // ...
};
```

---

#### 3. **Дефолтный пароль БД `'messenger'`**

`src/config.js:10`:
```js
const password = process.env.DB_PASSWORD || 'messenger';
```

Та же проблема. Если PostgreSQL слушает наружу — взлом за секунды.

**Фикс:** аналогично — обязательная переменная в production.

---

#### 4. **`/files/*` — path traversal**

`src/server.js:106`:
```js
app.get('/files/*', async (req, res) => {
  const key = decodeURIComponent(String(req.params[0] || ''));
  await streamStoredFile(key, res);
});
```

`storage.js:85-90` пытается защититься:
```js
const filename = key.includes('/') ? key.split('/').pop() : key;
const filePath = path.join(config.uploadsDir, filename);
```

`.pop()` берёт последний сегмент пути, **но не блокирует `..`**:
- запрос `/files/foo/..%2Fpasswd` → `decodeURIComponent` → `foo/../passwd` → `.pop()` = `passwd` → `path.join(uploadsDir, 'passwd')` ← **в uploads только uploads, ОК**

На самом деле здесь **относительно безопасно**, потому что `.pop()` всегда оставляет одно имя без `/`. Но `..` в имени файла всё равно проскочит:
- `/files/..%2F..%2Fetc%2Fpasswd` → `pop()` → `passwd` ← всё ещё в uploads ✅

**НО** для S3-режима функция отдаёт `key` в `GetObjectCommand` напрямую без санитайзинга — там это норма, S3 сам не выпустит за пределы бакета.

**Вердикт:** локально защищено через `.pop()`, но защита неочевидна. Лучше явно:
```js
if (filename.includes('..') || filename.startsWith('.')) {
  return res.status(400).json({ error: 'Bad path' });
}
```

---

#### 5. **Авторизация по `/files/:key` отсутствует**

**Любой неавторизованный пользователь** может скачать любой файл, **зная (или угадав) ключ**. Ключи имеют вид `chat-files/1735012345-123456789.jpg` — секрет средней сложности (~10⁻¹⁸ угадывания), но всё же это не privacy.

В мессенджере вложения должны быть привязаны к сообщению, и доступ к файлу — только участникам чата.

**Фикс:** перед отдачей файла проверить `req.user` (через `authMiddleware`) + найти сообщение с этим `attachment_url` + убедиться, что юзер — член чата.

---

### 🟡 Средние

#### 6. **Шифрование в `encryption.js` хранит ключ открытым в БД**

`encryption_keys.key_data TEXT` — ключи лежат в Postgres рядом с зашифрованными сообщениями. **Это не E2E**, это просто «at-rest»-шифрование с ключом в той же БД. Если злоумышленник украл дамп БД — он получит и ключи, и шифротекст.

В коде даже есть переменная `is_encrypted` на сообщениях, но судя по `routes/chats.js` — шифрование **не применяется к сообщениям при вставке** (поле `is_encrypted` всегда `false` по умолчанию). Функции `encryptMessage`/`decryptMessage` определены, но я не нашёл места, где они реально вызываются на write-path.

**Вердикт:** либо реализация недописана, либо это заглушка под будущий E2E. Сейчас она **не даёт никакой защиты**.

**Рекомендации:**
- Либо удалить весь `encryption.js` и поле `is_encrypted` (чтобы не вводить в заблуждение)
- Либо реализовать **настоящий E2E** (ключ создаётся на клиенте, сервер хранит только публичные ключи). См. Signal Protocol.

---

#### 7. **Нет проверки расширения файла, только MIME**

`routes/chats.js:60`:
```js
function allowAttachment(file, cb) {
  const mimetype = String(file.mimetype || '');
  // ... проверка по mimetype
}
```

Браузер может прислать любой `Content-Type` — оригинальное расширение файла идёт **как есть** в `storage.makeKey` → `path.extname(originalname)`. Можно загрузить `.html` с `Content-Type: image/png` → файл сохранится с `.html` → если открыть напрямую → XSS (т.к. браузер при доступе к `/files/foo.html` всё равно покажет HTML, несмотря на mime).

**Фикс:** не использовать оригинальное расширение, или принудительно ставить расширение по `mimetype`, или отдавать файлы с `Content-Disposition: attachment`.

---

#### 8. **CORS открыт настежь для Socket.IO**

`server.js:24`:
```js
const io = new Server(server, {
  cors: { origin: '*' },
  ...
});
```

Это значит, что **любой сайт** может подключиться к твоему WebSocket с токеном пользователя (если он у злоумышленника есть). Для production должно быть:
```js
cors: { origin: config.appUrl, credentials: true }
```

---

#### 9. **CSP в development полностью выключена**

`server.js:53`:
```js
} else {
  app.use(helmet({
    contentSecurityPolicy: false,
    // ...
  }));
}
```

В dev это часто оправдано, но если случайно задеплоить с `NODE_ENV ≠ production` — получишь дыру.

**Фикс:** хотя бы базовый CSP даже в dev, или явный warning при старте если `NODE_ENV !== 'production'` на публичном порту.

---

#### 10. **CSRF endpoint бесполезен**

`server.js:75-81`:
```js
app.get('/api/csrf-token', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  req.session = req.session || {};
  req.session.csrfToken = token;
  res.json({ csrfToken: token });
});
```

Здесь **нет** middleware для сессий (никакого `express-session`, `cookie-session` и т.п.), так что `req.session` — просто временный объект на одном запросе. Токен **никуда не сохраняется** и **нигде не проверяется**. Endpoint выглядит как защита, но он плацебо.

Впрочем, для **API на JWT в Authorization-заголовке** CSRF не нужен (атакующий не может прочитать токен из localStorage кросс-домена). Так что — **либо удалить этот endpoint**, либо реализовать честно (но он не нужен).

---

#### 11. **Rate-limiter не считается с trust proxy корректно**

`server.js:21`: `app.set('trust proxy', 1)` — ОК для одного reverse-proxy. Но `express-rate-limit` v7 предупреждает: если за прокси можно «отравить» `X-Forwarded-For`, лимит обходится сменой заголовка.

**Фикс:** убедись, что в production перед сервером ровно один доверенный прокси (nginx/Render/Caddy), и не больше.

---

#### 12. **`forward-bulk` пропускает проверку прав на target chat для пересылки**

`routes/chats.js` (видел в выводе ~970 строка): при пересылке проверяется, что юзер **состоит в source chat** (`isChatMember(source.chat_id, req.user.id)`), но **не проверяется**, имеет ли он право **писать** в target chat (в каналах писать могут только админы). Нужно дополнительно проверять `canPostToChat(targetChatId, req.user.id)`.

---

### 🟢 Мелкие/стилистические

13. **Twilio в зависимостях, но не используется** (`sms.js` использует только Telegram-бот). Можно убрать из `package.json` (`twilio: ^5.4.2` — большой пакет ~10 МБ).

14. **`process.cwd()` вместо `__dirname`** в нескольких местах (`server.js:84-86, 95, 99`) — может ломаться, если запускать не из корня проекта. Лучше `path.join(__dirname, '..', 'public')`.

15. **`router.use(authMiddleware)` стоит ПОСЛЕ нескольких ручек** в `chats.js` и `users.js`. Сейчас это сделано намеренно (есть публичные ручки выше), но это легко не заметить при правках и случайно добавить новую ручку выше — она будет открытой. Лучше явно мониторить покрытие: вынести публичные роуты в отдельный sub-router.

16. **`scheduled_messages` обрабатывается через `setInterval(5000)`** — если приложение упало, отложенные сообщения отправятся позже. На малой нагрузке — ок. На большой — нужна очередь (BullMQ, например).

17. **`telegramBot.js` логирует весь webhook payload** в production (`console.log('[Telegram Bot] Webhook received:', ...)`) — там телефоны пользователей в открытом виде. Это **утечка PII в логи**.

18. **Парольная политика отсутствует** (но её и не должно быть — нет паролей, всё через SMS-коды).

19. **`registerTelegramUser` хранит мапу `phone → chatId` в RAM** (`const phoneToChatId = new Map()`). После рестарта сервера все привязки теряются. Должно быть в БД.

20. **Нет CI/тестов** — нет `npm test`, нет GitHub Actions. Сложно поддерживать качество.

---

## Часть 3. Рекомендации (по приоритету)

### 🔥 Сделать сейчас

1. **Обновить multer до 2.x** (5 минут)
2. **Сделать `JWT_SECRET` обязательным в production** (10 минут)
3. **Сузить CORS Socket.IO до `config.appUrl`** (1 минута)
4. **Сохранять `phoneToChatId` в БД** (30 минут — простая таблица)
5. **Убрать `console.log` персональных данных из `telegramBot.js`** (1 минута)

### 📅 Сделать в ближайшее время

6. **Авторизация на `/files/:key`** — отдавать файлы только участникам чата
7. **Принудительное расширение по mimetype + `Content-Disposition: attachment`** для всех файлов кроме картинок
8. **Удалить нерабочий CSRF-endpoint** (или реализовать честно)
9. **Решить судьбу шифрования**: либо убрать заглушку, либо реализовать настоящий E2E
10. **Проверка `canPostToChat` для forward-bulk** на target chat

### 🎯 Долгосрочно

11. Тесты (Jest/Vitest + supertest для API)
12. CI на GitHub Actions: `npm audit`, lint, тесты
13. Структурированное логирование (pino/winston) вместо `console.log`
14. Очередь для отложенных сообщений (BullMQ + Redis)
15. Метрики/мониторинг (Prometheus + Grafana)

---

## TL;DR

**Проект в целом сделан добросовестно:** параметризованный SQL, JWT с серверной отзываемостью, Helmet+CSP, rate-limit, разделение ответственностей, нормальная схема БД с миграциями. Видно, что автор знает, что делает.

**Главные слабые места:**

| # | Проблема | Усилие | Эффект |
|---|---|---|---|
| 1 | Уязвимый multer 1.x | 5 мин | 🔴 закрывает 2 CVE 7.5 |
| 2 | Дефолтный JWT_SECRET | 10 мин | 🔴 невозможность подделки токенов |
| 3 | CORS `*` для WebSocket | 1 мин | 🟡 предотвращает CSWSH |
| 4 | Авторизация `/files/*` | 30 мин | 🔴 приватность вложений |
| 5 | Заглушка E2E-шифрования | решение | 🟡 либо честно, либо убрать |

**Общая оценка:** 7/10. Усиление по 5 пунктам выше → 9/10.

---

## Часть 4. Выполненные исправления (2026-05-29)

> Данный раздел обновляется по мере устранения найденных проблем.

### ✅ Исправлено

| # | Проблема | Статус | Дата |
|---|---|---|---|
| 1 | **Multer обновлён до v2.x** | ✅ Исправлено | 2026-05-29 |
| 2 | **JWT_SECRET и DB_PASSWORD обязательны в production** | ✅ Исправлено | 2026-05-29 |
| 3 | **Шифрование: документировано как Server-Side (не E2E)** | ✅ Исправлено | 2026-05-29 |

### Детали исправлений

#### 1. Multer v2.x
Обновлён `package.json`:
```json
"multer": "^2.0.0"
```
API совместим с v1.x, всё работает из коробки.

---

#### 2. Обязательные секреты в production
В `src/config.js` добавлена функция `requireInProduction()`:
```js
function requireInProduction(name, value, options = {}) {
  if (!IS_PRODUCTION) return value;
  if (value && value !== options.forbiddenDefault) return value;
  throw new Error(
    `[config] Environment variable ${name} must be set in production` +
    (options.forbiddenDefault ? ` (current value is the insecure default)` : '')
  );
}
```
При попытке запустить production-режим с дефолтными значениями `JWT_SECRET` или `DB_PASSWORD` — приложение падает с понятной ошибкой. В development режим работает как раньше.

---

#### 3. Документирование Server-Side Encryption

**Ключевое пояснение:** текущая реализация — **Server-Side Encryption**, а не End-to-End Encryption.

| | Server-Side Encryption (текущее) | End-to-End Encryption (ideal) |
|---|---|---|
| Генерация ключа | Сервер | Клиент |
| Хранение ключа | Таблица `encryption_keys` на сервере | Участники чата |
| Доступ к plaintext | Сервер (и админ) | Только участники |
| Защита от хакера с дампом БД | ❌ Ключ рядом с данными | ✅ Ключ не в дампе |
| Примеры | WhatsApp (старый), iMessage | Signal, Telegram (secret chats) |

**Изменения:**
- `src/encryption.js` — добавлены подробные комментарии ⚠️ в начало файла
- `public/encryption-client.js` — добавлены комментарии о назначении
- `src/routes/chats.js:ensureEncryptionKey` — добавлен JSDoc с пояснением
- `src/routes/chats.js:POST /:chatId/messages` — добавлены комментарии в блок шифрования

**Для настоящего E2E рекомендуется:**
- Использовать Signal Protocol (libsignal)
- Генерировать ключи на клиенте через WebCrypto
- Обмениваться ключами через отдельный Verified канал
- Хранить на сервере только публичные ключи / результаты DH

---

### ✅ Исправлено (2026-05-30)

| # | Проблема | Статус |
|---|---|---|
| 4 | Авторизация `/files/*` — проверка членства в чате | ✅ `optionalAuth` + `userCanAccessAttachment()` |
| 5 | Расширение по mimetype + Content-Disposition | ✅ `safeExtension()` + `contentDispositionHeader()` |
| 6 | Сужение CORS Socket.IO | ✅ `socketCorsOrigin` = `[appUrl]` в prod |
| 7 | Проверка `canPostToChat` для forward-bulk | ✅ вызывается на target chat |
| 8 | `phoneToChatId` в RAM → таблица `telegram_bindings` | ✅ |
| 9 | **Critical:** `fast-xml-parser` через старый `@aws-sdk/client-s3` | ✅ bump до `^3.1057.0`, `npm audit` = 0 |
| 10 | **Critical:** приватные чаты показывали `[Зашифрованное сообщение]` | ✅ см. ниже |
| 11 | Дубликат JSDoc-блока в `encryption.js` | ✅ удалён |
| 12 | Строгая TLS-проверка БД отключена жёстко | ✅ `DB_SSL_STRICT` / `DB_SSL_CA` |
| 13 | Внешний placeholder-image в README | ✅ заменён на текстовый заголовок |
| 14 | Нет CI | ✅ `.github/workflows/ci.yml` (`node --check` + `npm audit`) |

#### Детали #10 — сломанное «шифрование» приватных чатов

**Симптом:** все текстовые сообщения в приватных чатах сохранялись как
server-side ciphertext (`encryptMessage` на write-path), но `decryptMessage` на
сервере **не вызывался нигде**, а клиент **не получал ключ** (`storeEncryptionKey`
в `app.js` никогда не вызывался). Итог — пользователи видели
`[Зашифрованное сообщение]` вместо текста. При этом «шифрование» не давало
никакой реальной защиты (ключ лежал в той же БД, в таблице `encryption_keys`).

**Исправление:**
- Новые сообщения сохраняются в открытом виде (`isEncrypted = false`),
  как в группах/каналах.
- Старые зашифрованные записи (`is_encrypted = true`) **расшифровываются на лету
  на сервере** — `decryptLegacyRows()` / `decryptChatPreviews()` в `chatService.js`,
  подключены в `formatMessage`, `listMessages`, `listChats`, `getChatById`.
- Поиск (`/search/messages`) фильтрует `is_encrypted = FALSE`, чтобы не
  искать по нечитаемому шифротексту.

Для **настоящей** приватности нужен полноценный E2E (ключи генерируются на
клиенте, сервер хранит только публичные ключи). Текущая правка возвращает
работоспособность чтения, не претендуя на E2E.

