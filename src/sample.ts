import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssessmentError } from "./errors.js";
import type { IntegrationSmoke } from "./types.js";

/** Microsoft sample used by the Speech SDK pronunciation-assessment samples. */
export const OFFICIAL_SAMPLE_REFERENCE = "what's the weather like";

export const OFFICIAL_SAMPLE_SHA256 =
  "ff97e7906d20c26620cf11b86a1c7f62200b4437786733a3e7513ec85608bde6";

export const OFFICIAL_SAMPLE_SOURCE =
  "https://github.com/Azure-Samples/cognitive-services-speech-sdk/blob/master/samples/csharp/sharedcontent/console/whatstheweatherlike.wav";

export const OFFICIAL_SAMPLE_DOCUMENTED_IN =
  "https://github.com/Azure-Samples/cognitive-services-speech-sdk/blob/master/scenarios/csharp/sharedcontent/console/speech_recognition_samples.cs";

export const INTEGRATION_SMOKE: IntegrationSmoke = {
  label: "integration-smoke",
  sampleId: "azure-samples-whatstheweatherlike",
  referenceText: OFFICIAL_SAMPLE_REFERENCE,
  source: OFFICIAL_SAMPLE_SOURCE,
  documentedIn: OFFICIAL_SAMPLE_DOCUMENTED_IN,
  speaker: "microsoft-official-sample",
};

export function officialSamplePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../samples/whatstheweatherlike.wav");
}

export async function assertOfficialSample(): Promise<string> {
  const samplePath = officialSamplePath();
  let bytes: Buffer;
  try {
    bytes = await readFile(samplePath);
  } catch {
    throw new AssessmentError(
      "INVALID_AUDIO",
      "The bundled Microsoft sample WAV is missing from the package.",
    );
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== OFFICIAL_SAMPLE_SHA256) {
    throw new AssessmentError(
      "INVALID_AUDIO",
      "The bundled sample does not match the expected Microsoft file. Refusing to send it.",
    );
  }
  return samplePath;
}
