import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiServices, GeminiTranscriber } from '../server/gemini.js';

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

test('streams translation updates before returning the complete caption', async () => {
  const service = Object.create(GeminiServices.prototype);
  service.translateModel = 'test-model';
  service.ai = {
    models: {
      async generateContentStream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { text: 'Hola ' };
            yield { text: 'mundo' };
          },
        };
      },
    },
  };
  const updates = [];

  const translated = await service.translate({
    text: 'Hello world',
    sourceLanguage: 'en-US',
    targetLanguage: 'es-ES',
    glossary: [],
    onUpdate: (text) => updates.push(text),
  });

  assert.deepEqual(updates, ['Hola', 'Hola mundo']);
  assert.equal(translated, 'Hola mundo');
});
