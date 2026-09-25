# Legenda Livre

Open-source, multi-room live captions and technical translation for conferences. Legenda Livre turns a microphone or an audio file into responsive original-language captions, Spanish translations, an audience page, an OBS overlay, production metrics, and VTT/SRT/TXT exports.

Built during the Nerdearla Vibeathon 2026.

## What works

- Live microphone and local audio/video file input
- Gemini 3.5 Transcribe Live interim and final captions
- English, Spanish, Portuguese, or automatically detected input
- 80+ selectable BCP-47 speech and caption language variants
- Editable language routing for every inactive room
- Two persistent layouts: Modern and Classic Translator 1998
- Gemini 3.5 Flash-Lite translation into Spanish, Portuguese, or English
- Per-room technical vocabulary (up to 100 terms in the UI)
- Independent concurrent rooms
- Audience and transparent OBS views
- Live p50/p95 transcription and translation latency
- Reconnecting caption clients
- SRT, WebVTT, and plain-text export
- Persistent session records in `data/`
- Fully scripted demo mode that does not need an API key
- Docker image and automated tests

## Architecture

```text
microphone / file
       │ browser AudioWorklet (mono PCM16, 16 kHz, 100 ms)
       ▼
room WebSocket ──► Gemini Transcribe Live
                          │ interim + final captions
                          ▼
                  ordered translation queue
                          │ Gemini Flash-Lite + glossary
                          ▼
                 persistent room event store
                    ├── audience clients
                    ├── OBS browser source
                    ├── operations dashboard
                    └── SRT / VTT / TXT
```

Each room owns exactly one upstream AI stream. Any number of viewers reuse the resulting caption events, so audience growth does not multiply inference calls. The included file-backed event store is intentionally simple for the hackathon deployment. For multiple backend instances, replace `RoomStore` with Redis Streams or another shared event log; the WebSocket and runner boundaries do not change.

## Quick start with Gemini

Requirements: Node.js 22+, npm, Chrome or Edge, and a Gemini API key.

```bash
cp .env.example .env
# Add GEMINI_API_KEY to .env
npm install
npm test
npm start
```

Open <http://localhost:8080>. For microphone capture, use `localhost` or HTTPS; browsers block microphone access on ordinary HTTP hosts.

The model IDs and maximum continuous-speech caption duration can be changed in `.env` without editing code:

```dotenv
TRANSCRIBE_MODEL=gemini-3.5-transcribe-live
TRANSLATE_MODEL=gemini-3.5-flash-lite
CAPTION_SEGMENT_MS=3000
TRANSLATION_TIMEOUT_MS=4000
```

## Test without an API key

```bash
cp .env.example .env
# Set DEMO_MODE=true in .env
npm install
npm start
```

Then:

1. Open <http://localhost:8080>.
2. Select **Create two-room demo**.
3. Open each room's **Operate** page in a separate window.
4. Select **Run 15s demo** in both windows.
5. Open **Audience view** and **OBS overlay** for either room.
6. Confirm that both rooms progress independently and export a VTT file.

Demo mode exercises room isolation, WebSockets, persistence, translation ordering, metrics, audience delivery and exports. Its captions are scripted; use Gemini mode for the real submission demo.

## Real-audio acceptance test

Use headphones and a 30–60 second excerpt from a previous Nerdearla talk.

1. Create an English room and add names and technical terms from the talk to the glossary.
2. On the operator page, choose **Play audio file**.
3. Confirm that interim text appears while the speaker is talking.
4. Confirm that a final original caption and Spanish translation appear every few seconds, even during continuous speech.
5. Open the audience URL in a private window and verify all three language display modes.
6. Add the overlay URL to OBS as a Browser Source at 1920×1080.
7. End the broadcast and download VTT and SRT.
8. Repeat in a second room at the same time to demonstrate isolation and concurrency.

Expected targets for a clean recording:

| Signal | Target |
| --- | ---: |
| Original interim p95 | under 2 seconds |
| Final translated caption p95 | under 4 seconds |
| Room concurrency | at least 2 real sources |
| Glossary term preservation | at least 90% in the chosen excerpt |

Record actual results shown by the application; do not claim these targets unless the test meets them.

## OBS setup

1. In OBS, add **Source → Browser**.
2. Paste the room's overlay URL.
3. Set width to `1920` and height to `1080`.
4. Enable **Shutdown source when not visible** only if you are comfortable with a brief WebSocket reconnect.
5. Position the browser source above the camera or presentation source.

The overlay page is transparent and anchors the current captions to the bottom of the frame.
Append `?theme=classic` to any page or overlay URL to force the classic layout for that browser source.

## Suggested 90-second submission video

Record at 1080p. Use OBS itself or a system screen recorder and keep the cursor movements deliberate.

| Time | Shot and narration |
| --- | --- |
| 0–10s | Nerdearla talk playing. “Open conferences need accessible captions, but current workflows are expensive and hard to operate.” |
| 10–22s | Dashboard with two live rooms. “Legenda Livre gives one operator a real-time view of every stage.” |
| 22–42s | Split-screen operator pages processing two different audio sources. Show interim and final captions. |
| 42–58s | Zoom into a translation and glossary terms. “Speech recognition is biased with each talk's names and technical vocabulary.” |
| 58–70s | Audience page, switch Original / Español / Both. |
| 70–79s | OBS overlay over the original talk video. |
| 79–86s | End one room and download the VTT file. |
| 86–90s | Health metrics and architecture slide. “Open source, reproducible, and designed to scale room by room.” |

Add English subtitles to the final YouTube upload. A strong closing frame contains the public repository URL, license, live deployment URL, and the measured p95 latencies.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Persisted transcripts are written to the host's `data/` directory.

## Deploy to Cloud Run

Build and deploy from the repository root:

```bash
gcloud run deploy legenda-livre \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --min 1 \
  --set-env-vars TRANSCRIBE_MODEL=gemini-3.5-transcribe-live,TRANSLATE_MODEL=gemini-3.5-flash-lite \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest
```

Set `PUBLIC_BASE_URL` to the resulting HTTPS URL. Cloud Run's filesystem is ephemeral and a single-instance deployment is appropriate for this demo. A production multi-instance deployment should use Redis Streams/Firestore for room state and Cloud Storage for final transcripts.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | deployment health |
| `GET/POST` | `/api/rooms` | list or create rooms |
| `GET` | `/api/rooms/:slug` | room snapshot |
| `PATCH` | `/api/rooms/:slug/languages` | change speech and caption languages |
| `DELETE` | `/api/rooms/:slug` | delete an inactive room and its transcript |
| `POST` | `/api/rooms/:slug/reset` | clear an inactive room |
| `GET` | `/api/rooms/:slug/export` | `format=vtt|srt|txt`, `language=translated|original` |
| `WS` | `/ws?room=:slug&role=viewer` | caption event fan-out |
| `WS` | `/ws?room=:slug&role=ingest` | PCM audio ingest |

## Privacy and limitations

- Audio is streamed to the configured Gemini API project and is not written to disk by this application.
- Final text is persisted locally in `data/`; remove it according to the event's retention policy.
- The hackathon store is single-instance. Use a shared event store before horizontal scaling.
- Connection resumption tokens are observed and counted, but transparent upstream migration is not yet implemented. Restart an operator stream if a very long session disconnects.
- SRT/VTT timings are derived from the audio stream clock and utterance boundaries, because the live API provides utterance rather than word-level timestamps.
- Configure API quotas and spending alerts before processing many simultaneous stages.

## License

MIT
