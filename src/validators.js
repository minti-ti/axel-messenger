/**
 * Базовые валидаторы входных данных без внешних зависимостей.
 * Используются для предварительной проверки в API-роутах.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(v, maxLen = Infinity) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidUUID(v) {
  return UUID_RE.test(String(v));
}

function isValidPhone(v) {
  return /^\+?[0-9\s\-()]{7,20}$/.test(String(v));
}

function isValidCode(v) {
  return /^\d{4,10}$/.test(String(v));
}

function sanitizeString(v, maxLen = 4000) {
  if (typeof v !== 'string') return '';
  return v.trim().substring(0, maxLen);
}

module.exports = {
  isNonEmptyString,
  isValidUUID,
  isValidPhone,
  isValidCode,
  sanitizeString
};
