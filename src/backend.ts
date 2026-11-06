import type { SpeechCredentials } from "./credentials.js";
import type { PhonemeAlphabet } from "./request-options.js";

export interface BackendAssessInput {
  audio: Buffer;
  referenceText: string;
  locale: string;
  phonemeAlphabet: PhonemeAlphabet | null;
  enableProsody: boolean;
  nBestPhonemeCount: number | null;
  credentials: SpeechCredentials;
  signal: AbortSignal;
}

export interface BackendAssessResult {
  jsonResult: unknown | null;
  resultReason: string;
  resultId: string | null;
  sessionId: string | null;
  cancellationReason: string | null;
  cancellationErrorCode: string | null;
  cancellationErrorDetails: string | null;
  sdkDisplayText: string | null;
}

export interface SpeechBackend {
  assess(input: BackendAssessInput): Promise<BackendAssessResult>;
}
