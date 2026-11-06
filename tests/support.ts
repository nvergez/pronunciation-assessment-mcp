import { Writable } from "node:stream";

export const TEST_KEY = "test-key-secret-value";

export function memoryWriter(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

export function makePcmWav(samples: number, options?: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
}): Buffer {
  const sampleRate = options?.sampleRate ?? 16_000;
  const channels = options?.channels ?? 1;
  const bitsPerSample = options?.bitsPerSample ?? 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = samples * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found);
    }
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      collectKeys(nested, found);
    }
  }
  return found;
}

export const HELLO_RESULT = {
  RecognitionStatus: "Success",
  Offset: 7_500_000,
  Duration: 13_800_000,
  DisplayText: "Hello.",
  NBest: [
    {
      Confidence: 0.975003,
      Lexical: "hello",
      Display: "Hello.",
      PronunciationAssessment: {
        AccuracyScore: 100,
        FluencyScore: 100,
        CompletenessScore: 100,
        PronScore: 100,
      },
      Words: [
        {
          Word: "hello",
          Offset: 7_500_000,
          Duration: 13_800_000,
          PronunciationAssessment: {
            AccuracyScore: 99,
            ErrorType: "None",
          },
          Syllables: [
            {
              Syllable: "hɛ",
              PronunciationAssessment: { AccuracyScore: 91 },
              Offset: 7_500_000,
              Duration: 4_100_000,
            },
          ],
          Phonemes: [
            {
              Phoneme: "ɛ",
              PronunciationAssessment: {
                AccuracyScore: 47,
                NBestPhonemes: [
                  { Phoneme: "ə", Score: 100 },
                  { Phoneme: "ɛ", Score: 47 },
                ],
              },
              Offset: 11_100_000,
              Duration: 500_000,
            },
          ],
        },
      ],
    },
  ],
};

export const PROSODY_RESULT = {
  RecognitionStatus: "Success",
  Offset: "700000",
  Duration: "8400000",
  DisplayText: "Good morning.",
  SNR: 38.76819,
  NBest: [
    {
      Confidence: 0.98503506,
      Lexical: "good morning",
      Display: "Good morning.",
      AccuracyScore: 100,
      FluencyScore: 90,
      ProsodyScore: 87.8,
      CompletenessScore: 80,
      PronScore: 95.1,
      Words: [
        {
          Word: "good",
          Offset: 700_000,
          Duration: 2_600_000,
          AccuracyScore: 100,
          ErrorType: "None",
          Feedback: {
            Prosody: {
              Break: { ErrorTypes: ["None"], BreakLength: 0 },
            },
          },
        },
        {
          Word: "skipped",
          ErrorType: "Omission",
        },
      ],
    },
  ],
};
