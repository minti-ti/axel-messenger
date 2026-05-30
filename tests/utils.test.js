'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePhone,
  normalizeUsername,
  isValidUsername,
  makeCode,
  formatPublicUser
} = require('../src/utils');

test('normalizePhone приводит к каноничному виду', () => {
  assert.equal(normalizePhone('8 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizePhone('+7 999 123 45 67'), '+79991234567');
  assert.equal(normalizePhone('79991234567'), '+79991234567');
  assert.equal(normalizePhone(''), '');
});

test('normalizeUsername режет @ и приводит к нижнему регистру', () => {
  assert.equal(normalizeUsername('@MyUser'), 'myuser');
  assert.equal(normalizeUsername('   user_42  '), 'user_42');
  assert.equal(normalizeUsername(null), '');
});

test('isValidUsername принимает 4..32 [a-z0-9_]', () => {
  assert.equal(isValidUsername('abcd'), true);
  assert.equal(isValidUsername('a_'), false);
  assert.equal(isValidUsername('a'.repeat(33)), false);
  assert.equal(isValidUsername('UPPER'), false);
});

test('makeCode возвращает 6-значный код', () => {
  for (let i = 0; i < 20; i++) {
    const c = makeCode();
    assert.match(c, /^\d{6}$/);
  }
});

test('formatPublicUser выдаёт только публичные поля', () => {
  const out = formatPublicUser({
    id: 'u1',
    phone: '+7',
    username: 'me',
    display_name: 'Me',
    avatar_url: null,
    bio: 'hi',
    is_superadmin: true,
    created_at: 't1',
    last_seen: 't2',
    secret_token: 'must-not-leak'
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'avatarUrl', 'bio', 'createdAt', 'displayName',
    'id', 'isSuperadmin', 'lastSeen', 'phone', 'username'
  ]);
  assert.equal(out.isSuperadmin, true);
});
