# Axel Messenger

Современный мессенджер с поддержкой личных чатов, групп, каналов и сквозного шифрования.

<h1 align="center">💬 Axel Messenger</h1>

## ✨ Возможности

- **Регистрация по номеру телефона** + подтверждение через SMS (через Telegram-бота)
- **Личные чаты, группы и каналы**
- **Шифрование сообщений на сервере (at-rest, AES-256-GCM)** — ключи хранятся на сервере. ⚠️ Это **не E2E**: администратор сервера и злоумышленник с дампом БД могут прочитать переписку. Настоящий end-to-end (Signal Protocol) в roadmap.
- **Отправка файлов, фото, видео** (хранилище Backblaze B2)
- **Реакции, реплаи, пересылки, редактирование и удаление сообщений**
- **Отложенная отправка сообщений**
- **Папки чатов** и поиск
- **Публичные чаты и профили** по username
- **Инвайт-ссылки**
- **Модерация** и система жалоб
- **Presence** (онлайн/оффлайн) и индикатор печати
- **Тёмная тема** и кастомизация интерфейса
- **Экспорт/импорт данных**

## 🛠 Технологии

| Слой          | Технология                          |
|---------------|-------------------------------------|
| Backend       | Node.js + Express + Socket.IO       |
| База данных   | PostgreSQL (Neon)                   |
| Файлы         | Backblaze B2 (S3-совместимое)       |
| Frontend      | Vanilla JavaScript (SPA)            |
| Хостинг       | Render                              |
| Аутентификация| JWT + сессии в БД                   |
| Шифрование | AES-256-GCM (server-side, at-rest) |

## 🚀 Быстрый старт

### Локальный запуск

```bash
git clone https://github.com/minti-ti/axel-messenger.git
cd axel-messenger
npm install
npm start
```

Приложение будет доступно по адресу: `http://localhost:3000`

### Переменные окружения

Создайте файл `.env` на основе `.env.example`:

```bash
cp .env.example .env
```

Обязательные переменные:

| Переменная              | Описание                              | Пример                              |
|-------------------------|---------------------------------------|-------------------------------------|
| `DATABASE_URL`          | Строка подключения к Neon Postgres    | `postgresql://...`                  |
| `JWT_SECRET`            | Секрет для JWT                        | `super-secret-key`                  |
| `TELEGRAM_BOT_TOKEN`    | Токен Telegram-бота для SMS           | `123456:ABC-DEF...`                 |
| `B2_*`                  | Настройки Backblaze B2                | См. ниже                            |
| `RENDER_EXTERNAL_URL`   | URL приложения на Render              | `https://your-app.onrender.com`     |

### Деплой

Проект настроен для деплоя на **Render**:

1. Создайте Web Service
2. Подключите Neon Postgres
3. Настройте Backblaze B2 (или любой S3-совместимый сервис)
4. Добавьте переменные окружения

## 📁 Структура проекта

```
├── src/
│   ├── routes/           # API роуты
│   ├── server.js         # Точка входа
│   ├── socket.js         # WebSocket логика
│   ├── auth.js
│   ├── chatService.js
│   ├── encryption.js
│   ├── storage.js        # Работа с B2
│   └── ...
├── public/               # Frontend (HTML + JS)
├── scripts/              # Скрипты бэкапа
├── Dockerfile
├── docker-compose.yml
└── init.sql              # Инициализация БД
```

## 🔒 Безопасность

- Helmet + строгая CSP (без `unsafe-inline`/`unsafe-eval` в production)
- HSTS (2 года + `includeSubDomains` + `preload`)
- Rate limiting (auth / messages / общий API + WS-rate-limit по событиям)
- JWT с серверными сессиями (можно отозвать токен)
- Валидация и санитизация путей файлов, авторизация на скачивание вложений
- TLS-сертификат БД проверяется по цепочке (`DB_SSL_STRICT=true` по умолчанию)
- Telegram webhook подписан секретным токеном (`X-Telegram-Bot-Api-Secret-Token`)
- Атомарная выдача отложенных сообщений (`FOR UPDATE SKIP LOCKED`) — нет дублей при scale-out
- Шифрование сообщений на стороне сервера (at-rest, AES-256-GCM) — **не путать с E2E**

Подробный аудит безопасности находится в файле `AUDIT_REPORT.md`.

## 🧪 Тесты

```bash
npm test
```

Юнит-тесты используют встроенный `node:test` — никаких внешних зависимостей.
В CI запускаются автоматически вместе с `node --check`, `npm audit` и smoke-сборкой Docker-образа.

## 📦 Бэкап

В папке `scripts/` есть скрипты для бэкапа базы данных:

- `backup.sh` — для Linux/macOS
- `backup.ps1` — для Windows

## 🗺 Roadmap

- [ ] Полноценная реализация Signal Protocol (E2E)
- [ ] Push-уведомления (Web Push / FCM)
- [ ] Голосовые и видеозвонки (WebRTC)
- [ ] Мобильное приложение (React Native / Flutter)
- [x] Базовые тесты и CI/CD

## 🤝 Вклад

Pull requests приветствуются!

## 📄 Лицензия

MIT

---

**Axel Messenger** — сделано с ❤️