import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore } from '../server/room-store.js';
import { RoomRunner } from '../server/room-runner.js';

test('demo runner produces original and translated caption events', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legenda-runner-'));
  const store = new RoomStore({ dataDirectory: directory });
  const created = store.create({ title: 'Demo', sourceLanguage: 'en-US', targetLanguage: 'es' });
  const raw = store.raw(created.slug);
  const runner = new RoomRunner({ store, room: raw, gemini: null, demoMode: true });
  await runner.start();
  runner.send(Buffer.alloc(3_200));
  await new Promise((resolve) => setTimeout(resolve, 850));
  await runner.stop();
  const result = store.get(created.slug);
  assert.ok(result.segments.length >= 1);
  assert.match(result.segments[0].original, /Nerdearla/);
  assert.match(result.segments[0].translated, /Nerdearla/);
  assert.equal(result.status, 'ended');
});

test('batches queued captions into one translation request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legenda-runner-batch-'));
  const store = new RoomStore({ dataDirectory: directory });
  const created = store.create({ title: 'Live', sourceLanguage: 'en-US', targetLanguage: 'es' });
  const raw = store.raw(created.slug);
  const calls = [];
  const gemini = {
    async reserveTranslationSlot() {},
    async translateBatch({ captions }) {
      calls.push(captions);
      return ['Primera leyenda', 'Segunda leyenda', 'Tercera leyenda'];
    },
  };
  const runner = new RoomRunner({ store, room: raw, gemini, demoMode: false });

  runner.handleFinal('First caption');
  runner.handleFinal('Second caption');
  runner.handleFinal('Third caption');
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.allSettled([...runner.translationJobs]);

  assert.deepEqual(calls, [['First caption', 'Second caption', 'Third caption']]);
  const result = store.get(created.slug);
  assert.equal(result.segments[0].translated, 'Primera leyenda');
  assert.equal(result.segments[1].translated, 'Segunda leyenda');
  assert.equal(result.segments[2].translated, 'Tercera leyenda');
});
