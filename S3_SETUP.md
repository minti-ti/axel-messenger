# Настройка облачного хранилища для Render

Аватарки и файлы должны храниться в облаке, так как Render имеет эфемерную файловую систему (файлы удаляются при перезагрузке).

## Рекомендуемые варианты S3-совместимого хранилища

### 1. **AWS S3** (платный, но есть free tier)
- https://aws.amazon.com/s3/
- 5GB бесплатно в первый год
- Минимум затрат после

### 2. **Backblaze B2** (дешевый, рекомендуется)
- https://www.backblaze.com/b2/
- 10GB бесплатно, потом $0.006 за GB
- S3-совместимый API
- Лучшее соотношение цена/качество

### 3. **DigitalOcean Spaces** (простой, $5/месяц)
- https://www.digitalocean.com/products/spaces/
- Простая настройка
- $5/месяц + трафик

### 4. **Linode Object Storage** (как DO Spaces, $5/месяц)
- https://www.linode.com/products/object-storage/
- S3-совместимый

## Быстрая настройка Backblaze B2 (рекомендуется)

### Шаг 1: Создайте аккаунт Backblaze
1. Зарегистрируйтесь на https://www.backblaze.com/b2/
2. Создайте бакет (например, `my-app-files`)
3. Установите жизненный цикл файлов: "Keep for" = "Forever"

### Шаг 2: Получите ключи доступа
1. Перейдите в "Account" → "Application Keys"
2. Нажмите "Create Application Key"
3. Выберите "Allow access to bucket(s)" → выберите ваш бакет
4. Скопируйте:
   - **Application Key ID** (это accessKeyId)
   - **Application Key** (это secretAccessKey)

### Шаг 3: Получите endpoint
- Для Backblaze B2: `https://s3.YOUR_REGION.backblazeb2.com`
- Узнайте регион в "Bucket Settings"

### Шаг 4: Добавьте переменные на Render

На странице вашего приложения в Render перейдите в **Settings** → **Environment** и добавьте:

```
STORAGE_MODE=s3
S3_BUCKET=my-app-files
S3_REGION=us-west-001
S3_ENDPOINT=https://s3.us-west-001.backblazeb2.com
S3_ACCESS_KEY_ID=your_application_key_id_here
S3_SECRET_ACCESS_KEY=your_application_key_here
```

### Шаг 5: Перезагрузите приложение

После добавления переменных окружения приложение автоматически перезагрузится и будет использовать S3.

## Настройка AWS S3

Если используете AWS S3:

```
STORAGE_MODE=s3
S3_BUCKET=my-bucket-name
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

## Настройка DigitalOcean Spaces

```
STORAGE_MODE=s3
S3_BUCKET=my-space-name
S3_REGION=nyc3
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_ACCESS_KEY_ID=your_spaces_key
S3_SECRET_ACCESS_KEY=your_spaces_secret
```

## Проверка

После настройки:
1. Загрузите аватарку в профиле
2. Перезагрузите страницу — аватарка должна остаться
3. Подождите 10-15 минут, перезагрузите приложение на Render
4. Аватарка все еще должна быть видна

## Миграция существующих файлов

Если у вас уже есть локальные файлы в папке `uploads/`, их нужно вручную загрузить в S3:

```bash
# Для Backblaze B2:
rclone sync ./uploads s3:my-app-files/

# Или используйте AWS CLI:
aws s3 sync ./uploads s3://my-bucket-name/
```

## Полезные команды

### Просмотр файлов в Backblaze B2
https://secure.backblaze.com/b2_buckets.html → выберите бакет → "Files"

### Очистка старых файлов
Установите жизненный цикл в настройках бакета на Backblaze B2 или используйте S3 Life Cycle Rules в AWS.

## Стоимость

- **Backblaze B2**: 10GB бесплатно, потом ~$0.006/GB (очень дешево)
- **AWS S3**: ~$0.023/GB (free tier: 5GB/месяц первый год)
- **DO Spaces**: $5/месяц (250GB включено)
- **Linode**: $5/месяц (250GB включено)

## Помощь

Если что-то не работает:
1. Проверьте переменные окружения (Settings → Environment на Render)
2. Посмотрите логи приложения (Logs на Render)
3. Убедитесь, что ключи доступа скопированы без пробелов
4. Проверьте, что бакет создан и доступен
