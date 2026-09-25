import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, slugify } from '../server/room-store.js';

test('slugifies accented session titles', () => {
  assert.equal(slugify('IA, Acessibilidade & Escala!'), 'ia-acessibilidade-escala');
});

test('creates unique persistent rooms and calculates metrics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legenda-livre-'));
  const store = new RoomStore({ dataDirectory: directory });
  const first = store.create({ title: 'Main Stage', glossary: 'Gemini, Kubernetes' });
  const second = store.create({ title: 'Main Stage' });
  assert.equal(first.slug, 'main-stage');
  assert.equal(second.slug, 'main-stage-2');
  store.update(first.slug, (room) => room.metrics.translationLatencies.push(100, 200, 900));
  assert.equal(store.get(first.slug).metrics.translationP50Ms, 200);
  assert.equal(store.get(first.slug).metrics.translationP95Ms, 900);
  assert.ok(fs.existsSync(path.join(directory, 'main-stage.json')));
});

test('deletes a room and its persisted transcript', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legenda-delete-'));
  const store = new RoomStore({ dataDirectory: directory });
  const room = store.create({ title: 'Temporary Stage' });
  const filename = path.join(directory, `${room.slug}.json`);
  assert.ok(fs.existsSync(filename));
  assert.equal(store.delete(room.slug), true);
  assert.equal(store.get(room.slug), null);
  assert.equal(fs.existsSync(filename), false);
  assert.equal(store.delete(room.slug), false);
});
