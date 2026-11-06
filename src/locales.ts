/**
 * The 33 pronunciation-assessment locales from Azure Speech language support.
 * Retrieved 2026-11-06:
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support
 *
 * Prosody, syllable names, and spoken-phoneme hypotheses are documented for
 * en-US. Phoneme names are documented for en-US (IPA and SAPI) and zh-CN (SAPI).
 */
export const PRONUNCIATION_LOCALES = [
  "ar-EG",
  "ar-SA",
  "ca-ES",
  "zh-HK",
  "zh-CN",
  "zh-TW",
  "da-DK",
  "nl-NL",
  "en-AU",
  "en-CA",
  "en-IN",
  "en-GB",
  "en-US",
  "fi-FI",
  "fr-CA",
  "fr-FR",
  "de-DE",
  "hi-IN",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "ms-MY",
  "nb-NO",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ru-RU",
  "es-MX",
  "es-ES",
  "sv-SE",
  "ta-IN",
  "th-TH",
  "vi-VN",
] as const;

export type PronunciationLocale = (typeof PRONUNCIATION_LOCALES)[number];

const LOCALE_SET = new Set<string>(PRONUNCIATION_LOCALES);

export function isPronunciationLocale(value: string): value is PronunciationLocale {
  return LOCALE_SET.has(value);
}
