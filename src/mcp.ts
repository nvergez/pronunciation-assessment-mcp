#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assessWithEnv, fixtureEnabled, selectedProvider } from "./execute.js";
import { diagnostic } from "./log.js";
import { stringifyResult } from "./json.js";
import { toErrorBody } from "./output.js";
import { redactUnknown, secretsFromEnv } from "./redact.js";
import { packageVersion } from "./version.js";

const TOOL_DESCRIPTION = [
  "Assess pronunciation of a local WAV recording against known reference text.",
  "The default provider is Azure Speech Pronunciation Assessment. Set provider to speechace to score with the Speechace text API instead.",
  "Sends the audio and reference text to the selected provider.",
  "Returns word and phoneme scores in one shape. For Azure, nBestPhonemes are service hypotheses when present.",
  "For Speechace, phoneme accuracy is quality_score and nBestPhonemes is sound_most_like, the heard phone, with a null score.",
  "Does not invent a spoken phoneme or a correction.",
  "Default locale is en-US. Speechace dialect defaults to en-us and also accepts en-GB. Accepts only a local filesystem path, not a URL.",
  "Scores are model scores from 0 to 100. They are not an absolute pronunciation measure and they are not a human rating.",
  "Azure requires SPEECH_KEY and SPEECH_REGION. Speechace requires SPEECHACE_API_KEY. Keys are never returned.",
].join(" ");

export function createPronunciationServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer(
    { name: "pronunciation-assessment-mcp", version: packageVersion() },
    {
      instructions: TOOL_DESCRIPTION,
    },
  );
  server.registerTool(
    "assess_pronunciation",
    {
      title: "Assess pronunciation",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        audioPath: z.string().min(1).describe("Local filesystem path to a WAV PCM file. URLs are rejected."),
        referenceText: z.string().min(1).describe("Known reference text for scripted assessment."),
        provider: z.enum(["azure", "speechace"]).optional().describe("Scoring provider. Default azure. speechace uses SPEECHACE_API_KEY and dialect en-us."),
        locale: z.string().min(1).optional().describe("BCP-47 locale. Default en-US. Speechace accepts en-US (en-us) and en-GB (en-gb)."),
        phonemeAlphabet: z.enum(["IPA", "SAPI"]).optional().describe("Default IPA for en-US and SAPI for zh-CN."),
        enableProsody: z.boolean().optional().describe("Request prosody. Supported for en-US only. Defaults to true for en-US."),
        timeoutMs: z.number().int().optional().describe("Local timeout in milliseconds."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const secrets = secretsFromEnv(env);
      const provider = selectedProvider({ provider: args.provider });
      const synthetic = fixtureEnabled(env, provider);
      try {
        const body = await assessWithEnv(
          {
            audioPath: args.audioPath,
            referenceText: args.referenceText,
            locale: args.locale,
            phonemeAlphabet: args.phonemeAlphabet,
            enableProsody: args.enableProsody,
            timeoutMs: args.timeoutMs,
            provider,
          },
          env,
          process.stderr,
        );
        return { content: [{ type: "text", text: stringifyResult(redactUnknown(body, secrets)) }] };
      } catch (error) {
        const body = toErrorBody(error, synthetic);
        diagnostic(process.stderr, body.error.message, secrets);
        return {
          isError: true,
          content: [{ type: "text", text: stringifyResult(redactUnknown(body, secrets)) }],
        };
      }
    },
  );
  return server;
}

async function start(): Promise<void> {
  const server = createPronunciationServer(process.env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
  start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "MCP server failed to start.";
    diagnostic(process.stderr, message, secretsFromEnv(process.env));
    process.exitCode = 1;
  });
}
