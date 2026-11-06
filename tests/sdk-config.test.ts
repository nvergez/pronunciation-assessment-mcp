import assert from "node:assert/strict";
import test from "node:test";

test("Speech SDK config requests the documented scripted-assessment flags", async () => {
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const config = new sdk.PronunciationAssessmentConfig(
    "what's the weather like",
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true,
  );
  config.phonemeAlphabet = "IPA";
  config.nbestPhonemeCount = 5;
  config.enableProsodyAssessment = true;
  const payload = JSON.parse(config.toJSON()) as Record<string, unknown>;
  assert.deepEqual(payload, {
    referenceText: "what's the weather like",
    gradingSystem: "HundredMark",
    granularity: "Phoneme",
    phonemeAlphabet: "IPA",
    nbestPhonemeCount: 5,
    enableProsodyAssessment: true,
    dimension: "Comprehensive",
    enableMiscue: true,
  });
});
