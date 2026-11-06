import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mapAzureAssessment } from "../src/map-result.js";
import { makePcmWav } from "./support.js";

const execFileAsync = promisify(execFile);
const KEY = "Canary88";
const SHORT_KEY = "k7canry";
const cli = path.resolve("dist/cli.js");
const smoke = path.resolve("dist/smoke.js");
const mcp = path.resolve("dist/mcp.js");

function runBin(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: unknown) => {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      if (typeof failed.code === "number" && failed.stdout !== undefined) {
        return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
      throw error;
    },
  );
}

function fixture(secret: string): unknown {
  return {
    RecognitionStatus: "Success",
    DisplayText: `said ${secret} aloud`,
    NBest: [
      {
        Confidence: 0.5,
        Lexical: "hello",
        Display: `said ${secret} aloud`,
        PronunciationAssessment: {
          AccuracyScore: 91,
          FluencyScore: 82,
          CompletenessScore: 73,
          PronScore: 64,
        },
        Words: [
          {
            Word: "hello",
            AccuracyScore: 91,
            ErrorType: "None",
            Feedback: {
              Prosody: {
                Break: {
                  Error: secret,
                  Unrelated: 12,
                  Missing: null,
                },
              },
            },
          },
        ],
      },
    ],
  };
}

async function writeCase(secret: string): Promise<{ directory: string; audioPath: string; fixturePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "pa-secret-"));
  const audioPath = path.join(directory, secret);
  const fixturePath = path.join(directory, "fixture.json");
  await writeFile(audioPath, makePcmWav(1_600));
  await writeFile(fixturePath, JSON.stringify({ mode: "success", jsonResult: fixture(secret) }));
  return { directory, audioPath, fixturePath };
}

test("mapped assessment keeps provider text while CLI and MCP output hide the key", async () => {
  assert.equal(KEY.length, 8);
  const mapped = mapAzureAssessment(fixture(KEY), null);
  assert.equal(mapped.displayText, `said ${KEY} aloud`);
  assert.equal(mapped.scores.accuracy, 91);
  assert.equal(mapped.scores.prosody, null);
  assert.equal(mapped.words?.[0]?.feedback && typeof mapped.words[0].feedback === "object"
    ? (mapped.words[0].feedback as { Prosody: { Break: { Error: string } } }).Prosody.Break.Error
    : null, KEY);

  const { directory, audioPath, fixturePath } = await writeCase(KEY);
  try {
    const cliResult = await runBin(
      cli,
      ["--audio", audioPath, "--reference", "hello", "--no-prosody", "--timeout-ms", "5000"],
      {
        PATH: process.env.PATH,
        SPEECH_KEY: KEY,
        SPEECH_REGION: "westus",
        PA_SYNTHETIC_RESPONSE_FILE: fixturePath,
      },
    );
    assert.equal(cliResult.code, 0);
    assert.equal(cliResult.stdout.includes(KEY), false);
    assert.equal(cliResult.stderr.includes(KEY), false);
    const body = JSON.parse(cliResult.stdout) as {
      ok: boolean;
      synthetic: boolean;
      audio: { fileName: string };
      assessment: {
        displayText: string;
        scores: { accuracy: number; fluency: number; completeness: number; prosody: number | null; pronunciation: number };
        words: Array<{ feedback: { Prosody: { Break: { Error: string; Unrelated: number; Missing: null } } } }>;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.synthetic, true);
    assert.equal(body.audio.fileName, "[redacted]");
    assert.equal(body.assessment.displayText, "said [redacted] aloud");
    assert.equal(body.assessment.scores.accuracy, 91);
    assert.equal(body.assessment.scores.fluency, 82);
    assert.equal(body.assessment.scores.completeness, 73);
    assert.equal(body.assessment.scores.prosody, null);
    assert.equal(body.assessment.scores.pronunciation, 64);
    assert.equal(body.assessment.words[0]?.feedback.Prosody.Break.Error, "[redacted]");
    assert.equal(body.assessment.words[0]?.feedback.Prosody.Break.Unrelated, 12);
    assert.equal(body.assessment.words[0]?.feedback.Prosody.Break.Missing, null);

    const stderrChunks: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcp],
      cwd: path.resolve("."),
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        SPEECH_KEY: KEY,
        SPEECH_REGION: "westus",
        PA_SYNTHETIC_RESPONSE_FILE: fixturePath,
      },
    });
    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    }
    const client = new Client({ name: "secret-output-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "assess_pronunciation",
        arguments: { audioPath, referenceText: "hello", enableProsody: false },
      });
      const text = textOf(result.content);
      assert.equal(text.includes(KEY), false);
      assert.equal(Buffer.concat(stderrChunks).toString("utf8").includes(KEY), false);
      const mcpBody = JSON.parse(text) as typeof body;
      assert.equal(mcpBody.synthetic, true);
      assert.equal(mcpBody.audio.fileName, "[redacted]");
      assert.equal(mcpBody.assessment.displayText, "said [redacted] aloud");
      assert.equal(mcpBody.assessment.scores.accuracy, 91);
      assert.equal(mcpBody.assessment.scores.prosody, null);
      assert.equal(mcpBody.assessment.words[0]?.feedback.Prosody.Break.Error, "[redacted]");
      assert.equal(mcpBody.assessment.words[0]?.feedback.Prosody.Break.Unrelated, 12);
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("short speech keys are omitted from CLI and smoke stdout and stderr", async () => {
  assert.equal(SHORT_KEY.length, 7);
  const env = { PATH: process.env.PATH, SPEECH_KEY: SHORT_KEY, SPEECH_REGION: "westus" };
  const cliResult = await runBin(cli, [SHORT_KEY], env);
  assert.equal(cliResult.code, 1);
  assert.equal(cliResult.stdout.includes(SHORT_KEY), false);
  assert.equal(cliResult.stderr.includes(SHORT_KEY), false);
  const cliBody = JSON.parse(cliResult.stdout) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(cliBody.ok, false);
  assert.equal(cliBody.error.code, "INVALID_INPUT");
  assert.match(cliBody.error.message, /Unknown argument \[redacted\]/);

  const smokeResult = await runBin(smoke, [SHORT_KEY], env);
  assert.equal(smokeResult.stdout.includes(SHORT_KEY), false);
  assert.equal(smokeResult.stderr.includes(SHORT_KEY), false);
  const smokeBody = JSON.parse(smokeResult.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(smokeBody.ok, false);
  assert.equal(smokeBody.error.code, "INVALID_INPUT");
});

function textOf(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP result did not include content.");
  }
  const first = content[0] as { text?: unknown };
  if (typeof first.text !== "string") {
    throw new Error("MCP result content was not text.");
  }
  return first.text;
}
