import { GoogleGenAI, Modality } from '@google/genai';
import { languageName, normalizeLanguageCode } from '../public/languages.js';

export class GeminiServices {
  constructor({ apiKey, transcribeModel, translateModel }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.ai = new GoogleGenAI({ apiKey });
    this.transcribeModel = transcribeModel;
    this.translateModel = translateModel;
  }

  createTranscriber({ language, glossary, callbacks }) {
    return new GeminiTranscriber({
      ai: this.ai,
      model: this.transcribeModel,
      language,
      glossary,
      callbacks,
    });
  }

  async translate({ text, sourceLanguage, targetLanguage, glossary, previousText = '' }) {
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

    const response = await this.ai.models.generateContent({
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
    return String(response.text || '').trim().replace(/^['"]|['"]$/g, '');
  }
}

class GeminiTranscriber {
  constructor({ ai, model, language, glossary, callbacks }) {
    this.ai = ai;
    this.model = model;
    this.language = language;
    this.glossary = glossary;
    this.callbacks = callbacks;
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
    this.session.sendRealtimeInput({
      audio: {
        data: Buffer.from(buffer).toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
  }

  async end() {
    if (!this.session || this.closed) return;
    this.closed = true;
    this.session.sendRealtimeInput({ audioStreamEnd: true });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    this.session.close();
  }
}
