const crypto = require('crypto');

// Алгоритм шифрования: AES-256-GCM
const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SIZE = 32; // 256 bits
const IV_SIZE = 16; // 128 bits
const AUTH_TAG_SIZE = 16; // 128 bits

/**
 * Генерирует новый ключ шифрования для приватного чата
 */
function generateEncryptionKey() {
  return crypto.randomBytes(ENCRYPTION_KEY_SIZE).toString('hex');
}

/**
 * Шифрует текст сообщения
 * @param {string} plaintext - текст для шифрования
 * @param {string} key - ключ шифрования (hex string)
 * @returns {string} зашифрованный текст (IV + ciphertext + authTag, все в hex)
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

  // Формат: IV(32) + authTag(32) + ciphertext(hex)
  return iv.toString('hex') + authTag.toString('hex') + encrypted;
}

/**
 * Расшифровывает текст сообщения
 * @param {string} encrypted - зашифрованный текст (IV + authTag + ciphertext)
 * @param {string} key - ключ шифрования (hex string)
 * @returns {string} расшифрованный текст
 */
function decryptMessage(encrypted, key) {
  if (!encrypted || !key) {
    throw new Error('Encrypted text and key are required');
  }

  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== ENCRYPTION_KEY_SIZE) {
    throw new Error(`Key must be ${ENCRYPTION_KEY_SIZE} bytes`);
  }

  // Извлекаем компоненты
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
 * Безопасно затирает данные из памяти
 * @param {Buffer} buffer - буфер для затирания
 */
function scrubBuffer(buffer) {
  if (buffer && buffer.length > 0) {
    crypto.randomFillSync(buffer);
  }
}

/**
 * Генерирует хеш для проверки целостности
 */
function hashMessage(plaintext) {
  return crypto
    .createHash('sha256')
    .update(plaintext)
    .digest('hex');
}

/**
 * Проверяет целостность сообщения
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
