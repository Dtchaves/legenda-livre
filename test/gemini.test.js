import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLiveTranslateTranscriber, GeminiServices, GeminiTranscriber } from '../server/gemini.js';

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

test('streams original and translated text through one live session', async () => {
  const sent = [];
  let liveCallbacks;
  let liveConfig;
  const session = {
    sendRealtimeInput(message) { sent.push(message); },
    close() {},
  };
  const ai = {
    live: {
      async connect({ config, callbacks }) {
        liveConfig = config;
        liveCallbacks = callbacks;
        return session;
      },
    },
  };
  const interim = [];
  const translatedInterim = [];
  const finals = [];
  const transcriber = new GeminiLiveTranslateTranscriber({
    ai,
    model: 'live-translate-test',
    targetLanguageCode: 'es',
    captionSegmentMs: 200,
    callbacks: {
      onInterim: (text) => interim.push(text),
      onTranslatedInterim: (text) => translatedInterim.push(text),
      onBilingualFinal: (caption) => finals.push(caption),
    },
  });

  await transcriber.connect();
  assert.deepEqual(liveConfig.translationConfig, { targetLanguageCode: 'es', echoTargetLanguage: true });
  liveCallbacks.onmessage({
    serverContent: {
      inputTranscription: { text: 'Hello world', finished: true },
      outputTranscription: { text: 'Hola mundo', finished: true },
    },
  });
  transcriber.send(Buffer.alloc(3_200));

  assert.deepEqual(interim, ['Hello world']);
  assert.deepEqual(translatedInterim, ['Hola mundo']);
  assert.deepEqual(finals, [{ original: 'Hello world', translated: 'Hola mundo' }]);
  assert.ok(sent[0].audio);
});

test('commits continuous Live Translate captions without ending the audio stream', async () => {
  const sent = [];
  const finals = [];
  let liveCallbacks;
  const transcriber = new GeminiLiveTranslateTranscriber({
    ai: {
      live: {
        async connect({ callbacks }) {
          liveCallbacks = callbacks;
          return {
            sendRealtimeInput(message) { sent.push(message); },
            close() {},
          };
        },
      },
    },
    model: 'live-translate-test',
    targetLanguageCode: 'es',
    captionSegmentMs: 200,
    callbacks: { onBilingualFinal: (caption) => finals.push(caption) },
  });

  await transcriber.connect();
  transcriber.send(Buffer.alloc(3_200));
  transcriber.send(Buffer.alloc(3_200));
  assert.equal(sent.some((message) => message.audioStreamEnd), false);

  liveCallbacks.onmessage({
    serverContent: {
      inputTranscription: { text: 'Continuous speech' },
      outputTranscription: { text: 'Habla continua' },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.deepEqual(finals, [{ original: 'Continuous speech', translated: 'Habla continua' }]);
  assert.equal(sent.some((message) => message.audioStreamEnd), false);
});

test('translates a structured caption batch without long SDK retries', async () => {
  const service = Object.create(GeminiServices.prototype);
  service.translateModel = 'test-model';
  service.translationIntervalMs = 0;
  service.nextTranslationAt = 0;
  service.translationSlot = Promise.resolve();
  let request;
  service.ai = {
    models: {
      async generateContent(params) {
        request = params;
        return { text: JSON.stringify(['Hola mundo', 'Segunda leyenda']) };
      },
    },
  };

  const translated = await service.translateBatch({
    captions: ['Hello world', 'Second caption'],
    sourceLanguage: 'en-US',
    targetLanguage: 'es-ES',
    glossary: [],
  });

  assert.deepEqual(translated, ['Hola mundo', 'Segunda leyenda']);
  assert.equal(request.config.responseMimeType, 'application/json');
  assert.equal(request.config.responseJsonSchema.minItems, 2);
  assert.equal(request.config.responseJsonSchema.maxItems, 2);
  assert.equal(request.config.httpOptions.timeout, 10_000);
  assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
});
