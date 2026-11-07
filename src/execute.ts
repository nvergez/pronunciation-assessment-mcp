import type { Writable } from "node:stream";
import { assessPronunciation } from "./assess.js";
import { createAzureBackend } from "./azure-backend.js";
import { AssessmentError } from "./errors.js";
import { diagnostic } from "./log.js";
import { presentResult, toErrorBody, writeResult } from "./output.js";
import { secretsFromEnv } from "./redact.js";
import { unusedSpeechBackend } from "./speechace.js";
import { createSyntheticBackend } from "./synthetic-backend.js";
import type { AssessInput, IntegrationSmoke, ScoringProvider } from "./types.js";

export function selectedProvider(input: { provider?: ScoringProvider | undefined }): ScoringProvider {
  return input.provider ?? "azure";
}

export function fixtureEnabled(env: NodeJS.ProcessEnv, provider: ScoringProvider = "azure"): boolean {
  const name = provider === "speechace" ? "PA_SPEECHACE_RESPONSE_FILE" : "PA_SYNTHETIC_RESPONSE_FILE";
  return Boolean(env[name]?.trim());
}

export async function assessWithEnv(
  input: AssessInput,
  env: NodeJS.ProcessEnv,
  stderr: Writable,
) {
  const provider = selectedProvider(input);
  if (provider === "speechace") {
    const fixture = fixtureEnabled(env, "speechace");
    return assessPronunciation(input, {
      env,
      stderr,
      mode: fixture ? "synthetic" : "speechace",
      backend: unusedSpeechBackend(),
    });
  }
  const syntheticPath = env.PA_SYNTHETIC_RESPONSE_FILE?.trim() ?? "";
  return assessPronunciation(input, {
    env,
    stderr,
    mode: syntheticPath ? "synthetic" : "azure",
    backend: syntheticPath ? createSyntheticBackend(syntheticPath) : createAzureBackend(),
  });
}

export async function executeAssessment(options: {
  input: AssessInput;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
  integrationSmoke?: IntegrationSmoke | undefined;
}): Promise<number> {
  const secrets = secretsFromEnv(options.env);
  const synthetic = fixtureEnabled(options.env, selectedProvider(options.input));
  try {
    const body = await assessWithEnv(options.input, options.env, options.stderr);
    writeResult(options.stdout, presentResult(body, options.integrationSmoke), secrets);
    return 0;
  } catch (error) {
    const body = toErrorBody(error, synthetic);
    const presented = presentResult(body, options.integrationSmoke);
    writeResult(options.stdout, presented, secrets);
    diagnostic(options.stderr, body.error.message, secrets);
    return error instanceof AssessmentError ? error.exitCode : 3;
  }
}

export function syntheticEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PA_SYNTHETIC_RESPONSE_FILE?.trim());
}
