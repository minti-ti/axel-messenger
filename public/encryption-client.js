/**
 * Клиентская часть шифрования
 * Расшифровывает сообщения полученные с сервера
 */

const CryptoEncryption = (() => {
  const ALGORITHM = 'AES-GCM';
  const IV_SIZE = 16; // bytes
  const AUTH_TAG_SIZE = 16; // bytes

  /**
   * Конвертирует hex string в Uint8Array
   */
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /**
   * Конвертирует Uint8Array в hex string
   */
  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Импортирует hex-ключ как CryptoKey для WebCrypto API
   */
  async function importKey(hexKey) {
    const keyBytes = hexToBytes(hexKey);
    return await window.crypto.subtle.importKey('raw', keyBytes, ALGORITHM, false, ['decrypt']);
  }

  /**
   * Расшифровывает сообщение
   * Формат: IV(32 hex chars) + AuthTag(32 hex chars) + Ciphertext(hex)
   */
  async function decrypt(encryptedHex, keyHex) {
    try {
      // Извлекаем компоненты
      const ivHex = encryptedHex.substring(0, IV_SIZE * 2);
      const authTagHex = encryptedHex.substring(IV_SIZE * 2, IV_SIZE * 2 + AUTH_TAG_SIZE * 2);
      const ciphertextHex = encryptedHex.substring(IV_SIZE * 2 + AUTH_TAG_SIZE * 2);

      const iv = hexToBytes(ivHex);
      const authTag = hexToBytes(authTagHex);
      const ciphertext = hexToBytes(ciphertextHex);

      // Объединяем ciphertext + authTag (требуется для WebCrypto GCM)
      const encryptedData = new Uint8Array(ciphertext.length + authTag.length);
      encryptedData.set(ciphertext);
      encryptedData.set(authTag, ciphertext.length);

      // Импортируем ключ
      const key = await importKey(keyHex);

      // Расшифровываем
      const decrypted = await window.crypto.subtle.decrypt(
        {
          name: ALGORITHM,
          iv: iv
        },
        key,
        encryptedData
      );

      // Конвертируем в строку
      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('Decryption failed:', error);
      return '[Ошибка расшифровки]';
    }
  }

  /**
   * Шифрует сообщение (для отправки с клиента, если нужно)
   */
  async function encrypt(plaintext, keyHex) {
    try {
      const key = await importKey(keyHex);
      const iv = window.crypto.getRandomValues(new Uint8Array(IV_SIZE));
      
      const encoder = new TextEncoder();
      const data = encoder.encode(plaintext);

      const encryptedData = await window.crypto.subtle.encrypt(
        {
          name: ALGORITHM,
          iv: iv
        },
        key,
        data
      );

      // Извлекаем authTag (последние 16 байт)
      const ciphertext = encryptedData.slice(0, -AUTH_TAG_SIZE);
      const authTag = encryptedData.slice(-AUTH_TAG_SIZE);

      // Форматируем: IV + AuthTag + Ciphertext
      let result = bytesToHex(iv) + bytesToHex(new Uint8Array(authTag));
      result += bytesToHex(new Uint8Array(ciphertext));

      return result;
    } catch (error) {
      console.error('Encryption failed:', error);
      throw error;
    }
  }

  return {
    decrypt,
    encrypt,
    hexToBytes,
    bytesToHex
  };
})();

// Экспортируем для использования в app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CryptoEncryption;
}
