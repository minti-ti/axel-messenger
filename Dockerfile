# syntax=docker/dockerfile:1.6

# ---- 1) Стадия установки зависимостей ----
# Используем npm ci (а не npm install) для детерминированных сборок:
# берётся ровно то, что в package-lock.json. --omit=dev исключает devDeps.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 2) Финальный минимальный образ ----
FROM node:20-alpine AS runtime
WORKDIR /app

# Базовые утилиты, нужные только для HEALTHCHECK
RUN apk add --no-cache wget tini \
 && addgroup -S app && adduser -S app -G app

# Зависимости — из stage deps (никакого npm в финальном слое)
COPY --from=deps /app/node_modules ./node_modules

# Исходники приложения. .dockerignore исключает .git, .env, uploads и т.д.
COPY --chown=app:app . .

ENV NODE_ENV=production \
    PORT=3000 \
    # Защищаемся от случайного запуска от root
    NPM_CONFIG_LOGLEVEL=warn

# Контейнер бежит как непривилегированный пользователь.
USER app

EXPOSE 3000

# Простой healthcheck — стучимся в /api/health, который проверяет и БД.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

# tini — корректный init: пробрасывает SIGTERM в node, чтобы pool.end()
# и graceful shutdown отработали при остановке контейнера.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
