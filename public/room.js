import { fillLanguageSelect, languageName, normalizeLanguageCode } from '/languages.js';
import { initTheme } from '/theme.js';

initTheme();

const pathParts = location.pathname.split('/').filter(Boolean);
const slug = pathParts[1];
const mode = pathParts[2] || 'captions';
const operatorMode = mode === 'operator';
const overlayMode = mode === 'overlay';
document.body.dataset.mode = mode;

let room;
// Operators need to monitor both sides of the pipeline. Audience and overlay
// pages still open with the translated caption only.
let selectedLanguage = operatorMode ? 'both' : 'translated';
let viewerSocket;
let ingestSocket;
let audioContext;
let audioSource;
let mediaStream;
let syntheticTimer;
let stopping = false;

const byId = (id) => document.getElementById(id);
const sourceLanguageSelect = byId('operatorSourceLanguage');
const targetLanguageSelect = byId('operatorTargetLanguage');
if (operatorMode) {
  fillLanguageSelect(sourceLanguageSelect, { includeAuto: true });
  fillLanguageSelect(targetLanguageSelect);
}
const formatDuration = (milliseconds = 0) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const formatLatency = (value) => value == null ? '—' : `${Math.round(value)} ms`;

function websocketUrl(role) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?room=${encodeURIComponent(slug)}&role=${role}`;
}

function render(snapshot) {
  room = snapshot;
  document.title = `${room.title} — Legenda Livre`;
  byId('roomTitle').textContent = room.title;
  byId('roomSpeaker').textContent = room.speaker || room.slug;
  byId('roomMode').textContent = overlayMode ? 'BROADCAST OVERLAY' : operatorMode ? 'ROOM OPERATOR' : 'ACCESSIBLE LIVE SESSION';
  byId('statusMetric').textContent = room.status;
  byId('audioMetric').textContent = formatDuration(room.metrics.audioMs);
  byId('transcriptMetric').textContent = formatLatency(room.metrics.transcriptionP95Ms);
  byId('translationMetric').textContent = formatLatency(room.metrics.translationP95Ms);
  byId('viewerMetric').textContent = room.metrics.viewers;
  byId('errorMetric').textContent = room.metrics.errors;
  byId('connectionBadge').textContent = room.status;
  byId('connectionBadge').dataset.tone = room.status === 'live' ? 'success' : room.status === 'error' ? 'danger' : 'neutral';
  document.querySelector('[data-language="translated"]').textContent = languageName(room.targetLanguage);
  document.querySelector('[data-language="original"]').textContent = `Original: ${languageName(room.sourceLanguage)}`;
  if (operatorMode) {
    sourceLanguageSelect.value = normalizeLanguageCode(room.sourceLanguage);
    targetLanguageSelect.value = normalizeLanguageCode(room.targetLanguage);
    const locked = ['connecting', 'live'].includes(room.status);
    sourceLanguageSelect.disabled = locked;
    targetLanguageSelect.disabled = locked;
    byId('saveLanguages').disabled = locked;
  }
  byId('glossary').innerHTML = room.glossary.length
    ? room.glossary.map((term) => `<span>${escapeHtml(term)}</span>`).join('')
    : '<span class="muted">No glossary</span>';
  renderCaptions();
  renderTranscript();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function renderCaptions() {
  if (!room) return;
  const latest = room.segments.at(-1);
  const translated = room.translatedInterim || latest?.translated || latest?.original || 'Waiting for speech…';
  const original = latest?.original || '';
  byId('translatedCaption').textContent = translated;
  byId('originalCaption').textContent = original;
  byId('interimCaption').textContent = room.interim ? `… ${room.interim}` : '';
  byId('translatedCaption').hidden = selectedLanguage === 'original';
  byId('originalCaption').hidden = selectedLanguage === 'translated';
}

function renderTranscript() {
  if (!room || overlayMode) return;
  const segments = [...room.segments].reverse();
  byId('transcript').innerHTML = segments.length ? segments.map((segment) => `
    <li>
      <time>${formatDuration(segment.startMs)}</time>
      <div>${renderTranscriptText(segment)}</div>
    </li>`).join('') : '<li class="empty-transcript">Final captions will appear automatically every few seconds.</li>';
}

function renderTranscriptText(segment) {
  const original = escapeHtml(segment.original);
  const translated = escapeHtml(segment.translated || 'Translating…');
  if (selectedLanguage === 'original') return `<strong>${original}</strong>`;
  if (selectedLanguage === 'translated') return `<strong>${translated}</strong>`;
  return `<strong>${translated}</strong><p>${original}</p>`;
}

function connectViewer() {
  viewerSocket = new WebSocket(websocketUrl('viewer'));
  viewerSocket.addEventListener('open', () => { byId('connectionBadge').textContent = 'connected'; });
  viewerSocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.room) render(message.room);
  });
  viewerSocket.addEventListener('close', () => {
    byId('connectionBadge').textContent = 'reconnecting…';
    setTimeout(connectViewer, 1_500);
  });
}

function openIngest() {
  return new Promise((resolve, reject) => {
    ingestSocket = new WebSocket(websocketUrl('ingest'));
    ingestSocket.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => reject(new Error('AI connection timed out')), 15_000);
    ingestSocket.addEventListener('open', () => ingestSocket.send(JSON.stringify({ type: 'start' })));
    ingestSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
      if (message.type === 'client-error') {
        clearTimeout(timeout);
        reject(new Error(message.message));
      }
    });
    ingestSocket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Could not open ingest WebSocket'));
    });
  });
}

async function createAudioPipeline(source, playAudio = false) {
  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/pcm-worklet.js');
  const processor = new AudioWorkletNode(audioContext, 'pcm16-worklet');
  const silent = audioContext.createGain();
  silent.gain.value = 0;
  processor.port.onmessage = ({ data }) => {
    if (ingestSocket?.readyState === WebSocket.OPEN) ingestSocket.send(data);
  };
  source.connect(processor);
  processor.connect(silent).connect(audioContext.destination);
  if (playAudio) source.connect(audioContext.destination);
  await audioContext.resume();
}

function setCaptureState(active, title, detail) {
  byId('microphoneButton').disabled = active;
  byId('audioFile').disabled = active;
  byId('demoButton').disabled = active;
  byId('stopButton').disabled = !active;
  byId('captureStatus').textContent = title;
  byId('captureDetail').textContent = detail;
  document.querySelector('.audio-bars').classList.toggle('active', active);
}

async function startMicrophone() {
  try {
    setCaptureState(true, 'Connecting to transcription…', 'Allow microphone access when prompted');
    await openIngest();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    audioSource = audioContext.createMediaStreamSource(mediaStream);
    await createAudioPipelineWithContext(audioSource, false);
    setCaptureState(true, 'Microphone is live', 'Gemini Live Translate · original and translation streaming together');
  } catch (error) {
    await stopCapture(false);
    alert(error.message);
  }
}

async function createAudioPipelineWithContext(source, playAudio) {
  await audioContext.audioWorklet.addModule('/pcm-worklet.js');
  const processor = new AudioWorkletNode(audioContext, 'pcm16-worklet');
  const silent = audioContext.createGain();
  silent.gain.value = 0;
  processor.port.onmessage = ({ data }) => {
    if (ingestSocket?.readyState === WebSocket.OPEN) ingestSocket.send(data);
  };
  source.connect(processor);
  processor.connect(silent).connect(audioContext.destination);
  if (playAudio) source.connect(audioContext.destination);
  await audioContext.resume();
}

async function startFile(file) {
  try {
    setCaptureState(true, 'Preparing audio file…', file.name);
    await openIngest();
    audioContext = new AudioContext({ latencyHint: 'playback' });
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = buffer;
    await createAudioPipelineWithContext(audioSource, true);
    audioSource.addEventListener('ended', () => stopCapture());
    audioSource.start();
    setCaptureState(true, 'Audio file is live', `Gemini Live Translate · ${file.name} · ${Math.round(buffer.duration)} seconds`);
  } catch (error) {
    await stopCapture(false);
    alert(error.message);
  }
}

async function startSyntheticDemo() {
  try {
    setCaptureState(true, 'Starting scripted demo…', 'No API calls are made in demo mode');
    await openIngest();
    const silentPcm = new ArrayBuffer(3_200);
    syntheticTimer = setInterval(() => {
      if (ingestSocket?.readyState === WebSocket.OPEN) ingestSocket.send(silentPcm.slice(0));
    }, 100);
    setCaptureState(true, 'Demo broadcast is live', 'Scripted captions are feeding the full room pipeline');
    setTimeout(() => { if (syntheticTimer) stopCapture(); }, 15_000);
  } catch (error) {
    await stopCapture(false);
    alert(error.message);
  }
}

async function stopCapture(notifyServer = true) {
  if (stopping) return;
  stopping = true;
  clearInterval(syntheticTimer);
  syntheticTimer = null;
  try { audioSource?.stop?.(); } catch {}
  mediaStream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close().catch(() => {});
  if (notifyServer && ingestSocket?.readyState === WebSocket.OPEN) {
    ingestSocket.send(JSON.stringify({ type: 'stop' }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  ingestSocket?.close();
  ingestSocket = null;
  audioContext = null;
  audioSource = null;
  mediaStream = null;
  setCaptureState(false, 'Broadcast ended', 'Choose a source to start again');
  stopping = false;
}

for (const button of document.querySelectorAll('.language-switch button')) {
  button.classList.toggle('active', button.dataset.language === selectedLanguage);
  button.addEventListener('click', () => {
    selectedLanguage = button.dataset.language;
    document.querySelectorAll('.language-switch button').forEach((item) => item.classList.toggle('active', item === button));
    renderCaptions();
    renderTranscript();
  });
}

if (operatorMode) {
  byId('microphoneButton').addEventListener('click', startMicrophone);
  byId('audioFile').addEventListener('change', (event) => event.target.files[0] && startFile(event.target.files[0]));
  byId('stopButton').addEventListener('click', () => stopCapture());
  byId('demoButton').addEventListener('click', startSyntheticDemo);
  byId('saveLanguages').addEventListener('click', async () => {
    const response = await fetch(`/api/rooms/${slug}/languages`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceLanguage: sourceLanguageSelect.value,
        targetLanguage: targetLanguageSelect.value,
      }),
    });
    const result = await response.json();
    byId('languageMessage').textContent = response.ok
      ? `Saved: ${languageName(result.sourceLanguage)} to ${languageName(result.targetLanguage)}.`
      : result.error;
    if (response.ok) render(result);
  });
  byId('resetButton').addEventListener('click', async () => {
    if (!confirm('Clear this room transcript and metrics?')) return;
    const response = await fetch(`/api/rooms/${slug}/reset`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) alert(result.error);
    else render(result);
  });
  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(byId(button.dataset.copy).textContent);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1_200);
  }));
}

const config = await fetch('/api/config').then((response) => response.json());
if (operatorMode) byId('demoButton').hidden = !config.demoMode;
const base = config.publicBaseUrl.replace(/\/$/, '');
byId('audienceUrl').textContent = `${base}/room/${slug}/captions`;
byId('overlayUrl').textContent = `${base}/room/${slug}/overlay`;
for (const format of ['vtt', 'srt', 'txt']) {
  byId(`${format}Export`).href = `/api/rooms/${slug}/export?format=${format}&language=translated`;
}
connectViewer();
window.addEventListener('beforeunload', () => {
  viewerSocket?.close();
  ingestSocket?.close();
});
