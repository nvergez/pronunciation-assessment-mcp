#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AssessmentError } from "./errors.js";
import { executeAssessment } from "./execute.js";
import { diagnostic } from "./log.js";
import { toErrorBody, writeResult } from "./output.js";
import { secretsFromEnv } from "./redact.js";
import type { PhonemeAlphabet } from "./request-options.js";
import type { ScoringProvider } from "./types.js";
import { packageVersion } from "./version.js";

const USAGE = `pronunciation-assess --audio <local.wav> --reference <text> [options]

Assess a local WAV recording against known reference text.
The default provider is Azure Speech. --provider speechace uses Speechace text scoring.
JSON is written to stdout. Diagnostics are written to stderr.
The audio and reference text are sent to the selected provider. Keys are not printed.

Options:
  --audio <path>              Local WAV PCM file (16 kHz, 16-bit, mono, at most 30 s)
  --reference <text>          Known reference text for scripted assessment
  --provider <azure|speechace>
                              Default azure
  --locale <bcp47>            Default en-US. Speechace accepts en-US (dialect en-us) and en-GB (en-gb).
  --phoneme-alphabet <IPA|SAPI>
  --no-prosody                Do not request prosody (Azure, en-US only). Speechace text scoring has no prosody score.
  --timeout-ms <ms>           Local timeout, default 90000
  --help                      Show this help
  --version                   Print the package version

Environment:
  SPEECH_KEY                  Required for azure. Never printed.
  SPEECH_REGION               Required for azure. Your Speech resource region, for example westus.
  SPEECH_ENDPOINT             Optional https endpoint. The regional portal host must match SPEECH_REGION.
  SPEECHACE_API_KEY           Required for speechace. Never printed.
  PA_SYNTHETIC_RESPONSE_FILE  Azure test seam only. Does not call Azure and marks the result synthetic.
  PA_SPEECHACE_RESPONSE_FILE  Speechace test seam only. Does not call Speechace and marks the result synthetic.
`;

interface CliArgs {
  help: boolean;
  version: boolean;
  audioPath?: string;
  referenceText?: string;
  locale?: string;
  phonemeAlphabet?: PhonemeAlphabet;
  enableProsody?: boolean;
  timeoutMs?: number;
  provider?: ScoringProvider;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  const secrets = secretsFromEnv(env);
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      stderr.write(USAGE);
      stdout.write(`${JSON.stringify({ ok: true, help: true })}\n`);
      return 0;
    }
    if (args.version) {
      stdout.write(`${JSON.stringify({ ok: true, name: "pronunciation-assessment-mcp", version: packageVersion() })}\n`);
      return 0;
    }
    if (!args.audioPath || args.referenceText === undefined) {
      throw new AssessmentError("INVALID_INPUT", "Both --audio and --reference are required.");
    }
    return await executeAssessment({
      input: {
        audioPath: args.audioPath,
        referenceText: args.referenceText,
        locale: args.locale,
        phonemeAlphabet: args.phonemeAlphabet,
        enableProsody: args.enableProsody,
        timeoutMs: args.timeoutMs,
        provider: args.provider,
      },
      env,
      stdout,
      stderr,
    });
  } catch (error) {
    const body = toErrorBody(error, Boolean(env.PA_SYNTHETIC_RESPONSE_FILE?.trim()));
    writeResult(stdout, body, secrets);
    diagnostic(stderr, body.error.message, secrets);
    if (!argsWereHelp(argv)) {
      stderr.write(USAGE);
    }
    return error instanceof AssessmentError ? error.exitCode : 1;
  }
}

function argsWereHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const parsed: CliArgs = { help: false, version: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version") {
      parsed.version = true;
      continue;
    }
    if (arg === "--no-prosody") {
      if (parsed.enableProsody === false) {
        throw new AssessmentError("INVALID_INPUT", "Duplicate --no-prosody.");
      }
      parsed.enableProsody = false;
      continue;
    }
    if (arg === "--audio") {
      parsed.audioPath = assignOnce(parsed.audioPath, readValue(args, index, arg), "--audio");
      index += 1;
      continue;
    }
    if (arg === "--reference") {
      parsed.referenceText = assignOnce(parsed.referenceText, readValue(args, index, arg), "--reference");
      index += 1;
      continue;
    }
    if (arg === "--locale") {
      parsed.locale = assignOnce(parsed.locale, readValue(args, index, arg), "--locale");
      index += 1;
      continue;
    }
    if (arg === "--phoneme-alphabet") {
      const value = readValue(args, index, arg);
      if (value !== "IPA" && value !== "SAPI") {
        throw new AssessmentError("INVALID_INPUT", "Phoneme alphabet must be IPA or SAPI.");
      }
      parsed.phonemeAlphabet = assignOnce(parsed.phonemeAlphabet, value, "--phoneme-alphabet");
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const value = readValue(args, index, arg);
      if (value !== "azure" && value !== "speechace") {
        throw new AssessmentError("INVALID_INPUT", "Provider must be azure or speechace.");
      }
      parsed.provider = assignOnce(parsed.provider, value, "--provider");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = readValue(args, index, arg);
      if (!/^-?\d+$/.test(value)) {
        throw new AssessmentError("INVALID_INPUT", "--timeout-ms must be an integer.");
      }
      parsed.timeoutMs = assignOnce(parsed.timeoutMs, Number(value), "--timeout-ms");
      index += 1;
      continue;
    }
    throw new AssessmentError("INVALID_INPUT", `Unknown argument ${arg}.`);
  }
  return parsed;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AssessmentError("INVALID_INPUT", `Missing value for ${flag}.`);
  }
  return value;
}

function assignOnce<T>(current: T | undefined, next: T, flag: string): T {
  if (current !== undefined) {
    throw new AssessmentError("INVALID_INPUT", `Duplicate ${flag}.`);
  }
  return next;
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
  runCli(process.argv, process.env, process.stdout, process.stderr)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
