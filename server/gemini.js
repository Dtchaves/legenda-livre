import { GoogleGenAI, Modality } from '@google/genai';
import { languageName, normalizeLanguageCode } from '../public/languages.js';

const LIVE_TRANSLATION_LANGUAGES = new Set(`
  af ak sq am ar hy az eu be bn bg my ca zh-Hans zh-Hant hr cs da nl en et
  fil fi fr gl ka de el gu ha he hi hu is id it ja jv kn kk km rw ko lo lv
  lt mk ms ml mr mn ne no nb fa pl pt-BR pt-PT pa ro ru sr sd si sk sl es
  su sw sv ta te th tr uk ur uz vi zu
`.trim().split(/\s+/));

function liveTranslationCode(language) {
  const normalized = normalizeLanguageCode(language);
  if (normalized === 'cmn-Hans-CN') return 'zh-Hans';
  if (normalized === 'yue-Hant-HK') return 'zh-Hant';
  if (normalized === 'pt-BR' || normalized === 'pt-PT') return normalized;
  const base = normalized.split('-')[0];
  return LIVE_TRANSLATION_LANGUAGES.has(base) ? base : null;
}

export class GeminiServices {
  constructor({ apiKey, transcribeModel, translateModel, liveTranslateModel, captionSegmentMs = 3_000, translationIntervalMs = 6_000 }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.ai = new GoogleGenAI({ apiKey });
    this.transcribeModel = transcribeModel;
    this.translateModel = translateModel;
    this.liveTranslateModel = liveTranslateModel;
    this.captionSegmentMs = Math.min(15_000, Math.max(2_000, Number(captionSegmentMs) || 3_000));
    this.translationIntervalMs = Math.max(4_100, Number(translationIntervalMs) || 6_000);
    this.nextTranslationAt = 0;
    this.translationSlot = Promise.resolve();
  }

  createTranscriber({ language, targetLanguage, glossary, callbacks }) {
    const targetLanguageCode = liveTranslationCode(targetLanguage);
    if (this.liveTranslateModel && targetLanguageCode) {
      return new GeminiLiveTranslateTranscriber({
        ai: this.ai,
        model: this.liveTranslateModel,
        targetLanguageCode,
        callbacks,
        captionSegmentMs: this.captionSegmentMs,
      });
    }
    return new GeminiTranscriber({
      ai: this.ai,
      model: this.transcribeModel,
      language,
      glossary,
      callbacks,
      captionSegmentMs: this.captionSegmentMs,
    });
  }

  async reserveTranslationSlot() {
    if (!this.translationSlot) this.translationSlot = Promise.resolve();
    let release;
    const previous = this.translationSlot;
    this.translationSlot = new Promise((resolve) => { release = resolve; });
    await previous;
    const waitMs = Math.max(0, this.nextTranslationAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.nextTranslationAt = Date.now() + (this.translationIntervalMs || 0);
    release();
  }

  async translateBatch({ captions, sourceLanguage, targetLanguage, glossary, previousText = '', slotReserved = false }) {
    const cleanCaptions = captions.map((text) => String(text || '').trim()).filter(Boolean);
    if (!cleanCaptions.length) return [];
    const normalizedSource = normalizeLanguageCode(sourceLanguage);
    const normalizedTarget = normalizeLanguageCode(targetLanguage);
    if (normalizedSource === normalizedTarget) return cleanCaptions;

    const glossaryLines = glossary.length
      ? glossary.map((term) => `- ${term}: preserve this spelling unless a natural translation is explicitly provided`).join('\n')
      : '- No special terms.';
    const prompt = [
      `Translate these ordered captions from ${languageName(sourceLanguage) || 'the detected language'} to ${languageName(targetLanguage)}.`,
      `Return a JSON array containing exactly ${cleanCaptions.length} translated strings in the same order.`,
      'Keep each caption concise and preserve its meaning and punctuation.',
      'Technical glossary:',
      glossaryLines,
      previousText ? `Previous caption for context only: ${previousText}` : '',
      `CAPTIONS JSON: ${JSON.stringify(cleanCaptions)}`,
    ].filter(Boolean).join('\n');

    if (!slotReserved) await this.reserveTranslationSlot();
    const response = await this.ai.models.generateContent({
      model: this.translateModel,
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: Math.min(2_000, Math.max(300, cleanCaptions.length * 180)),
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'array',
          items: { type: 'string' },
          minItems: cleanCaptions.length,
          maxItems: cleanCaptions.length,
        },
        // A stale live caption is worse than a fast quota error. Pacing and
        // batching prevent 429s; disabling SDK retries prevents 40s backoffs.
        httpOptions: { timeout: 10_000, retryOptions: { attempts: 1 } },
        // Gemini 3.x models use discrete thinking levels. A zero token budget
        // is rejected by gemini-3.5-flash-lite with INVALID_ARGUMENT.
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    });

    let translated;
    try {
      translated = JSON.parse(response.text || '[]');
    } catch {
      throw new Error('Gemini returned invalid translation JSON');
    }
    if (!Array.isArray(translated) || translated.length !== cleanCaptions.length) {
      throw new Error('Gemini returned an incomplete translation batch');
    }
    return translated.map((text) => String(text || '').trim());
  }

  async translate({ text, sourceLanguage, targetLanguage, glossary, previousText = '', onUpdate }) {
    if (!text.trim()) return '';
    const [translated] = await this.translateBatch({
      captions: [text],
      sourceLanguage,
      targetLanguage,
      glossary,
      previousText,
    });
    if (translated) onUpdate?.(translated);
    return translated || '';
  }
}

function appendTranscription(current, update) {
  const next = String(update || '');
  if (!next) return current;
  if (!current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  const separator = /\s$/.test(current) || /^\s/.test(next) ? '' : ' ';
  return `${current}${separator}${next}`;
}

export class GeminiLiveTranslateTranscriber {
  constructor({ ai, model, targetLanguageCode, callbacks, captionSegmentMs = 3_000 }) {
    this.ai = ai;
    this.model = model;
    this.targetLanguageCode = targetLanguageCode;
    this.callbacks = callbacks;
    this.captionSegmentMs = captionSegmentMs;
    this.providesTranslation = true;
    this.segmentAudioMs = 0;
    this.hasSentAudio = false;
    this.inputText = '';
    this.outputText = '';
    this.inputFinished = false;
    this.outputFinished = false;
    this.commitRequested = false;
    this.flushTimer = null;
    this.flushDueAt = 0;
    this.session = null;
    this.closed = false;
  }

  async connect() {
    this.session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: this.targetLanguageCode,
          echoTargetLanguage: true,
        },
      },
      callbacks: {
        onopen: () => this.callbacks.onOpen?.(),
        onmessage: (message) => this.handleMessage(message),
        onerror: (error) => this.callbacks.onError?.(error),
        onclose: (event) => this.callbacks.onClose?.(event.reason),
      },
    });
  }

  handleMessage(message) {
    const content = message.serverContent;
    const input = content?.inputTranscription;
    const output = content?.outputTranscription;
    if (input?.text) {
      this.inputText = appendTranscription(this.inputText, input.text);
      this.callbacks.onInterim?.(this.inputText.trim());
    }
    if (output?.text) {
      this.outputText = appendTranscription(this.outputText, output.text);
      this.callbacks.onTranslatedInterim?.(this.outputText.trim());
    }
    if (input?.finished) this.inputFinished = true;
    if (output?.finished) this.outputFinished = true;
    if (content?.turnComplete) {
      if (this.inputText) this.inputFinished = true;
      if (this.outputText) this.outputFinished = true;
    }
    this.maybeFlush();
    if (message.goAway) this.callbacks.onGoAway?.(message.goAway.timeLeft);
  }

  send(buffer) {
    if (!this.session || this.closed) return;
    const audio = Buffer.from(buffer);
    this.session.sendRealtimeInput({
      audio: {
        data: audio.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
    this.hasSentAudio = true;
    this.segmentAudioMs += audio.byteLength / 2 / 16_000 * 1_000;
    if (this.segmentAudioMs >= this.captionSegmentMs) this.commitSegment();
  }

  commitSegment() {
    if (!this.session || this.closed || !this.hasSentAudio) return;
    // Live Translate is a continuous pipeline. Closing and immediately
    // reopening its audio stream every few seconds can interrupt the response.
    // Keep audio flowing and only cut the accumulated text into UI captions.
    this.segmentAudioMs = 0;
    this.commitRequested = true;
    this.scheduleFlush(this.inputText && this.outputText ? 350 : 1_500);
  }

  maybeFlush() {
    if (!this.inputText || !this.outputText) return;
    if (this.inputFinished && this.outputFinished) {
      this.flushSegment();
    } else if (this.commitRequested) {
      this.scheduleFlush(350);
    }
  }

  scheduleFlush(delayMs) {
    const dueAt = Date.now() + delayMs;
    // Transcript updates arrive many times per second. A normal debounce would
    // keep postponing the commit forever while somebody speaks continuously.
    if (this.flushTimer && this.flushDueAt <= dueAt) return;
    clearTimeout(this.flushTimer);
    this.flushDueAt = dueAt;
    this.flushTimer = setTimeout(() => this.flushSegment(), Math.max(0, dueAt - Date.now()));
  }

  flushSegment() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushDueAt = 0;
    const original = this.inputText.trim();
    const translated = this.outputText.trim();
    if (original || translated) this.callbacks.onBilingualFinal?.({ original, translated });
    this.inputText = '';
    this.outputText = '';
    this.inputFinished = false;
    this.outputFinished = false;
    this.commitRequested = false;
  }

  async end() {
    if (!this.session || this.closed) return;
    this.closed = true;
    // audioStreamEnd belongs at the real end of capture. The SDK/API can then
    // finalize the last transcript before the WebSocket session is closed.
    if (this.hasSentAudio) this.session.sendRealtimeInput({ audioStreamEnd: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    this.flushSegment();
    this.session.close();
  }
}

export class GeminiTranscriber {
  constructor({ ai, model, language, glossary, callbacks, captionSegmentMs = 3_000 }) {
    this.ai = ai;
    this.model = model;
    this.language = language;
    this.glossary = glossary;
    this.callbacks = callbacks;
    this.captionSegmentMs = captionSegmentMs;
    this.segmentAudioMs = 0;
    this.hasPendingAudio = false;
    this.session = null;
    this.closed = false;
  }

  async connect() {
    const languageCodes = this.language === 'auto' ? [] : [this.language];
    this.session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: {
          languageCodes,
          customVocabulary: this.glossary.slice(0, 100),
          mode: 'SMART',
        },
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: {},
      },
      callbacks: {
        onopen: () => this.callbacks.onOpen?.(),
        onmessage: (message) => {
          const content = message.serverContent;
          if (content?.interimInputTranscription?.text) {
            this.callbacks.onInterim?.(content.interimInputTranscription.text);
          }
          if (content?.inputTranscription?.text) {
            this.callbacks.onFinal?.(content.inputTranscription.text);
          }
          const update = message.sessionResumptionUpdate;
          if (update?.resumable && update?.newHandle) {
            this.callbacks.onResumeToken?.(update.newHandle);
          }
          if (message.goAway) this.callbacks.onGoAway?.(message.goAway.timeLeft);
        },
        onerror: (error) => this.callbacks.onError?.(error),
        onclose: (event) => this.callbacks.onClose?.(event.reason),
      },
    });
  }

  send(buffer) {
    if (!this.session || this.closed) return;
    const audio = Buffer.from(buffer);
    this.session.sendRealtimeInput({
      audio: {
        data: audio.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
    this.hasPendingAudio = true;
    this.segmentAudioMs += audio.byteLength / 2 / 16_000 * 1_000;
    if (this.segmentAudioMs >= this.captionSegmentMs) this.commitSegment();
  }

  commitSegment() {
    if (!this.session || this.closed || !this.hasPendingAudio) return;
    // With automatic VAD enabled, audioStreamEnd immediately finalizes the
    // current transcription. Sending the next audio chunk reopens the stream.
    this.session.sendRealtimeInput({ audioStreamEnd: true });
    this.segmentAudioMs = 0;
    this.hasPendingAudio = false;
  }

  async end() {
    if (!this.session || this.closed) return;
    this.commitSegment();
    this.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    this.session.close();
  }
}
