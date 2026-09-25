import { GoogleGenAI, Modality } from '@google/genai';
import { languageName, normalizeLanguageCode } from '../public/languages.js';

export class GeminiServices {
  constructor({ apiKey, transcribeModel, translateModel, captionSegmentMs = 3_000 }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.ai = new GoogleGenAI({ apiKey });
    this.transcribeModel = transcribeModel;
    this.translateModel = translateModel;
    this.captionSegmentMs = Math.min(15_000, Math.max(2_000, Number(captionSegmentMs) || 3_000));
  }

  createTranscriber({ language, glossary, callbacks }) {
    return new GeminiTranscriber({
      ai: this.ai,
      model: this.transcribeModel,
      language,
      glossary,
      callbacks,
      captionSegmentMs: this.captionSegmentMs,
    });
  }

  async translate({ text, sourceLanguage, targetLanguage, glossary, previousText = '', onUpdate }) {
    if (!text.trim()) return '';
    const normalizedSource = normalizeLanguageCode(sourceLanguage);
    const normalizedTarget = normalizeLanguageCode(targetLanguage);
    if (normalizedSource === normalizedTarget) return text;

    const glossaryLines = glossary.length
      ? glossary.map((term) => `- ${term}: preserve this spelling unless a natural translation is explicitly provided`).join('\n')
      : '- No special terms.';
    const prompt = [
      `Translate the CURRENT caption from ${languageName(sourceLanguage) || 'the detected language'} to ${languageName(targetLanguage)}.`,
      'Return only the translated caption. Do not add notes, quotes, labels, or markdown.',
      'Keep the meaning, punctuation, and concise subtitle style.',
      'Technical glossary:',
      glossaryLines,
      previousText ? `Previous caption for context only: ${previousText}` : '',
      `CURRENT caption: ${text}`,
    ].filter(Boolean).join('\n');

    const response = await this.ai.models.generateContentStream({
      model: this.translateModel,
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: 300,
        // Gemini 3.x models use discrete thinking levels. A zero token budget
        // is rejected by gemini-3.5-flash-lite with INVALID_ARGUMENT.
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });
    let translated = '';
    for await (const chunk of response) {
      translated += String(chunk.text || '');
      const partial = translated.trim().replace(/^['"]|['"]$/g, '');
      if (partial) onUpdate?.(partial);
    }
    return translated.trim().replace(/^['"]|['"]$/g, '');
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
