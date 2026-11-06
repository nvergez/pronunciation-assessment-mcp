export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_CONFIG = 2;
export const EXIT_PROVIDER = 3;
export const EXIT_TIMEOUT = 4;

export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_AUDIO"
  | "INVALID_LOCALE"
  | "INVALID_REFERENCE"
  | "UNSUPPORTED_PHONEME_ALPHABET"
  | "PROSODY_UNSUPPORTED"
  | "SYNTHETIC_FIXTURE"
  | "MISSING_CREDENTIALS"
  | "INVALID_CONFIG"
  | "TIMEOUT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_AUTH"
  | "PROVIDER_QUOTA"
  | "PROVIDER_CONNECTION"
  | "PROVIDER_ERROR"
  | "RECOGNITION_FAILED"
  | "INCOMPLETE_RESULT"
  | "INTERNAL";

const EXIT_BY_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: EXIT_INVALID,
  INVALID_AUDIO: EXIT_INVALID,
  INVALID_LOCALE: EXIT_INVALID,
  INVALID_REFERENCE: EXIT_INVALID,
  UNSUPPORTED_PHONEME_ALPHABET: EXIT_INVALID,
  PROSODY_UNSUPPORTED: EXIT_INVALID,
  SYNTHETIC_FIXTURE: EXIT_INVALID,
  MISSING_CREDENTIALS: EXIT_CONFIG,
  INVALID_CONFIG: EXIT_CONFIG,
  TIMEOUT: EXIT_TIMEOUT,
  PROVIDER_TIMEOUT: EXIT_TIMEOUT,
  PROVIDER_AUTH: EXIT_PROVIDER,
  PROVIDER_QUOTA: EXIT_PROVIDER,
  PROVIDER_CONNECTION: EXIT_PROVIDER,
  PROVIDER_ERROR: EXIT_PROVIDER,
  RECOGNITION_FAILED: EXIT_PROVIDER,
  INCOMPLETE_RESULT: EXIT_PROVIDER,
  INTERNAL: EXIT_PROVIDER,
};

export class AssessmentError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AssessmentError";
    this.code = code;
    this.exitCode = EXIT_BY_CODE[code];
    this.details = options?.details;
  }
}
