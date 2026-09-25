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
