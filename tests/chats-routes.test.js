'use strict';

// Regression-тест на список зарегистрированных маршрутов /api/chats/*.
//
// После рефакторинга разбили монолитный chats.js (1442 стр.) на 5 модулей
// в src/routes/chats/. Этот тест фиксирует ровно те 43 маршрута, что были
// в монолите — если кто-то случайно сломает подключение подроутера или
// потеряет хендлер, тест сразу упадёт.
//
// Использует только встроенный node:test, без supertest/express-моков.

const test = require('node:test');
const assert = require('node:assert/strict');

// Подменим authMiddleware и тяжёлые модули до того, как Express начнёт
// их подтягивать через src/routes/chats.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tests_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

function dumpRoutes(routerStack) {
  const out = [];
  for (const layer of routerStack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      methods.forEach((m) => out.push(`${m} ${layer.route.path}`));
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      out.push(...dumpRoutes(layer.handle.stack));
    }
  }
  return out;
}

const EXPECTED_ROUTES = [
  // Литеральные пути (из messages.js)
  'GET /search/messages',
  'GET /messages/:messageId/comments',
  'POST /messages/:messageId/comments',
  'POST /messages/delete-bulk',
  'POST /messages/forward-bulk',
  'GET /messages/:messageId',
  'PATCH /messages/:messageId',
  'DELETE /messages/:messageId',
  'POST /messages/:messageId/reactions',
  'POST /messages/:messageId/forward',
  // Параметризованные с :chatId (из messages.js)
  'POST /:chatId/pin/:messageId',
  'DELETE /:chatId/pin',
  'GET /:chatId/media',
  'POST /:chatId/scheduled',
  'GET /:chatId/messages',
  'POST /:chatId/read',
  'DELETE /:chatId/clear',
  'POST /:chatId/messages',
  // members.js
  'POST /:chatId/members',
  'PATCH /:chatId/members/:memberId',
  'PATCH /:chatId/members/:memberId/restrictions',
  'DELETE /:chatId/members/:memberId',
  'GET /:chatId/members',
  // invites.js
  'GET /public/:username',
  'POST /public/:username/join',
  'GET /join/:token',
  'POST /join/:token',
  'DELETE /:chatId/invites/:token',
  'GET /:chatId/invites',
  'POST /:chatId/invites',
  // core.js
  'GET /saved',
  'GET /',
  'POST /private',
  'POST /',
  'GET /username/:username',
  'GET /drafts/all',
  'PUT /:chatId/draft',
  'DELETE /:chatId/draft',
  'PATCH /:chatId/preferences',
  'PATCH /:chatId',
  'POST /:chatId/avatar',
  'GET /:chatId',
  'DELETE /:chatId'
];

test('Роутер /api/chats регистрирует ровно 43 ожидаемых маршрута', () => {
  const router = require('../src/routes/chats');
  const actual = dumpRoutes(router.stack).sort();
  const expected = EXPECTED_ROUTES.slice().sort();

  assert.equal(actual.length, expected.length,
    `Ожидалось ${expected.length} маршрутов, получено ${actual.length}`);

  const missing = expected.filter((r) => !actual.includes(r));
  const extra = actual.filter((r) => !expected.includes(r));
  assert.equal(missing.length, 0, `Отсутствуют: ${missing.join(', ')}`);
  assert.equal(extra.length, 0, `Лишние: ${extra.join(', ')}`);
});

test('Маршруты с литералами регистрируются раньше параметризованных-конфликтных', () => {
  const router = require('../src/routes/chats');
  const routes = dumpRoutes(router.stack);

  // GET /messages/:messageId должен идти РАНЬШЕ GET /:chatId/messages —
  // иначе запрос GET /messages/<uuid> попадёт в /:chatId/messages.
  const messagesGetIdx = routes.indexOf('GET /messages/:messageId');
  const chatMessagesGetIdx = routes.indexOf('GET /:chatId/messages');
  assert.ok(messagesGetIdx >= 0, 'GET /messages/:messageId не зарегистрирован');
  assert.ok(chatMessagesGetIdx >= 0, 'GET /:chatId/messages не зарегистрирован');
  assert.ok(messagesGetIdx < chatMessagesGetIdx,
    'GET /messages/:messageId должен быть зарегистрирован раньше GET /:chatId/messages');

  // /saved должен идти раньше /:chatId
  const savedIdx = routes.indexOf('GET /saved');
  const chatIdIdx = routes.indexOf('GET /:chatId');
  assert.ok(savedIdx >= 0 && chatIdIdx >= 0);
  assert.ok(savedIdx < chatIdIdx, 'GET /saved должен идти раньше GET /:chatId');

  // /drafts/all должен идти раньше /:chatId
  const draftsIdx = routes.indexOf('GET /drafts/all');
  assert.ok(draftsIdx >= 0);
  assert.ok(draftsIdx < chatIdIdx, 'GET /drafts/all должен идти раньше GET /:chatId');
});
