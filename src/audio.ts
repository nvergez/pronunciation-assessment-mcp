import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { AssessmentError } from "./errors.js";
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  REQUIRED_BITS_PER_SAMPLE,
  REQUIRED_CHANNELS,
  REQUIRED_SAMPLE_RATE_HZ,
} from "./limits.js";

export interface WavInfo {
  encoding: "pcm";
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
  durationSeconds: number;
}

export interface LoadedAudio {
  fileName: string;
  bytes: Buffer;
  info: WavInfo;
}

export function assertLocalAudioPath(input: string): void {
  if (input.includes("\0")) {
    throw new AssessmentError("INVALID_AUDIO", "Audio path contains a null byte.");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AssessmentError("INVALID_AUDIO", "Audio path is empty.");
  }
  if (isRemotePath(trimmed)) {
    throw new AssessmentError(
      "INVALID_AUDIO",
      "Only a local filesystem path is accepted. URLs are not fetched.",
    );
  }
}

function isRemotePath(input: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    return true;
  }
  if (/^(https?|file|ftp|ftps|s3|gs|blob|data):/i.test(input)) {
    return true;
  }
  if (input.startsWith("//") || input.startsWith("\\\\")) {
    return true;
  }
  return false;
}

export async function loadLocalWav(audioPath: string): Promise<LoadedAudio> {
  assertLocalAudioPath(audioPath);
  const resolved = path.resolve(audioPath);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      throw new AssessmentError("INVALID_AUDIO", "Audio file was not found.");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new AssessmentError("INVALID_AUDIO", "Audio file is not readable.");
    }
    throw new AssessmentError("INVALID_AUDIO", "Audio file could not be read.");
  }
  if (!fileStat.isFile()) {
    throw new AssessmentError("INVALID_AUDIO", "Audio path is not a file.");
  }
  if (fileStat.size <= 0) {
    throw new AssessmentError("INVALID_AUDIO", "Audio file is empty.");
  }
  if (fileStat.size > MAX_AUDIO_BYTES) {
    throw new AssessmentError(
      "INVALID_AUDIO",
      `Audio file is larger than ${MAX_AUDIO_BYTES} bytes. The assessed clip must be at most ${MAX_AUDIO_SECONDS} seconds of 16 kHz 16-bit mono PCM.`,
      { details: { bytes: fileStat.size, maxBytes: MAX_AUDIO_BYTES } },
    );
  }
  const bytes = await readFile(resolved);
  const info = parseWavPcm(bytes);
  return { fileName: path.basename(resolved), bytes, info };
}

export function parseWavPcm(buffer: Buffer): WavInfo {
  if (buffer.length < 12) {
    throw new AssessmentError("INVALID_AUDIO", "Audio file is too small to be a WAV.");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new AssessmentError(
      "INVALID_AUDIO",
      "Audio must be a WAV PCM file. Compressed formats are not accepted.",
    );
  }

  let offset = 12;
  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRateHz: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) {
      throw new AssessmentError("INVALID_AUDIO", "Audio WAV is truncated.");
    }
    if (id === "fmt ") {
      if (size < 16) {
        throw new AssessmentError("INVALID_AUDIO", "Audio WAV fmt chunk is incomplete.");
      }
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRateHz: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (dataBytes !== null) {
        throw new AssessmentError("INVALID_AUDIO", "Audio WAV contains more than one data chunk.");
      }
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || dataBytes === null) {
    throw new AssessmentError("INVALID_AUDIO", "Audio WAV is missing a fmt or data chunk.");
  }
  if (fmt.audioFormat !== 1) {
    throw new AssessmentError("INVALID_AUDIO", "Audio must be uncompressed PCM. Compressed WAV is not accepted.");
  }
  if (
    fmt.channels !== REQUIRED_CHANNELS ||
    fmt.bitsPerSample !== REQUIRED_BITS_PER_SAMPLE ||
    fmt.sampleRateHz !== REQUIRED_SAMPLE_RATE_HZ
  ) {
    throw new AssessmentError(
      "INVALID_AUDIO",
      `Audio must be ${REQUIRED_SAMPLE_RATE_HZ} Hz, ${REQUIRED_BITS_PER_SAMPLE}-bit, mono PCM. This file is ${fmt.sampleRateHz} Hz, ${fmt.bitsPerSample}-bit, ${fmt.channels} channel(s).`,
    );
  }
  const expectedBlockAlign = REQUIRED_CHANNELS * (REQUIRED_BITS_PER_SAMPLE / 8);
  const expectedByteRate = REQUIRED_SAMPLE_RATE_HZ * expectedBlockAlign;
  if (fmt.blockAlign !== expectedBlockAlign || fmt.byteRate !== expectedByteRate) {
    throw new AssessmentError("INVALID_AUDIO", "Audio WAV header is internally inconsistent.");
  }
  if (dataBytes <= 0 || dataBytes % expectedBlockAlign !== 0) {
    throw new AssessmentError("INVALID_AUDIO", "Audio WAV data chunk is empty or misaligned.");
  }

  const samples = dataBytes / expectedBlockAlign;
  const durationSeconds = samples / REQUIRED_SAMPLE_RATE_HZ;
  if (samples > REQUIRED_SAMPLE_RATE_HZ * MAX_AUDIO_SECONDS) {
    throw new AssessmentError(
      "INVALID_AUDIO",
      `Audio is longer than ${MAX_AUDIO_SECONDS} seconds (${durationSeconds.toFixed(3)} s). Continuous recognition is not used here because Azure does not return miscue tags in that mode.`,
      { details: { durationSeconds, maxSeconds: MAX_AUDIO_SECONDS } },
    );
  }

  return {
    encoding: "pcm",
    sampleRateHz: fmt.sampleRateHz,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes,
    durationSeconds,
    durationMs: (samples * 1000) / REQUIRED_SAMPLE_RATE_HZ,
  };
}
