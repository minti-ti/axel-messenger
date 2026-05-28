# 📦 Инструкция по деплою обновления на Render

## Шаг 1️⃣: Загрузите изменения на GitHub

```powershell
cd c:\Users\Ян\Downloads\telegram-clone

git add .
git commit -m "Add end-to-end encryption and hard delete for messages"
git push
```

## Шаг 2️⃣: Render автоматически обновится

1. Откройте https://dashboard.render.com
2. Перейдите в ваше приложение (messenger-app)
3. Нажмите **Logs** - должны увидеть сообщение о новом деплое

**Процесс:**
```
git push → GitHub → Render webhook → Новый build → Приложение перезагружается
                                      ↓ 2-3 минуты
                                   Готово!
```

## Шаг 3️⃣: Проверьте БД

Render использует Neon (PostgreSQL), там нужно выполнить миграцию.

### Способ 1: Автоматический (если у вас есть init скрипт)

Если в `src/server.js` есть проверка инициализации БД - она выполнится автоматически

### Способ 2: Вручную через Neon

1. Откройте [Neon Dashboard](https://console.neon.tech)
2. Выберите ваше приложение
3. Нажмите **SQL Editor**
4. Выполните код из `src/init.sql` или конкретно эту часть:

```sql
-- Добавляем новые колонки
ALTER TABLE messages 
ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN encryption_key_version INTEGER DEFAULT 1;

-- Создаем таблицы для ключей и логов
CREATE TABLE IF NOT EXISTS encryption_keys (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  key_data TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, version)
);

CREATE TABLE IF NOT EXISTS message_deletion_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  deleted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scrubbed BOOLEAN NOT NULL DEFAULT FALSE
);
```

## Шаг 4️⃣: Тестируйте функциональность

### Тест 1: Приватный диалог (с шифрованием)

```
1. Откройте приватный диалог
2. Отправьте сообщение "test"
3. В Render Logs должно быть: "Message encrypted for private chat"
4. На клиенте видите "test" открытым текстом ✓
```

### Тест 2: Групповой чат (без шифрования)

```
1. Создайте группу
2. Отправьте сообщение
3. Сообщение должно быть видно как обычно ✓
```

### Тест 3: Удаление сообщения

```
1. Отправьте сообщение
2. Удалите его
3. Сообщение исчезает с обоих устройств ✓
```

## Возможные проблемы

### Проблема 1: "Cannot add column is_encrypted"

**Причина:** Колонка уже существует

**Решение:** 
```sql
-- Проверьте, есть ли уже
SELECT column_name FROM information_schema.columns 
WHERE table_name='messages' AND column_name='is_encrypted';

-- Если да - пропустите добавление этой колонки
```

### Проблема 2: "Cannot create table encryption_keys"

**Причина:** Таблица уже существует (с другого деплоя)

**Решение:**
```sql
-- Проверьте наличие
SELECT EXISTS(
  SELECT 1 FROM information_schema.tables 
  WHERE table_name = 'encryption_keys'
);

-- Если есть - это нормально, ничего не делайте
```

### Проблема 3: "Messages не расшифровываются"

**Причина:** Скрипт `encryption-client.js` не загружается

**Решение:**
```
1. Проверьте браузер консоль (F12 → Console)
2. Должно быть сообщение: "GET /encryption-client.js 200"
3. Если 404 - значит файл не был загружен на Render

Пересмотрите public/index.html строка 8:
<script src="/encryption-client.js"></script>
```

## Откат (если что-то пошло не так)

### Откат кода:

```powershell
git revert HEAD --no-edit
git push
```

### Откат БД:

```sql
-- Удалить новые колонки (осторожно!)
ALTER TABLE messages 
DROP COLUMN IF EXISTS is_encrypted,
DROP COLUMN IF EXISTS encryption_key_version;

-- Удалить новые таблицы (осторожно!)
DROP TABLE IF EXISTS message_deletion_logs;
DROP TABLE IF EXISTS encryption_keys;
```

## Что изменилось на сервере

### Новые файлы:
- `src/encryption.js` - модуль шифрования
- `public/encryption-client.js` - расшифровка на клиенте
- `ENCRYPTION.md` - документация
- `ENCRYPTION_UPDATE.md` - это файл

### Измененные файлы:
- `src/init.sql` - новые колонки и таблицы
- `src/routes/chats.js` - шифрование и hard delete
- `public/index.html` - подключен скрипт шифрования
- `public/app.js` - расшифровка сообщений

### БД миграция:
- Новая колонка `messages.is_encrypted`
- Новая колонка `messages.encryption_key_version`
- Новая таблица `encryption_keys`
- Новая таблица `message_deletion_logs`

## Мониторинг

После деплоя проверьте в Render Logs:

```
Ищите сообщения:
✅ "Application started"
✅ "Database connected"
✅ Нет ошибок "Cannot find module"
✅ Socket.io connected
```

Если видите ошибки:
```
❌ "Cannot find module 'encryption'"
❌ "SyntaxError in src/routes/chats.js"
```

Проверьте что все файлы загружены на GitHub:
```powershell
git status
```

Должно быть пусто (все закоммичено)

## Когда готово

1. ✅ Все тесты прошли
2. ✅ Нет ошибок в логах
3. ✅ Приватные сообщения шифруются
4. ✅ Удаление работает
5. ✅ Групповые чаты работают как раньше

**Готово! Шифрование работает!** 🎉
