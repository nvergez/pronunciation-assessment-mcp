import { readFile } from "node:fs/promises";
import { z } from "zod";
import { assertLocalAudioPath } from "./audio.js";
import type { BackendAssessResult, SpeechBackend } from "./backend.js";
import { AssessmentError } from "./errors.js";

const syntheticFileSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("success"),
    jsonResult: z.unknown(),
    resultReason: z.string().optional(),
    resultId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    sdkDisplayText: z.string().nullable().optional(),
  }),
  z.object({
    mode: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    mode: z.literal("canceled"),
    errorCode: z.string(),
    errorDetails: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    mode: z.literal("hang"),
  }),
]);

export function createSyntheticBackend(fixturePath: string): SpeechBackend {
  return {
    async assess(input): Promise<BackendAssessResult> {
      assertLocalAudioPath(fixturePath);
      const raw = await readFile(fixturePath, "utf8").catch(() => {
        throw new AssessmentError("SYNTHETIC_FIXTURE", "Synthetic fixture file could not be read.");
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new AssessmentError("SYNTHETIC_FIXTURE", "Synthetic fixture file is not JSON.");
      }
      const fixture = syntheticFileSchema.safeParse(parsed);
      if (!fixture.success) {
        throw new AssessmentError("SYNTHETIC_FIXTURE", "Synthetic fixture file has an unsupported shape.");
      }
      if (fixture.data.mode === "hang") {
        await waitForAbort(input.signal);
        throw new AssessmentError("TIMEOUT", "Synthetic fixture hung until aborted.");
      }
      if (fixture.data.mode === "error") {
        throw new AssessmentError("PROVIDER_ERROR", fixture.data.message);
      }
      if (fixture.data.mode === "canceled") {
        return {
          jsonResult: null,
          resultReason: "Canceled",
          resultId: null,
          sessionId: null,
          cancellationReason: fixture.data.reason ?? "Error",
          cancellationErrorCode: fixture.data.errorCode,
          cancellationErrorDetails: fixture.data.errorDetails ?? null,
          sdkDisplayText: null,
        };
      }
      return {
        jsonResult: fixture.data.jsonResult,
        resultReason: fixture.data.resultReason ?? "RecognizedSpeech",
        resultId: fixture.data.resultId ?? null,
        sessionId: fixture.data.sessionId ?? null,
        cancellationReason: null,
        cancellationErrorCode: null,
        cancellationErrorDetails: null,
        sdkDisplayText: fixture.data.sdkDisplayText ?? null,
      };
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
