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
    this.translationActive = 0;
    this.translationPending = [];
    this.maxConcurrentTranslations = 2;
    this.lastChunkAt = null;
    this.lastEndMs = 0;
    this.previousOriginal = '';
    this.stopped = false;
  }

  async start() {
    const callbacks = {
      onOpen: () => this.setStatus('live'),
      onInterim: (text) => this.handleInterim(text),
      onFinal: (text) => this.handleFinal(text),
      onError: (error) => this.handleError(error),
      onClose: () => {
        if (!this.stopped) this.setStatus('disconnected');
      },
      onGoAway: () => {
        this.store.update(this.room.slug, (room) => { room.metrics.reconnects += 1; }, 'metrics');
      },
    };
    this.transcriber = this.demoMode
      ? new DemoTranscriber(callbacks)
      : this.gemini.createTranscriber({
          language: this.room.sourceLanguage,
          glossary: this.room.glossary,
          callbacks,
        });
    this.store.update(this.room.slug, (room) => {
      room.status = 'connecting';
      room.startedAt = new Date().toISOString();
      room.endedAt = null;
      room.interim = '';
      room.metrics.audioMs = 0;
    }, 'status');
    await this.transcriber.connect();
  }

  send(buffer) {
    if (this.stopped) return;
    this.lastChunkAt = Date.now();
    const audioMs = buffer.byteLength / 2 / 16_000 * 1_000;
    this.room.metrics.audioMs += audioMs;
    this.transcriber.send(buffer);
  }

  handleInterim(text) {
    const latency = this.lastChunkAt ? Date.now() - this.lastChunkAt : 0;
    this.store.update(this.room.slug, (room) => {
      room.interim = text.trim();
      if (latency >= 0) room.metrics.transcriptionLatencies.push(latency);
      room.metrics.transcriptionLatencies = room.metrics.transcriptionLatencies.slice(-200);
    }, 'interim');
  }

  handleFinal(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const receivedAt = Date.now();
    const endMs = Math.max(this.room.metrics.audioMs, this.lastEndMs + 500);
    const estimatedDuration = Math.max(1_000, clean.split(/\s+/).length / 2.4 * 1_000);
    const startMs = Math.max(this.lastEndMs, endMs - estimatedDuration);
    const segment = {
      id: `${this.room.slug}-${receivedAt}-${this.room.segments.length}`,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      original: clean,
      translated: '',
      originalAt: new Date(receivedAt).toISOString(),
      translatedAt: null,
    };
    this.lastEndMs = endMs;
    const transcriptLatency = this.lastChunkAt ? receivedAt - this.lastChunkAt : 0;
    this.store.update(this.room.slug, (room) => {
      room.interim = '';
      room.segments.push(segment);
      room.metrics.transcriptionLatencies.push(transcriptLatency);
      room.metrics.transcriptionLatencies = room.metrics.transcriptionLatencies.slice(-200);
    }, 'segment');
    const previousText = this.previousOriginal;
    this.previousOriginal = clean;
    const job = this.enqueueTranslation(() => this.translateSegment(segment, receivedAt, previousText))
      .catch((error) => this.handleTranslationError(segment, error))
      .finally(() => this.translationJobs.delete(job));
    this.translationJobs.add(job);
  }

  enqueueTranslation(task) {
    const job = new Promise((resolve, reject) => {
      this.translationPending.push({ task, resolve, reject });
    });
    this.pumpTranslations();
    return job;
  }

  pumpTranslations() {
    while (this.translationActive < this.maxConcurrentTranslations && this.translationPending.length) {
      const { task, resolve, reject } = this.translationPending.shift();
      this.translationActive += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this.translationActive -= 1;
          this.pumpTranslations();
        });
    }
  }

  async translateSegment(segment, startedAt, previousText = '') {
    let translated;
    if (this.demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 320));
      translated = DEMO_TRANSLATIONS.get(segment.original) || `[ES] ${segment.original}`;
    } else {
      translated = await this.gemini.translate({
        text: segment.original,
        sourceLanguage: this.room.sourceLanguage,
        targetLanguage: this.room.targetLanguage,
        glossary: this.room.glossary,
        previousText,
        onUpdate: (partial) => {
          this.store.update(this.room.slug, (room) => {
            const target = room.segments.find((item) => item.id === segment.id);
            if (target) target.translated = partial;
          }, 'translation-interim');
        },
      });
    }
    const latency = Date.now() - startedAt;
    this.store.update(this.room.slug, (room) => {
      const target = room.segments.find((item) => item.id === segment.id);
      if (target) {
        target.translated = translated;
        target.translatedAt = new Date().toISOString();
      }
      room.metrics.translationLatencies.push(latency);
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

  handleTranslationError(segment, error) {
    console.error(`[${this.room.slug}] translation`, error);
    this.store.update(this.room.slug, (room) => {
      const target = room.segments.find((item) => item.id === segment.id);
      if (target) target.translationError = error?.message || String(error);
      room.metrics.errors += 1;
      room.lastError = error?.message || String(error);
    }, 'translation-error');
  }

  setStatus(status) {
    this.store.update(this.room.slug, (room) => { room.status = status; }, 'status');
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    await this.transcriber?.end();
    await Promise.race([
      Promise.allSettled([...this.translationJobs]),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.store.update(this.room.slug, (room) => {
      room.status = 'ended';
      room.endedAt = new Date().toISOString();
      room.interim = '';
    }, 'status');
  }
}
