'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isNonEmptyString,
  isValidUUID,
  isValidPhone,
  isValidCode,
  sanitizeString
} = require('../src/validators');

test('isNonEmptyString корректно отсекает пустые и слишком длинные строки', () => {
  assert.equal(isNonEmptyString('hello'), true);
  assert.equal(isNonEmptyString('   '), false);
  assert.equal(isNonEmptyString(''), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString('abcdef', 3), false);
});

test('isValidUUID валидирует канонический формат', () => {
  assert.equal(isValidUUID('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(isValidUUID('A1B2C3D4-1111-2222-3333-444455556666'), true);
  assert.equal(isValidUUID('not-a-uuid'), false);
  assert.equal(isValidUUID(''), false);
});

test('isValidPhone принимает разумные форматы и режет мусор', () => {
  assert.equal(isValidPhone('+79991234567'), true);
  assert.equal(isValidPhone('+7 (999) 123-45-67'), true);
  assert.equal(isValidPhone('abc'), false);
  assert.equal(isValidPhone('+'), false);
});

test('isValidCode принимает 4..10 цифр', () => {
  assert.equal(isValidCode('1234'), true);
  assert.equal(isValidCode('123456'), true);
  assert.equal(isValidCode('12'), false);
  assert.equal(isValidCode('12345abc'), false);
});

test('sanitizeString режет до maxLen и убирает крайние пробелы', () => {
  assert.equal(sanitizeString('  hello   '), 'hello');
  assert.equal(sanitizeString('a'.repeat(5000), 10).length, 10);
  assert.equal(sanitizeString(undefined), '');
});
