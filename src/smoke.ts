#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AssessmentError } from "./errors.js";
import { loadCredentials } from "./credentials.js";
import { executeAssessment, syntheticEnabled } from "./execute.js";
import { diagnostic } from "./log.js";
import { toErrorBody, writeResult } from "./output.js";
import { secretsFromEnv } from "./redact.js";
import { assertOfficialSample, INTEGRATION_SMOKE, OFFICIAL_SAMPLE_REFERENCE } from "./sample.js";

const USAGE = `pronunciation-assess-smoke [--no-prosody] [--timeout-ms <ms>]

Integration smoke against Azure Speech using Microsoft's bundled short sample
whatstheweatherlike.wav and the reference text "what's the weather like".
This is the official Microsoft sample, not a recording of a user.

The sample audio and reference text are sent to Azure Speech. SPEECH_KEY is
read from the environment and is never printed. This command does not create
or modify an Azure resource.

Required environment:
  SPEECH_KEY       Your Speech resource key. Do not paste it into the shell history.
  SPEECH_REGION    Your Speech resource region, for example westus.

Optional:
  SPEECH_ENDPOINT  Only for a private link or other non-portal speech endpoint.
                   The portal host https://<region>.api.cognitive.microsoft.com/
                   is not the recognition websocket. It selects fromSubscription.

Unset PA_SYNTHETIC_RESPONSE_FILE. This command refuses to run in fixture mode.
`;

interface SmokeArgs {
  help: boolean;
  enableProsody?: boolean;
  timeoutMs?: number;
}

export async function runSmoke(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const secrets = secretsFromEnv(env);
  try {
    const args = parseSmokeArgs(argv);
    if (args.help) {
      stderr.write(USAGE);
      stdout.write(`${JSON.stringify({ ok: true, help: true, integrationSmoke: true })}\n`);
      return 0;
    }
    if (syntheticEnabled(env)) {
      throw new AssessmentError(
        "INVALID_CONFIG",
        "PA_SYNTHETIC_RESPONSE_FILE is set. Refusing the live Azure smoke because it would not call Azure. Unset it and run again.",
      );
    }
    const audioPath = await assertOfficialSample();
    loadCredentials(env);
    diagnostic(
      stderr,
      "Integration smoke: Microsoft sample whatstheweatherlike.wav. This is not a recording of a user. Audio and reference text will be sent to Azure Speech.",
      secrets,
    );
    return await executeAssessment({
      input: {
        audioPath,
        referenceText: OFFICIAL_SAMPLE_REFERENCE,
        locale: "en-US",
        enableProsody: args.enableProsody,
        timeoutMs: args.timeoutMs,
      },
      env,
      stdout,
      stderr,
      integrationSmoke: INTEGRATION_SMOKE,
    });
  } catch (error) {
    const body = toErrorBody(error, secrets, false);
    writeResult(stdout, { ...body, integrationSmoke: INTEGRATION_SMOKE }, secrets);
    diagnostic(stderr, body.error.message, secrets);
    return error instanceof AssessmentError ? error.exitCode : 1;
  }
}

function parseSmokeArgs(argv: string[]): SmokeArgs {
  const args = argv.slice(2);
  const parsed: SmokeArgs = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--no-prosody") {
      parsed.enableProsody = false;
      continue;
    }
    if (arg === "--audio" || arg === "--reference" || arg === "--locale") {
      throw new AssessmentError(
        "INVALID_INPUT",
        "The smoke command only assesses the bundled Microsoft sample. It does not accept another audio file or reference text.",
      );
    }
    if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (value === undefined || !/^-?\d+$/.test(value)) {
        throw new AssessmentError("INVALID_INPUT", "--timeout-ms must be an integer.");
      }
      parsed.timeoutMs = Number(value);
      index += 1;
      continue;
    }
    throw new AssessmentError("INVALID_INPUT", `Unknown argument ${arg}.`);
  }
  return parsed;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  runSmoke(process.argv, process.env, process.stdout, process.stderr)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
