import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomStore } from './room-store.js';
import { GeminiServices } from './gemini.js';
import { RoomRunner } from './room-runner.js';
import { toSrt, toText, toVtt } from './exporters.js';
import { normalizeLanguageCode, SUPPORTED_LANGUAGE_CODES } from '../public/languages.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const publicDirectory = path.join(root, 'public');
const demoMode = String(process.env.DEMO_MODE || '').toLowerCase() === 'true';
const port = Number(process.env.PORT || 8080);
const store = new RoomStore({ dataDirectory: path.join(root, 'data') });
const gemini = demoMode || !process.env.GEMINI_API_KEY
  ? null
  : new GeminiServices({
      apiKey: process.env.GEMINI_API_KEY,
      transcribeModel: process.env.TRANSCRIBE_MODEL || 'gemini-3.5-transcribe-live',
      liveTranslateModel: process.env.LIVE_TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview',
      translateModel: process.env.TRANSLATE_MODEL || 'gemini-3.5-flash-lite',
      captionSegmentMs: process.env.CAPTION_SEGMENT_MS || 5_000,
      translationIntervalMs: process.env.TRANSLATION_INTERVAL_MS || 6_000,
    });
const runners = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(publicDirectory, { extensions: ['html'] }));

app.get('/healthz', (_request, response) => {
  response.json({ ok: true, demoMode, apiConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.get('/api/config', (_request, response) => {
  response.json({
    demoMode,
    apiConfigured: Boolean(process.env.GEMINI_API_KEY),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
  });
});

app.get('/api/rooms', (_request, response) => response.json(store.list()));

app.post('/api/rooms', (request, response) => {
  const title = String(request.body?.title || '').trim();
  if (!title) return response.status(400).json({ error: 'title is required' });
  const sourceLanguage = normalizeLanguageCode(request.body?.sourceLanguage || 'en-US');
  const targetLanguage = normalizeLanguageCode(request.body?.targetLanguage || 'es-419');
  if (sourceLanguage !== 'auto' && !SUPPORTED_LANGUAGE_CODES.has(sourceLanguage)) {
    return response.status(400).json({ error: 'unsupported spoken language' });
  }
  if (!SUPPORTED_LANGUAGE_CODES.has(targetLanguage)) {
    return response.status(400).json({ error: 'unsupported caption language' });
  }
  const room = store.create({ ...request.body, sourceLanguage, targetLanguage });
  return response.status(201).json(room);
});

app.get('/api/rooms/:slug', (request, response) => {
  const room = store.get(request.params.slug);
  if (!room) return response.status(404).json({ error: 'room not found' });
  return response.json(room);
});

app.patch('/api/rooms/:slug/languages', (request, response) => {
  const slug = request.params.slug;
  if (!store.get(slug)) return response.status(404).json({ error: 'room not found' });
  if (runners.has(slug)) {
    return response.status(409).json({ error: 'end the broadcast before changing languages' });
  }
  const sourceLanguage = normalizeLanguageCode(request.body?.sourceLanguage);
  const targetLanguage = normalizeLanguageCode(request.body?.targetLanguage);
  if (sourceLanguage !== 'auto' && !SUPPORTED_LANGUAGE_CODES.has(sourceLanguage)) {
    return response.status(400).json({ error: 'unsupported spoken language' });
  }
  if (!SUPPORTED_LANGUAGE_CODES.has(targetLanguage)) {
    return response.status(400).json({ error: 'unsupported caption language' });
  }
  const room = store.update(slug, (target) => {
    target.sourceLanguage = sourceLanguage;
    target.targetLanguage = targetLanguage;
  }, 'languages');
  return response.json(room);
});

app.delete('/api/rooms/:slug', (request, response) => {
  const slug = request.params.slug;
  if (!store.get(slug)) return response.status(404).json({ error: 'room not found' });
  if (runners.has(slug)) {
    return response.status(409).json({ error: 'stop the live session before deleting it' });
  }
  store.delete(slug);
  return response.status(204).end();
});

app.post('/api/rooms/:slug/reset', (request, response) => {
  if (runners.has(request.params.slug)) {
    return response.status(409).json({ error: 'stop the live session before resetting it' });
  }
  const room = store.update(request.params.slug, (target) => {
    target.status = 'idle';
    target.startedAt = null;
    target.endedAt = null;
    target.interim = '';
    target.translatedInterim = '';
    target.segments = [];
    target.metrics.audioMs = 0;
    target.metrics.errors = 0;
    target.metrics.reconnects = 0;
    target.metrics.transcriptionLatencies = [];
    target.metrics.translationLatencies = [];
  }, 'reset');
  if (!room) return response.status(404).json({ error: 'room not found' });
  return response.json(room);
});

app.get('/api/rooms/:slug/export', (request, response) => {
  const room = store.get(request.params.slug);
  if (!room) return response.status(404).json({ error: 'room not found' });
  const format = String(request.query.format || 'vtt').toLowerCase();
  const language = request.query.language === 'original' ? 'original' : 'translated';
  const exporters = {
    vtt: { content: toVtt(room.segments, language), type: 'text/vtt' },
    srt: { content: toSrt(room.segments, language), type: 'application/x-subrip' },
    txt: { content: toText(room.segments, language), type: 'text/plain' },
  };
  const selected = exporters[format];
  if (!selected) return response.status(400).json({ error: 'format must be vtt, srt, or txt' });
  response.type(selected.type);
  response.attachment(`${room.slug}-${language}.${format}`);
  return response.send(selected.content);
});

app.get(['/room/:slug/operator', '/room/:slug/captions', '/room/:slug/overlay'], (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'room.html'));
});

app.get('*path', (_request, response) => response.sendFile(path.join(publicDirectory, 'index.html')));

const server = http.createServer(app);
const sockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (websocket) => {
    sockets.emit('connection', websocket, request, url);
  });
});

sockets.on('connection', (socket, _request, url) => {
  const slug = url.searchParams.get('room');
  const role = url.searchParams.get('role') || 'viewer';
  const room = store.raw(slug);
  if (!room) {
    socket.close(1008, 'Room not found');
    return;
  }

  const send = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };
  const unsubscribe = store.subscribe(slug, send);
  send({ type: 'snapshot', room: store.get(slug), demoMode });

  if (role === 'viewer') {
    store.update(slug, (target) => { target.metrics.viewers += 1; }, 'metrics');
    socket.on('close', () => {
      unsubscribe();
      store.update(slug, (target) => {
        target.metrics.viewers = Math.max(0, target.metrics.viewers - 1);
      }, 'metrics');
    });
    return;
  }

  if (role !== 'ingest') {
    unsubscribe();
    socket.close(1008, 'Invalid role');
    return;
  }

  let runner = null;
  socket.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        runner?.send(data);
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === 'start') {
        if (!demoMode && !gemini) throw new Error('Set GEMINI_API_KEY or enable DEMO_MODE');
        if (runners.has(slug)) throw new Error('This room already has an active ingest connection');
        runner = new RoomRunner({ store, room, gemini, demoMode });
        runners.set(slug, runner);
        await runner.start();
        send({ type: 'ready', demoMode });
      }
      if (message.type === 'stop' && runner) {
        await runner.stop();
        runners.delete(slug);
        runner = null;
        send({ type: 'stopped' });
      }
    } catch (error) {
      console.error(error);
      send({ type: 'client-error', message: error.message });
      store.update(slug, (target) => {
        target.status = 'error';
        target.metrics.errors += 1;
        target.lastError = error.message;
      }, 'error');
    }
  });

  socket.on('close', async () => {
    unsubscribe();
    if (runner) {
      await runner.stop().catch(console.error);
      runners.delete(slug);
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Legenda Livre running at http://localhost:${port}`);
  console.log(demoMode ? 'DEMO_MODE is enabled (no Gemini calls)' : 'Gemini Live Translate enabled');
});
