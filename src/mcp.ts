#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assessWithEnv } from "./execute.js";
import { diagnostic } from "./log.js";
import { stringifyResult } from "./json.js";
import { toErrorBody } from "./output.js";
import { redactUnknown, secretsFromEnv } from "./redact.js";
import { packageVersion } from "./version.js";

const TOOL_DESCRIPTION = [
  "Assess pronunciation of a local WAV recording against known reference text using Azure Speech Pronunciation Assessment.",
  "Sends the audio and reference text to the configured Azure Speech resource.",
  "Returns word and phoneme accuracy, timing, and fluency, completeness, and prosody scores when Azure returns them.",
  "Does not invent a spoken phoneme or a correction. nBestPhonemes are Azure hypotheses when present.",
  "Default locale is en-US. Accepts only a local filesystem path, not a URL.",
  "Scores are HundredMark model scores from 0 to 100. They are not an absolute pronunciation measure and they are not a human rating.",
  "Requires SPEECH_KEY and SPEECH_REGION in the server environment. The key is never returned.",
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
        locale: z.string().min(1).optional().describe("BCP-47 pronunciation-assessment locale. Default en-US."),
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
      const synthetic = Boolean(env.PA_SYNTHETIC_RESPONSE_FILE?.trim());
      try {
        const body = await assessWithEnv(
          {
            audioPath: args.audioPath,
            referenceText: args.referenceText,
            locale: args.locale,
            phonemeAlphabet: args.phonemeAlphabet,
            enableProsody: args.enableProsody,
            timeoutMs: args.timeoutMs,
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
