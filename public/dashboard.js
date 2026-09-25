import { fillLanguageSelect, languageName } from '/languages.js';
import { initTheme } from '/theme.js';

initTheme();

const roomsElement = document.querySelector('#rooms');
const form = document.querySelector('#createRoomForm');
const message = document.querySelector('#formMessage');
const template = document.querySelector('#roomCardTemplate');

fillLanguageSelect(document.querySelector('#sourceLanguage'), { includeAuto: true, selected: 'en-US' });
fillLanguageSelect(document.querySelector('#targetLanguage'), { selected: 'es-419' });

function duration(milliseconds = 0) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function latency(value) {
  return value == null ? '—' : `${Math.round(value)} ms`;
}

function renderRooms(rooms) {
  roomsElement.innerHTML = '';
  if (!rooms.length) {
    roomsElement.innerHTML = '<div class="empty-state"><span>◌</span><h3>No rooms yet</h3><p>Create a room or generate the two-room demo.</p></div>';
    return;
  }
  for (const room of rooms) {
    const card = template.content.cloneNode(true);
    card.querySelector('h3').textContent = room.title;
    card.querySelector('.speaker').textContent = room.speaker || room.slug;
    card.querySelector('.room-status').textContent = room.status;
    card.querySelector('.status-dot').dataset.status = room.status;
    card.querySelector('.language').textContent = `${room.sourceLanguage} → ${room.targetLanguage}`;
    card.querySelector('.audio-time').textContent = duration(room.metrics.audioMs);
    card.querySelector('.latency').textContent = latency(room.metrics.translationP95Ms);
    card.querySelector('.viewers').textContent = room.metrics.viewers;
    card.querySelector('.language').textContent = `${languageName(room.sourceLanguage)} to ${languageName(room.targetLanguage)}`;
    card.querySelector('.operator-link').href = `/room/${room.slug}/operator`;
    card.querySelector('.captions-link').href = `/room/${room.slug}/captions`;
    card.querySelector('.overlay-link').href = `/room/${room.slug}/overlay`;
    const deleteButton = card.querySelector('.delete-room');
    deleteButton.disabled = ['connecting', 'live'].includes(room.status);
    deleteButton.title = deleteButton.disabled ? 'End the broadcast before deleting this room' : 'Delete room and transcript';
    deleteButton.addEventListener('click', () => deleteRoom(room));
    roomsElement.append(card);
  }
}

async function deleteRoom(room) {
  const warning = `Delete "${room.title}" and its complete transcript? This cannot be undone.`;
  if (!confirm(warning)) return;
  const response = await fetch(`/api/rooms/${encodeURIComponent(room.slug)}`, { method: 'DELETE' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    message.textContent = result.error || 'Could not delete room';
    return;
  }
  message.textContent = `Room "${room.title}" deleted.`;
  await loadRooms();
}

async function loadRooms() {
  const response = await fetch('/api/rooms');
  renderRooms(await response.json());
}

async function createRoom(data) {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not create room');
  return result;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  try {
    message.textContent = 'Creating room…';
    const room = await createRoom(values);
    location.href = `/room/${room.slug}/operator`;
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector('#createDemoRooms').addEventListener('click', async () => {
  const button = document.querySelector('#createDemoRooms');
  button.disabled = true;
  message.textContent = 'Creating two independent stages…';
  try {
    await Promise.all([
      createRoom({ title: 'Main Stage — Open AI', speaker: 'Nerdearla', sourceLanguage: 'en-US', targetLanguage: 'es', glossary: 'Nerdearla, Gemini, Kubernetes, Redis Streams, WebSockets' }),
      createRoom({ title: 'Community Stage — Sistemas', speaker: 'Nerdearla', sourceLanguage: 'en-US', targetLanguage: 'es', glossary: 'Nerdearla, SQLite, WebAssembly, open source, PostgreSQL' }),
    ]);
    message.textContent = 'Two demo rooms are ready. Open each operator page in a separate window.';
    await loadRooms();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#refreshRooms').addEventListener('click', loadRooms);

const config = await fetch('/api/config').then((response) => response.json());
const badge = document.querySelector('#environmentBadge');
badge.textContent = config.demoMode ? 'Demo engine' : config.apiConfigured ? 'Gemini ready' : 'API key required';
badge.dataset.tone = config.demoMode ? 'warning' : config.apiConfigured ? 'success' : 'danger';
await loadRooms();
setInterval(loadRooms, 3_000);
