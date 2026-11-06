import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLocalWav, parseWavPcm } from "../src/audio.js";
import { loadCredentials } from "../src/credentials.js";
import { AssessmentError } from "../src/errors.js";
import { MAX_AUDIO_BYTES, SPEECH_SDK_VERSION } from "../src/limits.js";
import { PRONUNCIATION_LOCALES } from "../src/locales.js";
import { mapAzureAssessment } from "../src/map-result.js";
import { redactText } from "../src/redact.js";
import { buildAssessmentRequest } from "../src/request-options.js";
import { officialSamplePath, OFFICIAL_SAMPLE_SHA256 } from "../src/sample.js";
import { HELLO_RESULT, PROSODY_RESULT, collectKeys, makePcmWav } from "./support.js";

test("documents 33 pronunciation locales and the pinned Speech SDK", async () => {
  assert.equal(PRONUNCIATION_LOCALES.length, 33);
  assert.ok(PRONUNCIATION_LOCALES.includes("en-US"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["microsoft-cognitiveservices-speech-sdk"], SPEECH_SDK_VERSION);
});

test("parses the bundled Microsoft sample as 16 kHz mono PCM under 30 seconds", async () => {
  const samplePath = officialSamplePath();
  const bytes = await readFile(samplePath);
  assert.equal(
    (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
    OFFICIAL_SAMPLE_SHA256,
  );
  const info = parseWavPcm(bytes);
  assert.equal(info.sampleRateHz, 16_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(info.durationSeconds > 0);
  assert.ok(info.durationSeconds <= 30);
});

test("rejects remote paths, bad WAV shapes, overlong audio, and oversized files", async () => {
  await assert.rejects(
    () => loadLocalWav("https://example.com/a.wav"),
    (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_AUDIO",
  );
  await assert.rejects(
    () => loadLocalWav("file:///tmp/a.wav"),
    (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_AUDIO",
  );
  assert.throws(() => parseWavPcm(Buffer.from("not a wav")), (error: unknown) => {
    return error instanceof AssessmentError && error.code === "INVALID_AUDIO";
  });
  assert.throws(() => parseWavPcm(makePcmWav(8_000, { channels: 2 })), /mono/);
  assert.throws(() => parseWavPcm(makePcmWav(8_000, { sampleRate: 8_000 })), /16000 Hz/);
  assert.throws(
    () => parseWavPcm(makePcmWav(16_000 * 30 + 1)),
    (error: unknown) => error instanceof AssessmentError && /30 seconds/.test(error.message),
  );

  const directory = await mkdtemp(path.join(tmpdir(), "pa-audio-"));
  try {
    const file = path.join(directory, "big.wav");
    await writeFile(file, makePcmWav(160));
    await truncate(file, MAX_AUDIO_BYTES + 1);
    await assert.rejects(
      () => loadLocalWav(file),
      (error: unknown) => error instanceof AssessmentError && /larger than/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts exactly 30 seconds and rejects missing or mismatched credentials", () => {
  const info = parseWavPcm(makePcmWav(16_000 * 30));
  assert.equal(info.durationSeconds, 30);

  assert.throws(
    () => loadCredentials({}),
    (error: unknown) => error instanceof AssessmentError && error.code === "MISSING_CREDENTIALS",
  );
  assert.throws(
    () => loadCredentials({ SPEECH_KEY: "test-key-secret-value" }),
    (error: unknown) => error instanceof AssessmentError && /SPEECH_REGION/.test(error.message),
  );
  const portal = loadCredentials({
    SPEECH_KEY: "test-key-secret-value",
    SPEECH_REGION: "westus",
    SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
  });
  assert.equal(portal.connection, "subscription");
  assert.equal(portal.endpoint, null);
  assert.equal(portal.endpointHost, null);
  const privateEndpoint = loadCredentials({
    SPEECH_KEY: "test-key-secret-value",
    SPEECH_REGION: "westus",
    SPEECH_ENDPOINT: "https://contoso.cognitiveservices.azure.com/",
  });
  assert.equal(privateEndpoint.connection, "endpoint");
  assert.equal(privateEndpoint.endpointHost, "contoso.cognitiveservices.azure.com");
  assert.equal(
    loadCredentials({ SPEECH_KEY: "test-key-secret-value", SPEECH_REGION: "westus" }).connection,
    "subscription",
  );
  assert.throws(
    () =>
      loadCredentials({
        SPEECH_KEY: "test-key-secret-value",
        SPEECH_REGION: "westus",
        SPEECH_ENDPOINT: "https://westeurope.api.cognitive.microsoft.com/",
      }),
    (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_CONFIG",
  );
  assert.throws(
    () =>
      loadCredentials({
        SPEECH_KEY: "test-key-secret-value",
        SPEECH_REGION: "westus",
        SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/?key=secret",
      }),
    /query string/,
  );
  assert.throws(
    () =>
      loadCredentials({
        SPEECH_KEY: "test-key-secret-value",
        SPEECH_REGION: "westus",
        SPEECH_ENDPOINT: "http://westus.api.cognitive.microsoft.com/",
      }),
    /https/,
  );
});

test("builds the en-US request and refuses unsupported prosody or alphabets", () => {
  const request = buildAssessmentRequest({ referenceText: "  what's the weather like  " });
  assert.equal(request.locale, "en-US");
  assert.equal(request.referenceText, "what's the weather like");
  assert.equal(request.phonemeAlphabet, "IPA");
  assert.equal(request.enableProsodyAssessment, true);
  assert.equal(request.nBestPhonemeCount, 5);
  assert.equal(request.gradingSystem, "HundredMark");
  assert.equal(request.dimension, "Comprehensive");
  assert.equal(request.enableMiscue, true);

  const withoutProsody = buildAssessmentRequest({
    referenceText: "hello",
    enableProsody: false,
  });
  assert.equal(withoutProsody.enableProsodyAssessment, false);

  const mandarin = buildAssessmentRequest({ referenceText: "你好", locale: "zh-CN" });
  assert.equal(mandarin.phonemeAlphabet, "SAPI");
  assert.equal(mandarin.enableProsodyAssessment, false);
  assert.equal(mandarin.nBestPhonemeCount, null);

  const spanish = buildAssessmentRequest({ referenceText: "hola", locale: "es-ES" });
  assert.equal(spanish.phonemeAlphabet, null);
  assert.equal(spanish.enableProsodyAssessment, false);

  assert.throws(
    () => buildAssessmentRequest({ referenceText: "   " }),
    (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_REFERENCE",
  );
  assert.throws(
    () => buildAssessmentRequest({ referenceText: "hola", locale: "en-us" }),
    (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_LOCALE",
  );
  assert.throws(
    () => buildAssessmentRequest({ referenceText: "hola", locale: "es-ES", enableProsody: true }),
    (error: unknown) =>
      error instanceof AssessmentError &&
      error.code === "PROSODY_UNSUPPORTED" &&
      error.message ===
        "Prosody assessment is documented for en-US only. The request to enable it for es-ES was rejected.",
  );
  assert.throws(
    () => buildAssessmentRequest({ referenceText: "hola", locale: "es-ES", phonemeAlphabet: "IPA" }),
    (error: unknown) => error instanceof AssessmentError && error.code === "UNSUPPORTED_PHONEME_ALPHABET",
  );
});

test("redacts the speech key and subscription query without removing the region", () => {
  const redacted = redactText(
    "failed for test-key-secret-value at wss://westus.stt.speech.microsoft.com/speech?Ocp-Apim-Subscription-Key=test-key-secret-value&language=en-US region westus",
    ["test-key-secret-value"],
  );
  assert.equal(redacted.includes("test-key-secret-value"), false);
  assert.match(redacted, /\[redacted\]/);
  assert.match(redacted, /westus/);
  assert.doesNotMatch(redacted, /Ocp-Apim-Subscription-Key=test/);
});

test("maps Azure JSON without inventing spoken phonemes, corrections, or missing prosody", () => {
  const hello = mapAzureAssessment(HELLO_RESULT, null);
  assert.equal(hello.recognitionStatus, "Success");
  assert.equal(hello.displayText, "Hello.");
  assert.equal(hello.scores.accuracy, 100);
  assert.equal(hello.scores.fluency, 100);
  assert.equal(hello.scores.completeness, 100);
  assert.equal(hello.scores.prosody, null);
  assert.equal(hello.scores.pronunciation, 100);
  const phoneme = hello.words?.[0]?.phonemes?.[0];
  assert.equal(phoneme?.phoneme, "ɛ");
  assert.equal(phoneme?.accuracy, 47);
  assert.equal(phoneme?.nBestPhonemes?.[0]?.phoneme, "ə");
  assert.equal(phoneme?.offsetMs, 1110);
  assert.equal(hello.words?.[0]?.syllables?.[0]?.syllable, "hɛ");
  assert.equal(hello.words?.[0]?.errorType, "None");
  const keys = collectKeys(hello);
  for (const forbidden of ["spokenPhoneme", "actualPhoneme", "correction", "correctedPhoneme"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }

  const prosody = mapAzureAssessment(PROSODY_RESULT, null);
  assert.equal(prosody.scores.prosody, 87.8);
  assert.equal(prosody.scores.fluency, 90);
  assert.equal(prosody.scores.completeness, 80);
  assert.equal(prosody.offsetTicks, 700_000);
  assert.equal(prosody.signalToNoiseRatio, 38.76819);
  assert.equal(prosody.words?.[0]?.phonemes, null);
  assert.equal(prosody.words?.[0]?.syllables, null);
  assert.deepEqual(prosody.words?.[0]?.feedback, {
    Prosody: { Break: { ErrorTypes: ["None"], BreakLength: 0 } },
  });
  assert.equal(prosody.words?.[1]?.errorType, "Omission");
  assert.equal(prosody.words?.[1]?.accuracy, null);
  assert.equal(prosody.words?.[1]?.phonemes, null);

  const numericStatus = mapAzureAssessment(
    { RecognitionStatus: 0, NBest: [{ PronunciationAssessment: { AccuracyScore: 1 }, Words: [] }] },
    null,
  );
  assert.equal(numericStatus.recognitionStatus, "0");
  assert.deepEqual(numericStatus.words, []);
  assert.equal(numericStatus.scores.fluency, null);

  assert.throws(
    () => mapAzureAssessment({ RecognitionStatus: "NoMatch", NBest: [{ Display: "x" }] }, null),
    (error: unknown) => error instanceof AssessmentError && error.code === "RECOGNITION_FAILED",
  );
  assert.throws(
    () => mapAzureAssessment({ RecognitionStatus: "Success" }, null),
    (error: unknown) => error instanceof AssessmentError && error.code === "INCOMPLETE_RESULT",
  );
});
