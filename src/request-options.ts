import { AssessmentError } from "./errors.js";
import {
  DEFAULT_LOCALE,
  MAX_REFERENCE_CHARS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  NBEST_PHONEME_COUNT,
} from "./limits.js";
import { isPronunciationLocale, type PronunciationLocale } from "./locales.js";

export type PhonemeAlphabet = "IPA" | "SAPI";

export interface AssessmentRequest {
  locale: PronunciationLocale;
  referenceText: string;
  phonemeAlphabet: PhonemeAlphabet | null;
  gradingSystem: "HundredMark";
  granularity: "Phoneme";
  dimension: "Comprehensive";
  enableMiscue: true;
  enableProsodyAssessment: boolean;
  nBestPhonemeCount: number | null;
  prosodySupportedForLocale: boolean;
}

export function validateReferenceText(input: string): string {
  if (input.includes("\0")) {
    throw new AssessmentError("INVALID_REFERENCE", "Reference text contains a null byte.");
  }
  const referenceText = input.trim();
  if (!referenceText) {
    throw new AssessmentError("INVALID_REFERENCE", "Reference text is empty.");
  }
  if (referenceText.length > MAX_REFERENCE_CHARS) {
    throw new AssessmentError(
      "INVALID_REFERENCE",
      `Reference text is longer than ${MAX_REFERENCE_CHARS} characters. Azure does not publish a character maximum; this is a local guard for one short utterance.`,
      { details: { characters: referenceText.length, maxCharacters: MAX_REFERENCE_CHARS } },
    );
  }
  return referenceText;
}

export function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AssessmentError(
      "INVALID_INPUT",
      `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

export function buildAssessmentRequest(input: {
  referenceText: string;
  locale?: string | undefined;
  phonemeAlphabet?: PhonemeAlphabet | undefined;
  enableProsody?: boolean | undefined;
}): AssessmentRequest {
  const referenceText = validateReferenceText(input.referenceText);
  const localeInput = input.locale ?? DEFAULT_LOCALE;
  if (!isPronunciationLocale(localeInput)) {
    throw new AssessmentError(
      "INVALID_LOCALE",
      `Locale ${localeInput} is not one of the pronunciation-assessment locales documented by Azure Speech. The default is en-US.`,
      { details: { locale: localeInput } },
    );
  }

  const prosodySupportedForLocale = localeInput === "en-US";
  let enableProsodyAssessment = false;
  if (input.enableProsody === true && !prosodySupportedForLocale) {
    throw new AssessmentError(
      "PROSODY_UNSUPPORTED",
      `Prosody assessment is documented for en-US only. The request to enable it for ${localeInput} was rejected.`,
      { details: { locale: localeInput } },
    );
  }
  if (input.enableProsody === false) {
    enableProsodyAssessment = false;
  } else if (prosodySupportedForLocale) {
    enableProsodyAssessment = true;
  }

  const phonemeAlphabet = resolveAlphabet(localeInput, input.phonemeAlphabet);
  const nBestPhonemeCount = localeInput === "en-US" ? NBEST_PHONEME_COUNT : null;

  return {
    locale: localeInput,
    referenceText,
    phonemeAlphabet,
    gradingSystem: "HundredMark",
    granularity: "Phoneme",
    dimension: "Comprehensive",
    enableMiscue: true,
    enableProsodyAssessment,
    nBestPhonemeCount,
    prosodySupportedForLocale,
  };
}

function resolveAlphabet(
  locale: PronunciationLocale,
  requested: PhonemeAlphabet | undefined,
): PhonemeAlphabet | null {
  if (requested === "IPA") {
    if (locale !== "en-US") {
      throw new AssessmentError(
        "UNSUPPORTED_PHONEME_ALPHABET",
        "IPA phoneme names are documented for en-US only. Other locales can still return phoneme scores without names when no alphabet is requested.",
        { details: { locale, phonemeAlphabet: requested } },
      );
    }
    return "IPA";
  }
  if (requested === "SAPI") {
    if (locale !== "en-US" && locale !== "zh-CN") {
      throw new AssessmentError(
        "UNSUPPORTED_PHONEME_ALPHABET",
        "SAPI phoneme names are documented for en-US and zh-CN only.",
        { details: { locale, phonemeAlphabet: requested } },
      );
    }
    return "SAPI";
  }
  if (locale === "en-US") {
    return "IPA";
  }
  if (locale === "zh-CN") {
    return "SAPI";
  }
  return null;
}
