import { DemoTranscriber } from './demo-transcriber.js';

const DEMO_TRANSLATIONS = new Map([
  ['Welcome to Nerdearla. Today we are going to build an open source accessibility platform.', 'Bienvenidos a Nerdearla. Hoy vamos a construir una plataforma de accesibilidad de código abierto.'],
  ['Our architecture uses Kubernetes, WebSockets, Gemini and Redis Streams.', 'Nuestra arquitectura utiliza Kubernetes, WebSockets, Gemini y Redis Streams.'],
  ['The important part is not only accuracy, but also latency and simple operation.', 'Lo importante no es solo la precisión, sino también la latencia y una operación sencilla.'],
  ['One operator can monitor many rooms while the audience reads captions on any device.', 'Un operador puede supervisar muchas salas mientras el público lee los subtítulos en cualquier dispositivo.'],
]);

export class RoomRunner {
  constructor({ store, room, gemini, demoMode }) {
    this.store = store;
    this.room = room;
    this.gemini = gemini;
    this.demoMode = demoMode;
    this.transcriber = null;
    this.translationJobs = new Set();
    this.translationPending = [];
    this.translationPump = null;
    this.lastChunkAt = null;
    this.lastEndMs = 0;
    this.previousOriginal = '';
    this.stopping = false;
    this.stopped = false;
  }

  async start() {
    const callbacks = {
      onOpen: () => this.setStatus('live'),
      onInterim: (text) => this.handleInterim(text),
      onFinal: (text) => this.handleFinal(text),
      onTranslatedInterim: (text) => this.handleTranslatedInterim(text),
      onBilingualFinal: (caption) => this.handleBilingualFinal(caption),
      onError: (error) => this.handleError(error),
      onClose: () => {
        if (!this.stopped && !this.stopping) this.setStatus('disconnected');
      },
      onGoAway: () => {
        this.store.update(this.room.slug, (room) => { room.metrics.reconnects += 1; }, 'metrics');
      },
    };
    this.transcriber = this.demoMode
      ? new DemoTranscriber(callbacks)
      : this.gemini.createTranscriber({
          language: this.room.sourceLanguage,
          targetLanguage: this.room.targetLanguage,
          glossary: this.room.glossary,
          callbacks,
        });
    this.store.update(this.room.slug, (room) => {
      room.status = 'connecting';
      room.startedAt = new Date().toISOString();
      room.endedAt = null;
      room.interim = '';
      room.translatedInterim = '';
      room.metrics.audioMs = 0;
    }, 'status');
    await this.transcriber.connect();
  }

  send(buffer) {
    if (this.stopped || this.stopping) return;
    this.lastChunkAt = Date.now();
    const audioMs = buffer.byteLength / 2 / 16_000 * 1_000;
    this.room.metrics.audioMs += audioMs;
    this.transcriber.send(buffer);
  }

  handleInterim(text) {
    const latency = this.lastChunkAt ? Date.now() - this.lastChunkAt : 0;
    this.store.updateTransient(this.room.slug, (room) => {
      room.interim = text.trim();
      if (latency >= 0) room.metrics.transcriptionLatencies.push(latency);
      room.metrics.transcriptionLatencies = room.metrics.transcriptionLatencies.slice(-200);
    }, 'interim');
  }

  handleTranslatedInterim(text) {
    this.store.updateTransient(this.room.slug, (room) => {
      room.translatedInterim = String(text || '').trim();
    }, 'translation-interim');
  }

  handleBilingualFinal({ original, translated }) {
    const source = String(original || this.room.interim || '').trim();
    const target = String(translated || '').trim();
    if (!source && !target) return;
    this.handleFinal(source || target, target);
  }

  handleFinal(text, translatedText = '') {
    if (this.stopped) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    const liveTranslated = String(translatedText || '').trim();
    const receivedAt = Date.now();
    const endMs = Math.max(this.room.metrics.audioMs, this.lastEndMs + 500);
    const estimatedDuration = Math.max(1_000, clean.split(/\s+/).length / 2.4 * 1_000);
    const startMs = Math.max(this.lastEndMs, endMs - estimatedDuration);
    const segment = {
      id: `${this.room.slug}-${receivedAt}-${this.room.segments.length}`,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      original: clean,
      translated: liveTranslated,
      originalAt: new Date(receivedAt).toISOString(),
      translatedAt: liveTranslated ? new Date(receivedAt).toISOString() : null,
    };
    this.lastEndMs = endMs;
    const transcriptLatency = this.lastChunkAt ? receivedAt - this.lastChunkAt : 0;
    this.store.update(this.room.slug, (room) => {
      room.interim = '';
      room.translatedInterim = '';
      room.segments.push(segment);
      room.metrics.transcriptionLatencies.push(transcriptLatency);
      room.metrics.transcriptionLatencies = room.metrics.transcriptionLatencies.slice(-200);
      if (liveTranslated) {
        room.metrics.translationLatencies.push(transcriptLatency);
        room.metrics.translationLatencies = room.metrics.translationLatencies.slice(-200);
      }
    }, 'segment');
    const previousText = this.previousOriginal;
    this.previousOriginal = clean;
    if (liveTranslated) return;
    this.translationPending.push({ segment, startedAt: receivedAt, previousText });
    this.startTranslationPump();
  }

  startTranslationPump() {
    if (this.stopped || this.stopping || this.translationPump || !this.translationPending.length) return;
    const job = Promise.resolve()
      .then(() => this.pumpTranslationBatches())
      .finally(() => {
        this.translationJobs.delete(job);
        if (this.translationPump === job) this.translationPump = null;
        if (!this.stopped && !this.stopping && this.translationPending.length) this.startTranslationPump();
      });
    this.translationPump = job;
    this.translationJobs.add(job);
  }

  async pumpTranslationBatches() {
    while (!this.stopped && !this.stopping && this.translationPending.length) {
      if (!this.demoMode) await this.gemini.reserveTranslationSlot();
      if (this.stopped) break;
      const items = this.translationPending.splice(0, 8);
      try {
        await this.translateSegments(items, { slotReserved: !this.demoMode });
      } catch (error) {
        this.handleTranslationError(items, error);
      }
    }
  }

  async translateSegments(items, { slotReserved = false } = {}) {
    let translations;
    if (this.demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 320));
      translations = items.map(({ segment }) => DEMO_TRANSLATIONS.get(segment.original) || `[ES] ${segment.original}`);
    } else {
      translations = await this.gemini.translateBatch({
        captions: items.map(({ segment }) => segment.original),
        sourceLanguage: this.room.sourceLanguage,
        targetLanguage: this.room.targetLanguage,
        glossary: this.room.glossary,
        previousText: items[0]?.previousText || '',
        slotReserved,
      });
    }
    const completedAt = Date.now();
    this.store.update(this.room.slug, (room) => {
      for (const [index, { segment, startedAt }] of items.entries()) {
        const target = room.segments.find((item) => item.id === segment.id);
        if (target) {
          target.translated = translations[index];
          target.translatedAt = new Date(completedAt).toISOString();
          delete target.translationError;
        }
        room.metrics.translationLatencies.push(completedAt - startedAt);
      }
      room.metrics.translationLatencies = room.metrics.translationLatencies.slice(-200);
    }, 'translation');
  }

  handleError(error) {
    console.error(`[${this.room.slug}]`, error);
    this.store.update(this.room.slug, (room) => {
      room.status = 'error';
      room.metrics.errors += 1;
      room.lastError = error?.message || String(error);
    }, 'error');
  }

  handleTranslationError(items, error) {
    console.error(`[${this.room.slug}] translation`, error);
    this.store.update(this.room.slug, (room) => {
      for (const { segment } of items) {
        const target = room.segments.find((item) => item.id === segment.id);
        if (target) target.translationError = error?.message || String(error);
      }
      room.metrics.errors += 1;
      room.lastError = error?.message || String(error);
    }, 'translation-error');
  }

  setStatus(status) {
    this.store.update(this.room.slug, (room) => { room.status = status; }, 'status');
  }

  async stop() {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    await this.transcriber?.end();
    // Keep accepting Live API callbacks while end() drains the final caption.
    // Mark the runner stopped only after that last response has arrived.
    this.stopped = true;
    this.translationPending.length = 0;
    await Promise.race([
      Promise.allSettled([...this.translationJobs]),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.store.update(this.room.slug, (room) => {
      room.status = 'ended';
      room.endedAt = new Date().toISOString();
      room.interim = '';
      room.translatedInterim = '';
    }, 'status');
  }
}
