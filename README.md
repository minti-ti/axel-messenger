# Arena Messenger

Рабочий веб‑мессенджер в стиле Telegram, который можно развернуть на своём сервере.

## Что уже есть

- вход по номеру телефона и одноразовому коду;
- личные диалоги;
- группы;
- каналы;
- сообщения в реальном времени через WebSocket / Socket.IO;
- вложения (загрузка файлов до 20 МБ);
- ответы на сообщения;
- реакции;
- редактирование и удаление своих сообщений;
- базовый поиск пользователей;
- Docker / docker-compose для деплоя.

## Важная оговорка

Это **не полный клон Telegram по масштабу**, а уже **готовый deployable мессенджер**, который можно запустить на сервере и дать пользователям общаться между собой.

Для полного уровня Telegram ещё потребуются отдельные этапы:

- мобильные приложения iOS/Android;
- end-to-end encryption для секретных чатов;
- звонки / видео;
- push-уведомления;
- CDN / object storage для файлов;
- антиспам, модерация, аудит безопасности;
- масштабирование на несколько нод.

## Стек

- Node.js + Express
- Socket.IO
- PostgreSQL
- Vanilla JS frontend
- Docker / Docker Compose

## Быстрый запуск локально через Docker

1. Скопируйте `.env.example` в `.env`

```bash
cp .env.example .env
```

2. Задайте секрет:

```env
JWT_SECRET=your_long_random_secret
```

3. Запустите проект:

```bash
docker compose up --build
```

4. Откройте:

```text
http://localhost:3000
```

## Вход по телефону

По умолчанию SMS провайдер не подключён.

### В dev-режиме
Если `ALLOW_DEV_CODE_RESPONSE=true`, API вернёт тестовый код прямо в интерфейс.
Это удобно для локальной проверки.

### В production
Подключите Twilio через переменные:

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=...
```

После этого коды будут уходить как SMS.

## Деплой на сервер

### Вариант 1: Docker Compose

На сервере:

```bash
git clone <ваш-репозиторий>
cd telegram-clone
cp .env.example .env
nano .env
```

Измените минимум:

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=очень_длинный_секрет
ALLOW_DEV_CODE_RESPONSE=false
DB_HOST=postgres
DB_PORT=5432
DB_NAME=messenger
DB_USER=messenger
DB_PASSWORD=strong_password
```

Далее:

```bash
docker compose up -d --build
```

## Что желательно сделать на сервере поверх этого

- поставить Nginx как reverse proxy;
- включить HTTPS через Let's Encrypt;
- закрыть прямой доступ к PostgreSQL извне;
- настроить резервные копии базы и папки `uploads/`;
- ограничить размер логов и включить мониторинг.

## Структура проекта

```text
telegram-clone/
  public/
    index.html
    styles.css
    app.js
  src/
    routes/
      auth.js
      users.js
      chats.js
    auth.js
    chatService.js
    config.js
    db.js
    init.sql
    server.js
    sms.js
    socket.js
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
```


