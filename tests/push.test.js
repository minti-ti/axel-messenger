'use strict';

// Smoke-тесты для pushService.
// Цель: гарантировать, что модуль:
//   - не падает при require, если VAPID-ключи не заданы;
//   - isPushReady() = false до initPush() без ключей;
//   - корректно подтягивает реальную web-push библиотеку, если ключи валидные;
//   - sendPushToUser() безопасно возвращает {0,0,0} при не-сконфигурированном
//     состоянии (не падает!).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'tests_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

test('pushService подгружается без ошибок и до initPush ничего не делает', () => {
  // Чистим кэш, чтобы тест не зависел от порядка запуска.
  delete require.cache[require.resolve('../src/pushService')];
  delete require.cache[require.resolve('../src/config')];
  const push = require('../src/pushService');
  assert.equal(typeof push.initPush, 'function');
  assert.equal(typeof push.isPushReady, 'function');
  assert.equal(push.isPushReady(), false, 'isPushReady() должен быть false до initPush');
  assert.equal(push.getPublicKey(), null);
});

test('sendPushToUser возвращает нулевую статистику, если push не настроен', async () => {
  delete require.cache[require.resolve('../src/pushService')];
  const push = require('../src/pushService');
  const stats = await push.sendPushToUser('00000000-0000-0000-0000-000000000001', {
    title: 'x', body: 'y'
  });
  assert.deepEqual(stats, { sent: 0, removed: 0, failed: 0 });
});

test('initPush() реально включает push, если в окружении есть валидные VAPID-ключи', () => {
  // Не каждый dev запустит web-push install; если модуля нет — skip.
  let webpush;
  try {
    // eslint-disable-next-line global-require
    webpush = require('web-push');
  } catch (_) {
    console.log('  (web-push not installed, skipping live VAPID test)');
    return;
  }
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = publicKey;
  process.env.VAPID_PRIVATE_KEY = privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';

  // Перезагружаем config + pushService с новым env
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/pushService')];
  const push = require('../src/pushService');
  const ok = push.initPush();
  assert.equal(ok, true);
  assert.equal(push.isPushReady(), true);
  assert.equal(push.getPublicKey(), publicKey);

  // Чистим env, чтобы не влиять на другие тесты
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});
