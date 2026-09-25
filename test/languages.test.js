import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  languageName,
  normalizeLanguageCode,
} from '../public/languages.js';

test('offers a broad unique BCP-47 language catalog', () => {
  assert.ok(LANGUAGES.length >= 80);
  assert.equal(SUPPORTED_LANGUAGE_CODES.size, LANGUAGES.length);
  assert.ok(SUPPORTED_LANGUAGE_CODES.has('pt-BR'));
  assert.ok(SUPPORTED_LANGUAGE_CODES.has('es-419'));
  assert.ok(SUPPORTED_LANGUAGE_CODES.has('cmn-Hans-CN'));
  assert.ok(SUPPORTED_LANGUAGE_CODES.has('yue-Hant-HK'));
});

test('normalizes legacy short codes and displays readable names', () => {
  assert.equal(normalizeLanguageCode('es'), 'es-419');
  assert.equal(normalizeLanguageCode('en'), 'en-US');
  assert.equal(languageName('pt-BR'), 'Portuguese (Brazil)');
  assert.equal(languageName('auto'), 'Automatic detection');
});
