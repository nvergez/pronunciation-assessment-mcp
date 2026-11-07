import { readFile } from "node:fs/promises";
import { loadLocalWav } from "./audio.js";
import type { SpeechBackend } from "./backend.js";
import { AssessmentError } from "./errors.js";
import { diagnostic } from "./log.js";
import { DEFAULT_TIMEOUT_MS } from "./limits.js";
import { redactText, secretsFromEnv } from "./redact.js";
import { validateReferenceText, validateTimeout } from "./request-options.js";
import type { AssessDeps, AssessInput, NBestPhoneme, PhonemeResult, SuccessBody, SyllableResult, Timing, WordResult } from "./types.js";
import type { MappedAssessment } from "./map-result.js";
import type { PhonemeAlphabet } from "./request-options.js";

/**
 * Speechace text scoring, v9.
 * https://api-docs.speechace.com/api-reference/score-text
 *
 * The key is a query parameter. Never log the request URL.
 * Dialect defaults to en-us. Phoneme names in the response are ARPAbet;
 * this mapper converts them to IPA unless the caller asked for SAPI symbols.
 * sound_most_like is the heard phone. Speechace does not score that phone
 * separately, so the n-best score stays null.
 */
export const SPEECHACE_SCORE_TEXT_URL = "https://api.speechace.co/api/scoring/text/v9/json";
const SPEECHACE_TEXT_MAX_CHARS = 1_500;

const ARPA_TO_IPA: Record<string, string> = {
  aa: "ɑ",
  ae: "æ",
  ao: "ɔ",
  aw: "aʊ",
  ax: "ə",
  axr: "ɚ",
  ay: "aɪ",
  b: "b",
  ch: "tʃ",
  d: "d",
  dh: "ð",
  eh: "ɛ",
  ey: "eɪ",
  f: "f",
  g: "ɡ",
  hh: "h",
  ih: "ɪ",
  iy: "i",
  jh: "dʒ",
  k: "k",
  l: "l",
  m: "m",
  n: "n",
  ng: "ŋ",
  ow: "oʊ",
  oy: "ɔɪ",
  p: "p",
  r: "ɹ",
  s: "s",
  sh: "ʃ",
  t: "t",
  th: "θ",
  uh: "ʊ",
  uw: "u",
  v: "v",
  w: "w",
  y: "j",
  z: "z",
  zh: "ʒ",
};

const RECOGNITION_FAILURES = new Set([
  "error_no_speech",
  "error_other_speech",
  "error_word_alignment",
  "error_no_word",
]);

export interface SpeechaceDialectChoice {
  locale: "en-US" | "en-GB";
  dialect: "en-us" | "en-gb";
}

export function resolveSpeechaceDialect(locale: string | undefined): SpeechaceDialectChoice {
  const value = (locale ?? "en-US").trim();
  const folded = value.toLowerCase();
  if (folded === "en-us") {
    return { locale: "en-US", dialect: "en-us" };
  }
  if (folded === "en-gb") {
    return { locale: "en-GB", dialect: "en-gb" };
  }
  throw new AssessmentError(
    "INVALID_LOCALE",
    `Speechace text scoring in this tool accepts en-US and en-GB. Received ${value}. The default dialect is en-us.`,
    { details: { locale: value } },
  );
}

export function speechacePhoneName(
  phone: string,
  stressLevel: number | null,
  alphabet: PhonemeAlphabet,
): string {
  const trimmed = phone.trim().toLowerCase();
  const digit = /[012]$/.exec(trimmed);
  const base = digit ? trimmed.slice(0, -1) : trimmed;
  if (alphabet === "SAPI") {
    return base;
  }
  const stress = stressLevel ?? (digit ? Number(digit[0]) : null);
  if (base === "ah") {
    return stress !== null && stress >= 1 ? "ʌ" : "ə";
  }
  if (base === "er") {
    return stress !== null && stress >= 1 ? "ɝ" : "ɚ";
  }
  return ARPA_TO_IPA[base] ?? base;
}

export function mapSpeechaceAssessment(json: unknown, alphabet: PhonemeAlphabet): MappedAssessment {
  const root = asRecord(json);
  if (!root) {
    throw new AssessmentError("INCOMPLETE_RESULT", "Speechace response was not an object.");
  }
  const status = readString(root, "status");
  if (status === "error" || (status !== null && status !== "success" && status !== "warning")) {
    throw speechaceStatusError(root, status ?? "error");
  }
  if (status === null) {
    throw new AssessmentError("INCOMPLETE_RESULT", "Speechace response did not include a status.");
  }
  const textScore = asRecord(root.text_score);
  if (!textScore) {
    throw new AssessmentError("INCOMPLETE_RESULT", "Speechace response did not include text_score.");
  }
  const speechaceScore = asRecord(textScore.speechace_score);
  const words = mapWords(textScore, alphabet);
  const pronunciation = speechaceScore ? roundScore(speechaceScore.pronunciation) : null;
  return {
    recognitionStatus: status,
    displayText: readString(textScore, "text"),
    lexicalText: null,
    confidence: null,
    signalToNoiseRatio: null,
    ...timingSpan(words ?? []),
    scores: {
      accuracy: pronunciation,
      fluency: speechaceScore ? roundScore(speechaceScore.fluency) : null,
      completeness: null,
      prosody: null,
      pronunciation,
    },
    words,
  };
}

export function loadSpeechaceKey(env: NodeJS.ProcessEnv): string {
  const key = env.SPEECHACE_API_KEY?.trim() ?? "";
  if (!key) {
    throw new AssessmentError(
      "MISSING_CREDENTIALS",
      "SPEECHACE_API_KEY is not set. The key is read from the environment only and is never printed.",
    );
  }
  return key;
}

export function unusedSpeechBackend(): SpeechBackend {
  return {
    async assess() {
      throw new AssessmentError("INTERNAL", "Speechace scoring does not use the Azure backend.");
    },
  };
}

export async function assessSpeechace(input: AssessInput, deps: AssessDeps): Promise<SuccessBody> {
  const secrets = secretsFromEnv(deps.env);
  const audio = await loadLocalWav(input.audioPath);
  const referenceText = validateReferenceText(input.referenceText);
  if (referenceText.length > SPEECHACE_TEXT_MAX_CHARS) {
    throw new AssessmentError(
      "INVALID_REFERENCE",
      `Reference text is longer than ${SPEECHACE_TEXT_MAX_CHARS} characters, which Speechace text scoring rejects.`,
      { details: { characters: referenceText.length, maxCharacters: SPEECHACE_TEXT_MAX_CHARS } },
    );
  }
  const { locale, dialect } = resolveSpeechaceDialect(input.locale);
  const alphabet: PhonemeAlphabet = input.phonemeAlphabet ?? "IPA";
  const timeoutMs = validateTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const synthetic = deps.mode === "synthetic";
  const key = loadSpeechaceKey(deps.env);

  diagnostic(
    deps.stderr,
    `audio accepted (${audio.bytes.length} bytes, ${audio.info.durationMs} ms, ${audio.info.sampleRateHz} Hz mono pcm)`,
    secrets,
  );
  diagnostic(
    deps.stderr,
    `dialect ${dialect}; phoneme alphabet ${alphabet}; prosody not requested`,
    secrets,
  );
  if (synthetic) {
    diagnostic(deps.stderr, "synthetic fixture; Speechace was not called", secrets);
  } else {
    diagnostic(deps.stderr, "calling Speechace text scoring", secrets);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = synthetic
      ? await readSpeechaceFixture(deps.env.PA_SPEECHACE_RESPONSE_FILE?.trim() ?? "")
      : await requestSpeechaceScore({
          key,
          dialect,
          referenceText,
          audio: audio.bytes,
          signal: controller.signal,
          fetchImpl: deps.fetchImpl ?? globalThis.fetch,
          secrets,
        });
    if (controller.signal.aborted) {
      throw new AssessmentError("TIMEOUT", `Assessment timed out after ${timeoutMs} ms.`, {
        details: { timeoutMs },
      });
    }
    const assessment = mapSpeechaceAssessment(payload, alphabet);
    diagnostic(deps.stderr, synthetic ? "fixture completed" : "assessment completed", secrets);
    return {
      ok: true,
      synthetic,
      audio: {
        fileName: audio.fileName,
        bytes: audio.bytes.length,
        durationMs: audio.info.durationMs,
        sampleRateHz: audio.info.sampleRateHz,
        channels: audio.info.channels,
        bitsPerSample: audio.info.bitsPerSample,
        encoding: "pcm",
      },
      request: {
        locale,
        referenceText,
        phonemeAlphabet: alphabet,
        gradingSystem: "HundredMark",
        granularity: "Phoneme",
        dimension: null,
        enableMiscue: false,
        enableProsodyAssessment: false,
        nBestPhonemeCount: null,
        prosodySupportedForLocale: false,
      },
      assessment,
      provider: {
        name: synthetic ? "synthetic-fixture" : "speechace",
        scoring: "speechace",
        azureCalled: false,
        speechaceCalled: !synthetic,
        sdkVersion: null,
        region: null,
        endpointHost: synthetic ? null : "api.speechace.co",
        connection: null,
        dialect,
        resultReason: assessment.recognitionStatus,
        resultId: null,
        sessionId: null,
      },
      notes: speechaceNotes(synthetic),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AssessmentError("TIMEOUT", `Assessment timed out after ${timeoutMs} ms.`, {
        details: { timeoutMs },
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestSpeechaceScore(input: {
  key: string;
  dialect: "en-us" | "en-gb";
  referenceText: string;
  audio: Buffer;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  secrets: readonly string[];
}): Promise<unknown> {
  if (input.signal.aborted) {
    throw new AssessmentError("TIMEOUT", "Assessment was canceled before Speechace was called.");
  }
  const url = new URL(SPEECHACE_SCORE_TEXT_URL);
  url.searchParams.set("key", input.key);
  url.searchParams.set("dialect", input.dialect);
  const form = new FormData();
  form.set("text", input.referenceText);
  form.set("user_audio_file", new File([new Uint8Array(input.audio)], "audio.wav", { type: "audio/wav" }));

  let response: Response;
  try {
    response = await input.fetchImpl(url, { method: "POST", body: form, signal: input.signal });
  } catch (error) {
    if (input.signal.aborted) {
      throw new AssessmentError("TIMEOUT", "Assessment was canceled before Speechace responded.");
    }
    const message = error instanceof Error ? error.message : "Speechace request failed.";
    throw new AssessmentError("PROVIDER_CONNECTION", "Speechace request failed.", {
      details: { providerMessage: clip(redactText(message, input.secrets)) },
    });
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw httpStatusError(response.status, bodyText, input.secrets);
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new AssessmentError("PROVIDER_ERROR", "Speechace response was not JSON.");
  }
}

function speechaceNotes(synthetic: boolean): string[] {
  const notes = [
    "HundredMark scores are Speechace quality_score and speechace_score.pronunciation values from 0 to 100, rounded to the nearest integer. They are not an absolute pronunciation measure and they are not a human rating.",
    "Each phoneme value is the expected phone from Speechace. nBestPhonemes, when present, is sound_most_like, the phone Speechace heard. Its score is null because Speechace does not return a separate hypothesis score. This tool does not invent one and does not produce a correction.",
    "Prosody, confidence, signal-to-noise, completeness, and Azure error types are not returned by this Speechace text request. Null is not a zero.",
  ];
  if (synthetic) {
    notes.push("Synthetic fixture mode. Speechace was not called. This result is not a real assessment.");
  } else {
    notes.push("The audio and reference text were sent to Speechace for this assessment.");
  }
  return notes;
}

function mapWords(textScore: Record<string, unknown>, alphabet: PhonemeAlphabet): WordResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(textScore, "word_score_list")) {
    return null;
  }
  if (!Array.isArray(textScore.word_score_list)) {
    return null;
  }
  return textScore.word_score_list.map((item) => mapWord(item, alphabet));
}

function mapWord(item: unknown, alphabet: PhonemeAlphabet): WordResult {
  const word = asRecord(item);
  if (!word) {
    return emptyWord();
  }
  const phonemes = mapPhones(word, alphabet);
  const syllables = mapSyllables(word);
  return {
    word: readString(word, "word"),
    accuracy: roundScore(word.quality_score),
    errorType: null,
    ...timingSpan([...(phonemes ?? []), ...(phonemes ? [] : syllables ?? [])]),
    syllables,
    phonemes,
    feedback: null,
  };
}

function emptyWord(): WordResult {
  return {
    word: null,
    accuracy: null,
    errorType: null,
    ...emptyTiming(),
    syllables: null,
    phonemes: null,
    feedback: null,
  };
}

function mapSyllables(word: Record<string, unknown>): SyllableResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(word, "syllable_score_list")) {
    return null;
  }
  if (!Array.isArray(word.syllable_score_list)) {
    return null;
  }
  return word.syllable_score_list.map((item) => {
    const syllable = asRecord(item);
    if (!syllable) {
      return { syllable: null, accuracy: null, ...emptyTiming() };
    }
    return {
      syllable: readString(syllable, "letters"),
      accuracy: roundScore(syllable.quality_score),
      ...extentTiming(syllable.extent),
    };
  });
}

function mapPhones(word: Record<string, unknown>, alphabet: PhonemeAlphabet): PhonemeResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(word, "phone_score_list")) {
    return null;
  }
  if (!Array.isArray(word.phone_score_list)) {
    return null;
  }
  return word.phone_score_list.map((item) => {
    const phone = asRecord(item);
    if (!phone) {
      return { phoneme: null, accuracy: null, nBestPhonemes: null, ...emptyTiming() };
    }
    const stress = readStress(phone);
    const expected = readString(phone, "phone");
    return {
      phoneme: expected === null ? null : speechacePhoneName(expected, stress, alphabet),
      accuracy: roundScore(phone.quality_score),
      nBestPhonemes: mapHeard(phone, alphabet),
      ...extentTiming(phone.extent),
    };
  });
}

function mapHeard(phone: Record<string, unknown>, alphabet: PhonemeAlphabet): NBestPhoneme[] | null {
  if (!Object.prototype.hasOwnProperty.call(phone, "sound_most_like")) {
    return null;
  }
  const heard = readString(phone, "sound_most_like");
  if (heard === null) {
    return [{ phoneme: null, score: null }];
  }
  // stress_level on this phone is the expected stress. Reuse it so a matching
  // ARPAbet token (ah, er) becomes the same IPA symbol as the expected phone.
  return [{ phoneme: speechacePhoneName(heard, readStress(phone), alphabet), score: null }];
}

function speechaceStatusError(root: Record<string, unknown>, status: string): AssessmentError {
  const short = readString(root, "short_message");
  const detail = readString(root, "detail_message");
  const code = short && RECOGNITION_FAILURES.has(short) ? "RECOGNITION_FAILED" : "PROVIDER_ERROR";
  const message = short
    ? `Speechace scoring failed (${short}).`
    : `Speechace scoring status was ${status}.`;
  return new AssessmentError(code, message, {
    details: {
      status,
      ...(short ? { shortMessage: short } : {}),
      ...(detail ? { providerMessage: detail } : {}),
    },
  });
}

function httpStatusError(status: number, bodyText: string, secrets: readonly string[]): AssessmentError {
  const providerMessage = clip(redactText(bodyText, secrets));
  const details = providerMessage ? { status, providerMessage } : { status };
  if (status === 401 || status === 403) {
    return new AssessmentError(
      "PROVIDER_AUTH",
      "Speechace rejected the credentials. Check SPEECHACE_API_KEY. The key is not included in this error.",
      { details },
    );
  }
  if (status === 429) {
    return new AssessmentError("PROVIDER_QUOTA", "Speechace refused the request because of quota.", { details });
  }
  if (status === 408 || status === 504) {
    return new AssessmentError("PROVIDER_TIMEOUT", "Speechace timed out waiting for a response.", { details });
  }
  return new AssessmentError("PROVIDER_ERROR", `Speechace returned HTTP ${status}.`, { details });
}

function extentTiming(value: unknown): Timing {
  if (!Array.isArray(value) || value.length < 2) {
    return emptyTiming();
  }
  const start = finite(value[0]);
  const end = finite(value[1]);
  if (start === null || end === null) {
    return emptyTiming();
  }
  const offsetMs = start * 10;
  const durationMs = (end - start) * 10;
  return {
    offsetMs,
    durationMs,
    offsetTicks: offsetMs * 10_000,
    durationTicks: durationMs * 10_000,
  };
}

function timingSpan(items: Timing[]): Timing {
  const placed = items.filter((item) => item.offsetMs !== null);
  if (placed.length === 0) {
    return emptyTiming();
  }
  const offsetMs = Math.min(...placed.map((item) => item.offsetMs ?? 0));
  const ends = placed
    .filter((item) => item.durationMs !== null)
    .map((item) => (item.offsetMs ?? 0) + (item.durationMs ?? 0));
  if (ends.length === 0) {
    return { offsetMs, durationMs: null, offsetTicks: offsetMs * 10_000, durationTicks: null };
  }
  const durationMs = Math.max(...ends) - offsetMs;
  return {
    offsetMs,
    durationMs,
    offsetTicks: offsetMs * 10_000,
    durationTicks: durationMs * 10_000,
  };
}

function emptyTiming(): Timing {
  return { offsetTicks: null, durationTicks: null, offsetMs: null, durationMs: null };
}

function readStress(record: Record<string, unknown>): number | null {
  if (!Object.prototype.hasOwnProperty.call(record, "stress_level")) {
    return null;
  }
  const value = record.stress_level;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readSpeechaceFixture(fixturePath: string): Promise<unknown> {
  if (!fixturePath) {
    throw new AssessmentError("SYNTHETIC_FIXTURE", "PA_SPEECHACE_RESPONSE_FILE is empty.");
  }
  const raw = await readFile(fixturePath, "utf8").catch(() => {
    throw new AssessmentError("SYNTHETIC_FIXTURE", "Speechace fixture file could not be read.");
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AssessmentError("SYNTHETIC_FIXTURE", "Speechace fixture file is not JSON.");
  }
}

function clip(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  return typeof record[key] === "string" ? record[key] : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
