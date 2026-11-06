import { AssessmentError } from "./errors.js";
import type { NBestPhoneme, PhonemeResult, SyllableResult, WordResult } from "./types.js";

const FAILURE_STATUSES = new Set(["NoMatch", "InitialSilenceTimeout", "BabbleTimeout", "Error"]);

export interface MappedAssessment {
  recognitionStatus: string | null;
  displayText: string | null;
  lexicalText: string | null;
  confidence: number | null;
  signalToNoiseRatio: number | null;
  offsetTicks: number | null;
  durationTicks: number | null;
  offsetMs: number | null;
  durationMs: number | null;
  scores: {
    accuracy: number | null;
    fluency: number | null;
    completeness: number | null;
    prosody: number | null;
    pronunciation: number | null;
  };
  words: WordResult[] | null;
}

export function mapAzureAssessment(json: unknown, sdkDisplayText: string | null): MappedAssessment {
  const root = asRecord(json);
  if (!root) {
    throw new AssessmentError("INCOMPLETE_RESULT", "Azure JSON result was not an object.");
  }
  const recognitionStatus = readStatus(root);
  if (recognitionStatus && (FAILURE_STATUSES.has(recognitionStatus) || !isAcceptedStatus(recognitionStatus))) {
    throw new AssessmentError(
      "RECOGNITION_FAILED",
      `Azure Speech recognition status was ${recognitionStatus}.`,
      { details: { recognitionStatus } },
    );
  }

  const nbest = firstRecord(root.NBest, "Azure JSON result did not include an NBest entry.");
  const displayFromJson = readString(root, "DisplayText") ?? readString(nbest, "Display");
  const displayText = displayFromJson ?? (sdkDisplayText && sdkDisplayText.trim() ? sdkDisplayText : null);
  const utteranceTiming = timingOf(root);

  return {
    recognitionStatus,
    displayText,
    lexicalText: readString(nbest, "Lexical"),
    confidence: readNumber(nbest, "Confidence"),
    signalToNoiseRatio: readNumber(root, "SNR"),
    ...utteranceTiming,
    scores: {
      accuracy: scoreAt(nbest, "AccuracyScore"),
      fluency: scoreAt(nbest, "FluencyScore"),
      completeness: scoreAt(nbest, "CompletenessScore"),
      prosody: scoreAt(nbest, "ProsodyScore"),
      pronunciation: scoreAt(nbest, "PronScore"),
    },
    words: mapWords(nbest),
  };
}

function isAcceptedStatus(status: string): boolean {
  return status === "Success" || status === "0";
}

function mapWords(nbest: Record<string, unknown>): WordResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(nbest, "Words")) {
    return null;
  }
  if (!Array.isArray(nbest.Words)) {
    return null;
  }
  return nbest.Words.map((item) => mapWord(item));
}

function mapWord(item: unknown): WordResult {
  const word = asRecord(item);
  if (!word) {
    return emptyWord();
  }
  return {
    word: readString(word, "Word"),
    accuracy: scoreAt(word, "AccuracyScore"),
    errorType: stringAt(word, "ErrorType"),
    ...timingOf(word),
    syllables: mapSyllables(word),
    phonemes: mapPhonemes(word),
    feedback: jsonField(word, "Feedback"),
  };
}

function emptyWord(): WordResult {
  return {
    word: null,
    accuracy: null,
    errorType: null,
    offsetTicks: null,
    durationTicks: null,
    offsetMs: null,
    durationMs: null,
    syllables: null,
    phonemes: null,
    feedback: null,
  };
}

function mapSyllables(word: Record<string, unknown>): SyllableResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(word, "Syllables")) {
    return null;
  }
  if (!Array.isArray(word.Syllables)) {
    return null;
  }
  return word.Syllables.map((item) => {
    const syllable = asRecord(item);
    if (!syllable) {
      return {
        syllable: null,
        accuracy: null,
        offsetTicks: null,
        durationTicks: null,
        offsetMs: null,
        durationMs: null,
      };
    }
    return {
      syllable: readString(syllable, "Syllable"),
      accuracy: scoreAt(syllable, "AccuracyScore"),
      ...timingOf(syllable),
    };
  });
}

function mapPhonemes(word: Record<string, unknown>): PhonemeResult[] | null {
  if (!Object.prototype.hasOwnProperty.call(word, "Phonemes")) {
    return null;
  }
  if (!Array.isArray(word.Phonemes)) {
    return null;
  }
  return word.Phonemes.map((item) => {
    const phoneme = asRecord(item);
    if (!phoneme) {
      return {
        phoneme: null,
        accuracy: null,
        nBestPhonemes: null,
        offsetTicks: null,
        durationTicks: null,
        offsetMs: null,
        durationMs: null,
      };
    }
    return {
      phoneme: readString(phoneme, "Phoneme"),
      accuracy: scoreAt(phoneme, "AccuracyScore"),
      nBestPhonemes: mapNBest(phoneme),
      ...timingOf(phoneme),
    };
  });
}

function mapNBest(phoneme: Record<string, unknown>): NBestPhoneme[] | null {
  const nested = asRecord(phoneme.PronunciationAssessment);
  const source = nested && Object.prototype.hasOwnProperty.call(nested, "NBestPhonemes")
    ? nested.NBestPhonemes
    : Object.prototype.hasOwnProperty.call(phoneme, "NBestPhonemes")
      ? phoneme.NBestPhonemes
      : undefined;
  if (source === undefined) {
    return null;
  }
  if (!Array.isArray(source)) {
    return null;
  }
  return source.map((item) => {
    const entry = asRecord(item);
    if (!entry) {
      return { phoneme: null, score: null };
    }
    return {
      phoneme: readString(entry, "Phoneme"),
      score: readNumber(entry, "Score"),
    };
  });
}

function scoreAt(record: Record<string, unknown>, key: string): number | null {
  const nested = asRecord(record.PronunciationAssessment);
  if (nested && Object.prototype.hasOwnProperty.call(nested, key)) {
    return finiteOrNull(nested[key]);
  }
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return finiteOrNull(record[key]);
  }
  return null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const nested = asRecord(record.PronunciationAssessment);
  if (nested && Object.prototype.hasOwnProperty.call(nested, key)) {
    return typeof nested[key] === "string" ? nested[key] : null;
  }
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return typeof record[key] === "string" ? record[key] : null;
  }
  return null;
}

function timingOf(record: Record<string, unknown>): {
  offsetTicks: number | null;
  durationTicks: number | null;
  offsetMs: number | null;
  durationMs: number | null;
} {
  const offsetTicks = readTicks(record, "Offset");
  const durationTicks = readTicks(record, "Duration");
  return {
    offsetTicks,
    durationTicks,
    offsetMs: ticksToMs(offsetTicks),
    durationMs: ticksToMs(durationTicks),
  };
}

function ticksToMs(ticks: number | null): number | null {
  if (ticks === null) {
    return null;
  }
  return ticks / 10_000;
}

function readTicks(record: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStatus(root: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(root, "RecognitionStatus")) {
    return null;
  }
  const value = root.RecognitionStatus;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  return typeof record[key] === "string" ? record[key] : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  return finiteOrNull(record[key]);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonField(record: Record<string, unknown>, key: string): unknown | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
  return null;
}

function firstRecord(value: unknown, missingMessage: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AssessmentError("INCOMPLETE_RESULT", missingMessage);
  }
  const record = asRecord(value[0]);
  if (!record) {
    throw new AssessmentError("INCOMPLETE_RESULT", missingMessage);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
