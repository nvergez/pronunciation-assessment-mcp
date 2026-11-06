import type { Writable } from "node:stream";
import type { SpeechBackend } from "./backend.js";
import type { PhonemeAlphabet } from "./request-options.js";

export interface AssessInput {
  audioPath: string;
  referenceText: string;
  locale?: string | undefined;
  phonemeAlphabet?: PhonemeAlphabet | undefined;
  enableProsody?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface AssessDeps {
  env: NodeJS.ProcessEnv;
  stderr: Writable;
  backend: SpeechBackend;
  mode: "azure" | "synthetic";
}

export interface Timing {
  offsetTicks: number | null;
  durationTicks: number | null;
  offsetMs: number | null;
  durationMs: number | null;
}

export interface NBestPhoneme {
  phoneme: string | null;
  score: number | null;
}

export interface PhonemeResult extends Timing {
  /** Expected phoneme name from Azure. Null when the service omits the name. */
  phoneme: string | null;
  accuracy: number | null;
  /** Azure hypotheses. Null when the service does not return them. Not a chosen spoken phoneme. */
  nBestPhonemes: NBestPhoneme[] | null;
}

export interface SyllableResult extends Timing {
  syllable: string | null;
  accuracy: number | null;
}

export interface WordResult extends Timing {
  word: string | null;
  accuracy: number | null;
  errorType: string | null;
  syllables: SyllableResult[] | null;
  phonemes: PhonemeResult[] | null;
  /** Raw Azure word Feedback, including prosody break and intonation fields when present. */
  feedback: unknown | null;
}

export interface IntegrationSmoke {
  label: "integration-smoke";
  sampleId: "azure-samples-whatstheweatherlike";
  referenceText: string;
  source: string;
  documentedIn: string;
  speaker: "microsoft-official-sample";
}

export interface SuccessBody {
  ok: true;
  synthetic: boolean;
  integrationSmoke?: IntegrationSmoke;
  audio: {
    fileName: string;
    bytes: number;
    durationMs: number;
    sampleRateHz: number;
    channels: number;
    bitsPerSample: number;
    encoding: "pcm";
  };
  request: {
    locale: string;
    referenceText: string;
    phonemeAlphabet: PhonemeAlphabet | null;
    gradingSystem: "HundredMark";
    granularity: "Phoneme";
    dimension: "Comprehensive";
    enableMiscue: true;
    enableProsodyAssessment: boolean;
    nBestPhonemeCount: number | null;
    prosodySupportedForLocale: boolean;
  };
  assessment: {
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
  };
  provider: {
    name: "azure-speech" | "synthetic-fixture";
    azureCalled: boolean;
    sdkVersion: string | null;
    region: string | null;
    endpointHost: string | null;
    connection: "subscription" | "endpoint" | null;
    resultReason: string | null;
    resultId: string | null;
    sessionId: string | null;
  };
  notes: string[];
}

export interface ErrorBody {
  ok: false;
  synthetic: boolean;
  integrationSmoke?: IntegrationSmoke;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ResultBody = SuccessBody | ErrorBody;
