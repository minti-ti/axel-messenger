# Развертывание на Render

## ⚠️ Важно: Используйте облачное хранилище

Render имеет **эфемерную файловую систему** — все локальные файлы удаляются при перезагрузке контейнера (каждые 24-48 часов). Поэтому **ОБЯЗАТЕЛЬНО** используйте S3-совместимое хранилище для файлов и аватарок.

## Быстрый старт на Render

### Шаг 1: Подготовка

1. Загрузите проект на GitHub
2. Убедитесь, что есть файл `package.json` и `Dockerfile` (или используйте Native Environments)

### Шаг 2: Создание PostgreSQL на Render

1. Войдите на https://render.com/
2. Нажмите **New +** → **PostgreSQL**
3. Заполните данные:
   - **Name**: `messenger-db`
   - **Database**: `messenger`
   - **User**: `messenger`
   - **Region**: выберите ближайший
   - **Plan**: выберите нужный (Free для тестирования)
4. Скопируйте строку подключения (начинается с `postgresql://`)

### Шаг 3: Создание Web Service

1. Нажмите **New +** → **Web Service**
2. **Connect** → выберите ваш GitHub репозиторий
3. Заполните данные:
   - **Name**: `messenger-app`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node src/server.js`
   - **Plan**: выберите нужный

### Шаг 4: Переменные окружения

В окне Web Service перейдите в **Settings** → **Environment**

Добавьте переменные:

```
NODE_ENV=production
PORT=3000
APP_URL=https://messenger-app.onrender.com
JWT_SECRET=generate_a_very_long_random_string_here_at_least_32_chars
DATABASE_URL=postgresql://user:password@host/dbname
ALLOW_DEV_CODE_RESPONSE=false
```

### Шаг 5: Настройка S3 (ОБЯЗАТЕЛЬНО!)

Следуйте инструкциям в [S3_SETUP.md](./S3_SETUP.md) и добавьте эти переменные:

```
STORAGE_MODE=s3
S3_BUCKET=your-bucket-name
S3_REGION=region-code
S3_ENDPOINT=https://endpoint-url
S3_ACCESS_KEY_ID=your_key_id
S3_SECRET_ACCESS_KEY=your_secret_key
```

### Шаг 6: Инициализация БД

После первого развертывания БД автоматически инициализируется (если в коде есть проверка).

Если нужно вручную:

```bash
# Подключитесь к PostgreSQL на Render через psql или любой SQL клиент
# И выполните src/init.sql
```

## Проверка работы

1. Перейдите на `https://yourdomain.onrender.com`
2. Протестируйте вход и загрузку файлов
3. Проверьте, что файлы сохраняются в S3 (посмотрите в консоли S3)
4. Подождите перезагрузку приложения
5. Файлы должны остаться видны

## Рекомендуемая конфигурация на Render

### Для Production (платно)

- **Web Service**: Standard (0.5 CPU, 1GB RAM) = ~$12/месяц
- **PostgreSQL**: Standard = ~$15/месяц
- **S3-хранилище**: Backblaze B2 (дешево) = ~$0-5/месяц

**Итого**: ~$27-32/месяц при среднем использовании

### Для Small Projects (экономия)

- **Web Service**: Free (автоспит после 15 минут неактивности)
- **PostgreSQL**: Free (512MB)
- **S3**: Backblaze B2 Free (10GB)

**Итого**: Бесплатно!

## Возможные проблемы

### 1. "Files not persisting after deployment"

**Решение**: Вы используете локальное хранилище. Установите S3 переменные окружения.

### 2. "Database connection failed"

**Решение**: Проверьте `DATABASE_URL` в Environment Variables

### 3. "Application starting but not responding"

**Проверьте:**
- Логи в Render Dashboard
- PORT переменная установлена на 3000
- DATABASE_URL скопирана правильно

### 4. "File uploads not working"

**Решение**: Проверьте S3 переменные окружения и прав доступа к бакету

## Обновление приложения

Просто запушьте изменения на GitHub — Render автоматически перезагрузит приложение.

## Масштабирование

Если нужно больше мощности:
1. На странице Web Service нажмите **Settings** → **Instance Type**
2. Выберите более мощный план (Pro, Business и т.д.)
3. Приложение перезагрузится на новых ресурсах

## Справка по S3 провайдерам

Смотрите [S3_SETUP.md](./S3_SETUP.md) для подробных инструкций по выбору и настройке S3-совместимого хранилища.
