# Security notes

В проект уже добавлены базовые меры безопасности:

- security headers через `helmet`
- rate limits для API
- ограничения по типам загружаемых файлов
- privacy settings для телефона / last seen / username lookup
- случайные invite tokens
- серверная синхронизация пользовательских данных через авторизованные endpoints

## Важно

Это **не равно полноценному security audit**.
Для production-уровня обязательно нужны:

- HTTPS
- reverse proxy (Nginx / Caddy)
- защищённые backups
- мониторинг логов
- отдельный аудит авторизации, прав и хранения файлов
- при необходимости end-to-end encryption как отдельный большой этап

## Чего пока нет

- полноценного E2E-шифрования сообщений
- KMS / envelope encryption для файлов
- аппаратного HSM / managed secrets
- external object storage encryption policy

Проект стал заметно безопаснее, но для боевого публичного сервиса нужен отдельный этап hardening и аудит.
