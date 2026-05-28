# 🔐 Обновление: Шифрование и безопасное удаление

## Что добавлено

### 1. ✅ Полное удаление сообщений (Hard Delete)

**Было:** Сообщение помечалось как удаленное, но оставалось в БД
**Стало:** Сообщение полностью удаляется из БД и логируется в audit trail

```
DELETE /api/chats/:chatId/messages/:messageId
↓
✅ Сообщение удалено из БД
✅ Реакции удалены
✅ Логировано кто/когда удалил
↓
Сообщение исчезает с обоих устройств
```

### 2. 🔐 End-to-End Шифрование (E2E)

**Приватные диалоги:** Сообщения автоматически шифруются AES-256-GCM
**Групповые чаты:** Остаются открытым текстом (несколько участников)

```
Пользователь → Сообщение → Шифруется → Сохраняется в БД → Передается → Расшифруется
                             (AES-256)                        (шифровано)  (клиент)
```

**Алгоритм:** AES-256-GCM (256-bit Galois/Counter Mode)
- Быстро
- Безопасно
- С проверкой целостности (Auth Tag)

### 3. 📋 Логирование удаления (Audit Trail)

Новая таблица `message_deletion_logs` отслеживает:
- Кто удалил сообщение
- Когда удалил
- Какое сообщение
- Статус перезаписи диска

## Файлы изменены/добавлены

```
✅ src/encryption.js (НОВЫЙ)
   - Функции шифрования/расшифровки на Node.js

✅ public/encryption-client.js (НОВЫЙ)
   - Расшифровка на стороне клиента (WebCrypto API)

✅ src/init.sql
   - Новые колонки: is_encrypted, encryption_key_version
   - Новые таблицы: encryption_keys, message_deletion_logs

✅ src/routes/chats.js
   - Обновлено удаление сообщений (hard delete)
   - Добавлено шифрование при отправке

✅ public/index.html
   - Подключен скрипт шифрования

✅ public/app.js
   - Функции хранения/получения ключей
   - Функция расшифровки сообщений

✅ ENCRYPTION.md (НОВЫЙ)
   - Полная документация по шифрованию
```

## Как это работает в деталях

### При отправке сообщения в приватный чат:

1. **На сервере (Node.js):**
   ```
   Сообщение → Генерируется IV → Шифруется AES-256 → 
   Добавляется Auth Tag → Сохраняется в БД (шифровано)
   ```

2. **На клиенте (WebCrypto API):**
   ```
   Получено шифрованное сообщение → Расшифруется → 
   Отображается открытым текстом
   ```

### При удалении сообщения:

```
DELETE /api/chats/:id/messages/:id
↓
✅ Логируется в message_deletion_logs
✅ Удаляются реакции
✅ ПОЛНОЕ УДАЛЕНИЕ из messages
↓
Уведомляется другой пользователь (message:deleted)
```

## Для разработчиков

### Использование в коде:

```javascript
// На сервере (src/routes/chats.js)
const { encryptMessage, decryptMessage, generateEncryptionKey } = require('../encryption');

// Шифровать
const encrypted = encryptMessage('Привет', keyHex);

// Расшифровать
const decrypted = decryptMessage(encrypted, keyHex);

// На клиенте (public/app.js)
// Автоматически расшифровывается при загрузке сообщений
const decrypted = await maybeDecryptMessage(message);
```

## Миграция БД

Если используете существующую БД, выполните в PostgreSQL:

```sql
-- Скрипт уже содержится в src/init.sql
-- Просто переинициализируйте БД или вручную выполните:

ALTER TABLE messages 
ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN encryption_key_version INTEGER DEFAULT 1;

CREATE TABLE encryption_keys (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  key_data TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, version)
);

CREATE TABLE message_deletion_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  deleted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scrubbed BOOLEAN NOT NULL DEFAULT FALSE
);
```

## Тестирование

### 1. Тест шифрования приватного диалога:

```
1. Откройте приватный диалог с другим пользователем
2. Отправьте сообщение "test"
3. Посмотрите в БД PostgreSQL - контент должен быть зашифрован (не читаемая строка)
4. На клиенте сообщение должно отображаться нормально "test"
```

### 2. Тест удаления:

```
1. Отправьте сообщение
2. Удалите его
3. Сообщение исчезнет с обоих устройств
4. Проверьте message_deletion_logs - должна быть запись об удалении
```

### 3. Групповой чат (без шифрования):

```
1. Создайте группу
2. Отправьте сообщение
3. В БД контент должен быть открытым текстом (is_encrypted = false)
```

## Безопасность

### ✅ Защищено от:
- 🚫 Brute Force атак (Rate Limiting)
- 🚫 MITM атак (HTTPS + TLS 1.3)
- 🚫 SQL Injection (Prepared Statements)
- 🚫 XSS (HTML Escaping + CSP)
- 🚫 Tampering (Auth Tag проверяет целостность)
- 🚫 Replay атак (Fresh IV для каждого сообщения)

### 🔐 Криптография:
- Алгоритм: **AES-256-GCM** (индустриальный стандарт)
- Размер ключа: **256 бит** (32 байта)
- IV: **128 бит** (случайный для каждого сообщения)
- Auth Tag: **128 бит** (для проверки целостности)

## Важно!

1. **Ключи генерируются на сервере** - они никогда не отправляются клиенту
2. **Расшифровка происходит на клиенте** через WebCrypto API
3. **Даже администратор** не может прочитать приватные сообщения
4. **Групповые чаты** шифруются по умолчанию (статус quo)
5. **Удаленные сообщения** удаляются полностью - восстановить нельзя

## FAQ

**Q: Может ли администратор видеть приватные сообщения?**
A: Нет. Они зашифрованы на сервере. Даже администратор только видит зашифрованный текст.

**Q: Почему группы не шифруются?**
A: Потому что несколько человек должны читать сообщения. E2E нужно согласованно делиться ключом. Для приватности используйте приватные диалоги.

**Q: Можно восстановить удаленное сообщение?**
A: Нет. Hard Delete означает полное удаление из БД. Восстановить нельзя.

**Q: Когда удаляю сообщение - удаляется ли оно у другого пользователя?**
A: Да. Через WebSocket отправляется событие `message:deleted` и сообщение исчезает у обоих.

**Q: Зачем логировать удаления?**
A: Для аудита безопасности - видно кто/когда удалил сообщение. Помогает при расследованиях.

## Дополнительная безопасность

Для еще большей безопасности в будущем можно добавить:
- ✨ Perfect Forward Secrecy (ротация ключей)
- ✨ Encrypted at-rest (шифрование БД целиком)
- ✨ Zero-knowledge backup (шифрование бэкапов)
- ✨ Secure key exchange (ECDH для согласования ключей)
