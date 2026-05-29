# Axel Messenger

Современный мессенджер с поддержкой личных чатов, групп, каналов и сквозного шифрования.

![Axel Messenger](https://via.placeholder.com/800x400/0f172a/64748b?text=Axel+Messenger)

## ✨ Возможности

- **Регистрация по номеру телефона** + подтверждение через SMS (через Telegram-бота)
- **Личные чаты, группы и каналы**
- **Сквозное шифрование** сообщений (AES-256-GCM)
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
| Шифрование    | AES-256-GCM (client-side)           |

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

- Helmet + CSP
- Rate limiting
- JWT с хранением сессий в БД
- Валидация и санитизация путей файлов
- Сквозное шифрование сообщений

Подробный аудит безопасности находится в файле `AUDIT_REPORT.md`.

## 📦 Бэкап

В папке `scripts/` есть скрипты для бэкапа базы данных:

- `backup.sh` — для Linux/macOS
- `backup.ps1` — для Windows

## 🗺 Roadmap

- [ ] Полноценная реализация Signal Protocol
- [ ] Push-уведомления
- [ ] Голосовые и видеозвонки (WebRTC)
- [ ] Мобильное приложение (React Native / Flutter)
- [ ] Тесты и CI/CD

## 🤝 Вклад

Pull requests приветствуются!

## 📄 Лицензия

MIT

---

**Axel Messenger** — сделано с ❤️