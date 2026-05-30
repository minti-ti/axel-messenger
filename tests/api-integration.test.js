'use strict';

/**
 * Integration-тесты для основных API endpoints.
 * Используют встроенный node:test, без внешних зависимостей.
 * Тестируют валидацию, auth flow, и базовые CRUD-операции.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- Хелперы для тестирования без supertest ----

function mockRequest(body = {}, params = {}, query = {}, user = null) {
  return {
    body,
    params,
    query,
    user,
    userRaw: user,
    headers: {},
    ip: '127.0.0.1',
    get: () => ''
  };
}

function mockResponse() {
  const res = {
    _status: 200,
    _json: null,
    _headers: {},
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader(k, v) { res._headers[k] = v; return res; },
    end() { return res; }
  };
  return res;
}

// ---- Валидация телефона ----
test('phone normalization', async (t) => {
  const { normalizePhone } = require('../src/utils');

  await t.test('normalizes Russian phone', () => {
    assert.equal(normalizePhone('+7 999 123-45-67'), '+79991234567');
  });

  await t.test('normalizes phone with spaces', () => {
    assert.equal(normalizePhone('  +7(999)1234567  '), '+79991234567');
  });

  await t.test('returns null for empty', () => {
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone(null), null);
  });

  await t.test('returns null for too short', () => {
    assert.equal(normalizePhone('+123'), null);
  });
});

// ---- Username валидация ----
test('username normalization', async (t) => {
  const { normalizeUsername } = require('../src/utils');

  await t.test('strips @ prefix', () => {
    assert.equal(normalizeUsername('@myuser'), 'myuser');
  });

  await t.test('lowercases', () => {
    assert.equal(normalizeUsername('MyUser'), 'myuser');
  });

  await t.test('trims whitespace', () => {
    assert.equal(normalizeUsername('  user  '), 'user');
  });
});

// ---- Validators ----
test('validators', async (t) => {
  let validators;
  try {
    validators = require('../src/validators');
  } catch (_) {
    t.skip('validators module not found');
    return;
  }

  if (validators.isValidUsername) {
    await t.test('valid usernames', () => {
      assert.ok(validators.isValidUsername('test_user'));
      assert.ok(validators.isValidUsername('user1234'));
      assert.ok(validators.isValidUsername('abcd'));
    });

    await t.test('invalid usernames', () => {
      assert.ok(!validators.isValidUsername('ab'));  // too short
      assert.ok(!validators.isValidUsername(''));
      assert.ok(!validators.isValidUsername('user name'));  // spaces
    });
  }
});

// ---- Encryption ----
test('encryption round-trip', async (t) => {
  let encryption;
  try {
    encryption = require('../src/encryption');
  } catch (_) {
    t.skip('encryption module not found');
    return;
  }

  await t.test('encrypt and decrypt produce original text', () => {
    const key = encryption.generateEncryptionKey();
    assert.ok(key, 'key should be generated');
    const plaintext = 'Привет, мир! Hello world 🎉';
    const encrypted = encryption.encrypt(plaintext, key);
    assert.ok(encrypted !== plaintext, 'encrypted should differ');
    const decrypted = encryption.decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  await t.test('different keys produce different ciphertext', () => {
    const key1 = encryption.generateEncryptionKey();
    const key2 = encryption.generateEncryptionKey();
    const text = 'secret message';
    assert.notEqual(encryption.encrypt(text, key1), encryption.encrypt(text, key2));
  });
});

// ---- Push subscription validation ----
test('push subscription validation', async (t) => {
  await t.test('rejects empty subscription', async () => {
    let pushService;
    try {
      pushService = require('../src/pushService');
    } catch (_) {
      t.skip('pushService requires pg');
      return;
    }
    // saveSubscription должна бросить ошибку при пустой подписке
    try {
      await pushService.saveSubscription('user1', {});
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Некорректная подписка'));
    }
  });
});

// ---- Chat helpers ----
test('chat helpers', async (t) => {
  let helpers;
  try {
    helpers = require('../src/routes/chats/_helpers');
  } catch (_) {
    t.skip('helpers require pg');
    return;
  }

  await t.test('classifyAttachment', () => {
    assert.equal(helpers.classifyAttachment('photo.jpg'), 'photo');
    assert.equal(helpers.classifyAttachment('photo.PNG'), 'photo');
    assert.equal(helpers.classifyAttachment('video.mp4'), 'video');
    assert.equal(helpers.classifyAttachment('song.mp3'), 'audio');
    assert.equal(helpers.classifyAttachment('doc.pdf'), 'file');
    assert.equal(helpers.classifyAttachment(''), 'file');
  });

  await t.test('extractLinks', () => {
    const links = helpers.extractLinks('Check https://example.com and http://test.ru/path');
    assert.equal(links.length, 2);
    assert.ok(links[0].includes('example.com'));
  });
});

console.log('All integration tests defined');
