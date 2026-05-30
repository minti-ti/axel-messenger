'use strict';

// Smoke-тесты для server-side AES-256-GCM.
// Используем встроенный node:test — никаких внешних зависимостей,
// чтобы CI оставался лёгким и быстрым.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateEncryptionKey,
  encryptMessage,
  decryptMessage,
  hashMessage,
  verifyMessageHash
} = require('../src/encryption');

test('generateEncryptionKey возвращает 64-символьный hex (256 бит)', () => {
  const key = generateEncryptionKey();
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('encrypt/decrypt round-trip восстанавливает исходный текст', () => {
  const key = generateEncryptionKey();
  const plaintext = 'Привет, мир! 🌍 Hello, world!';
  const ciphertext = encryptMessage(plaintext, key);

  assert.notEqual(ciphertext, plaintext);
  // 32 hex (IV) + 32 hex (authTag) + минимум 1 hex символ полезной нагрузки
  assert.ok(ciphertext.length > 64);
  assert.equal(decryptMessage(ciphertext, key), plaintext);
});

test('decrypt с неправильным ключом падает (AEAD-проверка)', () => {
  const k1 = generateEncryptionKey();
  const k2 = generateEncryptionKey();
  const ct = encryptMessage('secret', k1);
  assert.throws(() => decryptMessage(ct, k2));
});

test('хэш сообщения детерминирован и проверяется', () => {
  const plaintext = 'integrity check';
  const h = hashMessage(plaintext);
  assert.equal(h.length, 64);
  assert.ok(verifyMessageHash(plaintext, h));
  assert.equal(verifyMessageHash('tampered', h), false);
});

test('encrypt с ключом неверной длины бросает ошибку', () => {
  assert.throws(() => encryptMessage('x', 'deadbeef'));
});
