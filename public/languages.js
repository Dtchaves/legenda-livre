// Gemini 3.5 Transcribe Live language catalog (BCP-47).
// Kept in a browser-safe module so the UI and server validation share one list.
export const LANGUAGES = [
  { code: 'af-ZA', name: 'Afrikaans' },
  { code: 'am-ET', name: 'Amharic' },
  { code: 'ar-EG', name: 'Arabic (Egypt)' },
  { code: 'hy-AM', name: 'Armenian' },
  { code: 'as-IN', name: 'Assamese' },
  { code: 'az-AZ', name: 'Azerbaijani' },
  { code: 'be-BY', name: 'Belarusian' },
  { code: 'bn-BD', name: 'Bengali (Bangladesh)' },
  { code: 'bn-IN', name: 'Bengali (India)' },
  { code: 'bs-BA', name: 'Bosnian' },
  { code: 'bg-BG', name: 'Bulgarian' },
  { code: 'rup-BG', name: 'Bulgarian (Aromanian)' },
  { code: 'my-MM', name: 'Burmese' },
  { code: 'yue-Hant-HK', name: 'Cantonese (Traditional)' },
  { code: 'ca-ES', name: 'Catalan' },
  { code: 'ceb', name: 'Cebuano' },
  { code: 'km-KH', name: 'Central Khmer' },
  { code: 'cmn-Hans-CN', name: 'Chinese, Mandarin (Simplified)' },
  { code: 'hr-HR', name: 'Croatian' },
  { code: 'cs-CZ', name: 'Czech' },
  { code: 'da-DK', name: 'Danish' },
  { code: 'nl-NL', name: 'Dutch' },
  { code: 'en-GB', name: 'English (United Kingdom)' },
  { code: 'en-IN', name: 'English (India)' },
  { code: 'en-US', name: 'English (United States)' },
  { code: 'et-EE', name: 'Estonian' },
  { code: 'fa-IR', name: 'Farsi' },
  { code: 'fil-PH', name: 'Filipino' },
  { code: 'fi-FI', name: 'Finnish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'gl-ES', name: 'Galician' },
  { code: 'ka-GE', name: 'Georgian' },
  { code: 'de-DE', name: 'German' },
  { code: 'el-GR', name: 'Greek' },
  { code: 'gu-IN', name: 'Gujarati' },
  { code: 'ha-NG', name: 'Hausa' },
  { code: 'he-IL', name: 'Hebrew' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'hu-HU', name: 'Hungarian' },
  { code: 'is-IS', name: 'Icelandic' },
  { code: 'id-ID', name: 'Indonesian' },
  { code: 'it-IT', name: 'Italian' },
  { code: 'ja-JP', name: 'Japanese' },
  { code: 'jv-ID', name: 'Javanese' },
  { code: 'kea-CV', name: 'Kabuverdianu' },
  { code: 'kn-IN', name: 'Kannada' },
  { code: 'kk-KZ', name: 'Kazakh' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'ky-KG', name: 'Kyrgyz' },
  { code: 'lv-LV', name: 'Latvian' },
  { code: 'ln-CD', name: 'Lingala' },
  { code: 'lt-LT', name: 'Lithuanian' },
  { code: 'mk-MK', name: 'Macedonian' },
  { code: 'ms-MY', name: 'Malay' },
  { code: 'ml-IN', name: 'Malayalam' },
  { code: 'mt-MT', name: 'Maltese' },
  { code: 'mr-IN', name: 'Marathi' },
  { code: 'mn-MN', name: 'Mongolian' },
  { code: 'ne-NP', name: 'Nepali' },
  { code: 'nb-NO', name: 'Norwegian' },
  { code: 'or-IN', name: 'Oriya' },
  { code: 'pl-PL', name: 'Polish' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'pa-IN', name: 'Punjabi' },
  { code: 'pa-Guru-IN', name: 'Punjabi (Gurmukhi)' },
  { code: 'ro-RO', name: 'Romanian' },
  { code: 'ru-RU', name: 'Russian' },
  { code: 'sr-RS', name: 'Serbian' },
  { code: 'sd-Arab-IN', name: 'Sindhi (Arabic script)' },
  { code: 'sk-SK', name: 'Slovak' },
  { code: 'sl-SI', name: 'Slovenian' },
  { code: 'es-419', name: 'Spanish (Latin America)' },
  { code: 'es-ES', name: 'Spanish (Spain)' },
  { code: 'es-US', name: 'Spanish (United States)' },
  { code: 'sw-KE', name: 'Swahili (Kenya)' },
  { code: 'sv-SE', name: 'Swedish' },
  { code: 'tg-TJ', name: 'Tajik' },
  { code: 'te-IN', name: 'Telugu' },
  { code: 'th-TH', name: 'Thai' },
  { code: 'tr-TR', name: 'Turkish' },
  { code: 'uk-UA', name: 'Ukrainian' },
  { code: 'uz-UZ', name: 'Uzbek' },
  { code: 'vi-VN', name: 'Vietnamese' },
];

export const SUPPORTED_LANGUAGE_CODES = new Set(LANGUAGES.map(({ code }) => code));

const LANGUAGE_ALIASES = {
  en: 'en-US',
  es: 'es-419',
  pt: 'pt-BR',
};

export function normalizeLanguageCode(code) {
  return LANGUAGE_ALIASES[code] || code;
}

export function languageName(code) {
  if (code === 'auto') return 'Automatic detection';
  const normalized = normalizeLanguageCode(code);
  return LANGUAGES.find((language) => language.code === normalized)?.name || code;
}

export function fillLanguageSelect(select, { includeAuto = false, selected } = {}) {
  select.replaceChildren();
  if (includeAuto) select.add(new Option('Automatic detection', 'auto'));
  for (const language of LANGUAGES) {
    select.add(new Option(`${language.name}  ${language.code}`, language.code));
  }
  if (selected) select.value = selected;
}
