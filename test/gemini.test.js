import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiTranscriber } from '../server/gemini.js';

test('finalizes continuous audio at the configured caption interval', async () => {
  const messages = [];
  const session = {
    sendRealtimeInput(message) {
      messages.push(message);
    },
    close() {},
  };
  const ai = {
    live: {
      async connect() {
        return session;
      },
    },
  };
  const transcriber = new GeminiTranscriber({
    ai,
    model: 'test-model',
    language: 'en-US',
    glossary: [],
    callbacks: {},
    captionSegmentMs: 200,
  });

  await transcriber.connect();
  transcriber.send(Buffer.alloc(3_200));
  assert.equal(messages.length, 1);
  transcriber.send(Buffer.alloc(3_200));

  assert.equal(messages.length, 3);
  assert.ok(messages[0].audio);
  assert.ok(messages[1].audio);
  assert.deepEqual(messages[2], { audioStreamEnd: true });

  transcriber.send(Buffer.alloc(3_200));
  assert.ok(messages[3].audio, 'the next chunk reopens the audio stream');
});
