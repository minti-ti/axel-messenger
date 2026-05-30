/**
 * ⚠️ ВАЖНО: Это НЕ end-to-end (E2E) шифрование!
 *
 * Данный модуль реализует SERVER-SIDE ENCRYPTION (шифрование на стороне сервера).
 *
 * Принцип работы:
 * 1. Ключ генерируется на СЕРВЕРЕ (не на клиенте)
 * 2. Ключ ХРАНИТСЯ на сервере в таблице encryption_keys
 * 3. Сервер расшифровывает сообщения для рендеринга
 *
 * Это означает:
 * - ⚠️ Администратор сервера может прочитать любые сообщения
 * - ⚠️ При взломе/утечке дампа БД злоумышленник получит и ключи, и шифротекст
 * - ⚠️ Это защита от случайного доступа (at-rest encryption), а не приватная переписка
 *
 * Для настоящего E2E шифрования (как в Signal/Telegram) необходима:
 * - Генерация ключей на клиенте
 * - Обмен публичными ключами между участниками
 * - Signal Protocol или аналог (X3DH + Double Ratchet)
 *
 * @module encryption
 */

const crypto = require('crypto');

// Алгоритм шифрования: AES-256-GCM
const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SIZE = 32; // 256 bits
const IV_SIZE = 16; // 128 bits
const AUTH_TAG_SIZE = 16; // 128 bits

/**
 * Генерирует новый ключ шифрования для приватного чата.
 * ⚠️ Ключ генерируется на СЕРВЕРЕ — это компромисс между безопасностью и удобством.
 *
 * @returns {string} 64-символьный hex-ключ (256 бит)
 */
function generateEncryptionKey() {
  return crypto.randomBytes(ENCRYPTION_KEY_SIZE).toString('hex');
}

/**
 * Шифрует текст сообщения.
 * ⚠️ Шифрование выполняется на сервере. Ключ доступен серверу.
 *
 * @param {string} plaintext - текст для шифрования
 * @param {string} key - ключ шифрования (64-символьный hex string, 256 бит)
 * @returns {string} зашифрованный текст (IV + ciphertext + authTag, все в hex)
 * @throws {Error} если plaintext или key не предоставлены, или key неверной длины
 */
function encryptMessage(plaintext, key) {
  if (!plaintext || !key) {
    throw new Error('Plaintext and key are required');
  }

  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== ENCRYPTION_KEY_SIZE) {
    throw new Error(`Key must be ${ENCRYPTION_KEY_SIZE} bytes`);
  }

  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Формат: IV(32 hex) + authTag(32 hex) + ciphertext(hex)
  // Это обеспечивает целостность данных (authenticated encryption)
  return iv.toString('hex') + authTag.toString('hex') + encrypted;
}

/**
 * Расшифровывает текст сообщения.
 * ⚠️ Расшифровка выполняется на сервере. Ключ доступен серверу.
 *
 * @param {string} encrypted - зашифрованный текст (IV + authTag + ciphertext в hex)
 * @param {string} key - ключ шифрования (64-символьный hex string, 256 бит)
 * @returns {string} расшифрованный текст
 * @throws {Error} если encrypted или key не предоставлены, или данные повреждены
 */
function decryptMessage(encrypted, key) {
  if (!encrypted || !key) {
    throw new Error('Encrypted text and key are required');
  }

  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== ENCRYPTION_KEY_SIZE) {
    throw new Error(`Key must be ${ENCRYPTION_KEY_SIZE} bytes`);
  }

  // Извлекаем компоненты из hex-строки
  const ivHex = encrypted.substring(0, IV_SIZE * 2); // IV в hex = 32 символа
  const authTagHex = encrypted.substring(IV_SIZE * 2, IV_SIZE * 2 + AUTH_TAG_SIZE * 2);
  const ciphertext = encrypted.substring(IV_SIZE * 2 + AUTH_TAG_SIZE * 2);

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Безопасно затирает данные из памяти.
 * ⚠️ JavaScript не гарантирует полного удаления данных из памяти.
 *
 * @param {Buffer} buffer - буфер для затирания
 */
function scrubBuffer(buffer) {
  if (buffer && buffer.length > 0) {
    crypto.randomFillSync(buffer);
  }
}

/**
 * Генерирует хеш для проверки целостности сообщения.
 * Используется для обнаружения изменений контента.
 *
 * @param {string} plaintext - текст сообщения
 * @returns {string} SHA-256 хеш в hex
 */
function hashMessage(plaintext) {
  return crypto
    .createHash('sha256')
    .update(plaintext)
    .digest('hex');
}

/**
 * Проверяет целостность сообщения по хешу.
 *
 * @param {string} plaintext - текст сообщения
 * @param {string} hash - ожидаемый SHA-256 хеш
 * @returns {boolean} true если хеш совпадает
 */
function verifyMessageHash(plaintext, hash) {
  const computedHash = hashMessage(plaintext);
  return computedHash === hash;
}

module.exports = {
  generateEncryptionKey,
  encryptMessage,
  decryptMessage,
  scrubBuffer,
  hashMessage,
  verifyMessageHash,
  ALGORITHM,
  ENCRYPTION_KEY_SIZE
};