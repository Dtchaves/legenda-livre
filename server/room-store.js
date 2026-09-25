import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function publicRoom(room) {
  return {
    id: room.id,
    slug: room.slug,
    title: room.title,
    speaker: room.speaker,
    sourceLanguage: room.sourceLanguage,
    targetLanguage: room.targetLanguage,
    glossary: room.glossary,
    status: room.status,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    interim: room.interim,
    translatedInterim: room.translatedInterim || '',
    segments: room.segments,
    metrics: {
      ...room.metrics,
      transcriptionP50Ms: percentile(room.metrics.transcriptionLatencies, 0.5),
      transcriptionP95Ms: percentile(room.metrics.transcriptionLatencies, 0.95),
      translationP50Ms: percentile(room.metrics.translationLatencies, 0.5),
      translationP95Ms: percentile(room.metrics.translationLatencies, 0.95),
    },
  };
}

export class RoomStore {
  constructor({ dataDirectory }) {
    this.dataDirectory = dataDirectory;
    this.rooms = new Map();
    this.listeners = new Map();
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.load();
  }

  load() {
    for (const filename of fs.readdirSync(this.dataDirectory)) {
      if (!filename.endsWith('.json')) continue;
      try {
        const room = JSON.parse(fs.readFileSync(path.join(this.dataDirectory, filename), 'utf8'));
        room.status = 'idle';
        room.interim = '';
        room.translatedInterim = '';
        room.metrics = {
          audioMs: 0,
          viewers: 0,
          errors: 0,
          reconnects: 0,
          transcriptionLatencies: [],
          translationLatencies: [],
          ...(room.metrics || {}),
          viewers: 0,
        };
        this.rooms.set(room.slug, room);
      } catch (error) {
        console.warn(`Could not load ${filename}:`, error.message);
      }
    }
  }

  create(input) {
    const baseSlug = slugify(input.slug || input.title) || `room-${Date.now()}`;
    let slug = baseSlug;
    let suffix = 2;
    while (this.rooms.has(slug)) slug = `${baseSlug}-${suffix++}`;
    const glossary = Array.isArray(input.glossary)
      ? input.glossary
      : String(input.glossary || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    const room = {
      id: randomUUID(),
      slug,
      title: String(input.title || 'Untitled session').slice(0, 120),
      speaker: String(input.speaker || '').slice(0, 120),
      sourceLanguage: input.sourceLanguage || 'en-US',
      targetLanguage: input.targetLanguage || 'es-419',
      glossary: [...new Set(glossary)].slice(0, 100),
      status: 'idle',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      interim: '',
      translatedInterim: '',
      segments: [],
      metrics: {
        audioMs: 0,
        viewers: 0,
        errors: 0,
        reconnects: 0,
        transcriptionLatencies: [],
        translationLatencies: [],
      },
    };
    this.rooms.set(slug, room);
    this.persist(room);
    return publicRoom(room);
  }

  get(slug) {
    const room = this.rooms.get(slug);
    return room ? publicRoom(room) : null;
  }

  raw(slug) {
    return this.rooms.get(slug);
  }

  list() {
    return [...this.rooms.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicRoom);
  }

  delete(slug) {
    const room = this.rooms.get(slug);
    if (!room) return false;
    this.emit(slug, { type: 'deleted', slug });
    this.rooms.delete(slug);
    this.listeners.delete(slug);
    const filename = path.join(this.dataDirectory, `${room.slug}.json`);
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    return true;
  }

  update(slug, mutator, eventType = 'room') {
    const room = this.rooms.get(slug);
    if (!room) return null;
    mutator(room);
    this.persist(room);
    const snapshot = publicRoom(room);
    this.emit(slug, { type: eventType, room: snapshot });
    return snapshot;
  }

  updateTransient(slug, mutator, eventType = 'room') {
    const room = this.rooms.get(slug);
    if (!room) return null;
    mutator(room);
    const snapshot = publicRoom(room);
    this.emit(slug, { type: eventType, room: snapshot });
    return snapshot;
  }

  subscribe(slug, listener) {
    const current = this.listeners.get(slug) || new Set();
    current.add(listener);
    this.listeners.set(slug, current);
    return () => {
      current.delete(listener);
      if (!current.size) this.listeners.delete(slug);
    };
  }

  emit(slug, event) {
    for (const listener of this.listeners.get(slug) || []) listener(event);
  }

  persist(room) {
    const filename = path.join(this.dataDirectory, `${room.slug}.json`);
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(publicRoom(room), null, 2));
    fs.renameSync(temporary, filename);
  }
}
