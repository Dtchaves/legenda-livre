import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, normalizeTheme } from '../public/theme.js';

test('provides modern and classic layouts', () => {
  assert.deepEqual(Object.keys(THEMES), ['modern', 'classic']);
  assert.equal(normalizeTheme('classic'), 'classic');
  assert.equal(normalizeTheme('modern'), 'modern');
});

test('falls back to modern for unknown saved values', () => {
  assert.equal(normalizeTheme('unknown'), 'modern');
  assert.equal(normalizeTheme(null), 'modern');
});
