import { AssessmentError } from "./errors.js";
import { stringifyResult } from "./json.js";
import { redactText, redactUnknown } from "./redact.js";
import type { ErrorBody, IntegrationSmoke, ResultBody, SuccessBody } from "./types.js";
import type { Writable } from "node:stream";

export function toErrorBody(error: unknown, secrets: readonly string[], synthetic: boolean): ErrorBody {
  if (error instanceof AssessmentError) {
    const body: ErrorBody = {
      ok: false,
      synthetic,
      error: {
        code: error.code,
        message: redactText(error.message, secrets),
      },
    };
    if (error.details) {
      const details = redactUnknown(error.details, secrets);
      if (details && typeof details === "object" && !Array.isArray(details)) {
        body.error.details = details as Record<string, unknown>;
      }
    }
    return body;
  }
  const message = error instanceof Error ? redactText(error.message, secrets) : "Unexpected failure.";
  return {
    ok: false,
    synthetic,
    error: {
      code: "INTERNAL",
      message: truncate(message, 500) || "Unexpected failure.",
    },
  };
}

export function presentResult(body: ResultBody, integrationSmoke: IntegrationSmoke | undefined): ResultBody {
  if (!integrationSmoke) {
    return body;
  }
  if (body.ok) {
    const success: SuccessBody = {
      ok: true,
      synthetic: body.synthetic,
      integrationSmoke,
      audio: body.audio,
      request: body.request,
      assessment: body.assessment,
      provider: body.provider,
      notes: body.notes,
    };
    return success;
  }
  return {
    ok: false,
    synthetic: body.synthetic,
    integrationSmoke,
    error: body.error,
  };
}

export function writeResult(stdout: Writable, body: ResultBody, secrets: readonly string[]): void {
  try {
    stdout.write(`${stringifyResult(body)}\n`);
  } catch {
    const fallback = toErrorBody(
      new AssessmentError("INTERNAL", "Result could not be serialized."),
      secrets,
      body.synthetic,
    );
    stdout.write(`${stringifyResult(fallback)}\n`);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
