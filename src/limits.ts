/**
 * Limits checked locally before any audio is sent.
 *
 * Sources retrieved 2026-11-06:
 * - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
 * - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
 * - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support
 * - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
 * - https://azure.microsoft.com/en-us/pricing/details/speech/
 *
 * Short-audio pronunciation assessment is documented at no more than 30 seconds.
 * The SDK says files longer than 30 seconds need continuous recognition, and
 * EnableMiscue is not supported in that mode. This prototype stays on
 * recognizeOnce so omission and insertion tags come from Azure, not from a
 * local comparison.
 *
 * The REST short-audio contract for WAV is PCM, 16 kHz, mono, 256 kbps
 * (16-bit). The SDK can accept more formats; this prototype accepts only the
 * WAV shape it can validate without decoding compressed audio.
 *
 * Azure does not publish a reference-text character maximum. MAX_REFERENCE_CHARS
 * is a local guard for a single short utterance, not a service limit.
 */
export const MAX_AUDIO_SECONDS = 30;
export const REQUIRED_SAMPLE_RATE_HZ = 16_000;
export const REQUIRED_CHANNELS = 1;
export const REQUIRED_BITS_PER_SAMPLE = 16;
export const MAX_AUDIO_BYTES = 2_000_000;
export const MAX_REFERENCE_CHARS = 2_000;
export const DEFAULT_TIMEOUT_MS = 90_000;
export const MIN_TIMEOUT_MS = 50;
export const MAX_TIMEOUT_MS = 180_000;
export const NBEST_PHONEME_COUNT = 5;
export const DEFAULT_LOCALE = "en-US";
export const SPEECH_SDK_VERSION = "1.53.0";

export const DOCS_RETRIEVED_ON = "2026-11-06";
