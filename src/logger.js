/**
 * Централизованный логгер на базе Pino.
 *
 * В production: JSON-логи, уровень 'info'.
 * В development: цветные человекочитаемые логи через pino-pretty.
 *
 * Использование:
 *   const log = require('./logger');
 *   log.info({ userId, chatId }, 'message sent');
 *   log.error({ err, userId }, 'failed to send push');
 *   log.warn('deprecated API called');
 *
 * Sentry: если задана ENV переменная SENTRY_DSN, все error-уровневые
 * сообщения автоматически отправляются в Sentry.
 */

const config = require('./config');

let pino;
try {
  pino = require('pino');
} catch (_) {
  // Fallback если pino не установлен (dev без npm install)
  const noop = () => {};
  const fake = { info: console.log, warn: console.warn, error: console.error, debug: noop, fatal: console.error, child: () => fake, level: 'info' };
  module.exports = fake;
  return;
}

const logger = pino({
  level: config.isProduction ? 'info' : 'debug',
  transport: config.isProduction ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// Sentry integration (опциональная)
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: config.nodeEnv,
      tracesSampleRate: 0.1
    });
    // Перехватываем error и fatal
    const originalError = logger.error.bind(logger);
    const originalFatal = logger.fatal.bind(logger);
    logger.error = function (...args) {
      try {
        const msg = typeof args[0] === 'string' ? args[0] : args[1] || 'error';
        const ctx = typeof args[0] === 'object' ? args[0] : {};
        Sentry.captureException(ctx.err || new Error(String(msg)), {
          extra: ctx
        });
      } catch (_) {}
      return originalError(...args);
    };
    logger.fatal = function (...args) {
      try {
        const msg = typeof args[0] === 'string' ? args[0] : args[1] || 'fatal';
        const ctx = typeof args[0] === 'object' ? args[0] : {};
        Sentry.captureException(ctx.err || new Error(String(msg)), {
          extra: ctx,
          level: 'fatal'
        });
      } catch (_) {}
      return originalFatal(...args);
    };
    logger.info('Sentry initialized');
  } catch (e) {
    logger.warn('Sentry DSN set but @sentry/node not installed — skipping');
  }
}

module.exports = logger;
