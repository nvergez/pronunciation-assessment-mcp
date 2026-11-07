import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assessPronunciation } from "../src/assess.js";
import { AssessmentError } from "../src/errors.js";
import { redactText } from "../src/redact.js";
import { mapSpeechaceAssessment, requestSpeechaceScore, resolveSpeechaceDialect } from "../src/speechace.js";
import { unusedSpeechBackend } from "../src/speechace.js";
import type { SuccessBody } from "../src/types.js";
import { HELLO_RESULT, makePcmWav, memoryWriter } from "./support.js";

const execFileAsync = promisify(execFile);
const KEY = "speechace-canary-key";
const cli = path.resolve("dist/cli.js");
const mcp = path.resolve("dist/mcp.js");
const scoreTextFixture = fileURLToPath(new URL("./fixtures/speechace-score-text.json", import.meta.url));
const heardFixture = fileURLToPath(new URL("./fixtures/speechace-heard-phone.json", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cli, ...args], {
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

test("maps a published Speechace score-text excerpt without calling Speechace", async () => {
  const payload = JSON.parse(await readFile(scoreTextFixture, "utf8")) as unknown;
  const mapped = mapSpeechaceAssessment(payload, "IPA");
  assert.equal(mapped.recognitionStatus, "success");
  assert.equal(
    mapped.displayText,
    "Some parents admire famous athletes as strong role models, so they name their children after them.",
  );
  assert.equal(mapped.lexicalText, null);
  assert.equal(mapped.confidence, null);
  assert.equal(mapped.signalToNoiseRatio, null);
  assert.equal(mapped.scores.pronunciation, 99);
  assert.equal(mapped.scores.accuracy, 99);
  assert.equal(mapped.scores.fluency, null);
  assert.equal(mapped.scores.completeness, null);
  assert.equal(mapped.scores.prosody, null);
  assert.equal(JSON.stringify(mapped).includes("quota_remaining"), false);

  const some = mapped.words?.[0];
  assert.equal(some?.word, "Some");
  assert.equal(some?.accuracy, 99);
  assert.equal(some?.errorType, null);
  assert.equal(some?.offsetMs, 90);
  assert.equal(some?.durationMs, 330);
  assert.equal(some?.syllables?.[0]?.syllable, "some");
  assert.equal(some?.syllables?.[0]?.accuracy, 99);
  assert.equal(some?.phonemes?.[0]?.phoneme, "s");
  assert.equal(some?.phonemes?.[0]?.accuracy, 99);
  assert.deepEqual(some?.phonemes?.[0]?.nBestPhonemes, [{ phoneme: "s", score: null }]);
  assert.equal(some?.phonemes?.[0]?.offsetMs, 90);
  assert.equal(some?.phonemes?.[0]?.durationMs, 180);
  assert.equal(some?.phonemes?.[1]?.phoneme, "ʌ");
  assert.deepEqual(some?.phonemes?.[1]?.nBestPhonemes, [{ phoneme: "ʌ", score: null }]);
  assert.equal(some?.phonemes?.[2]?.phoneme, "m");
  assert.equal(some?.phonemes?.[2]?.accuracy, 100);

  const strong = mapped.words?.[1];
  assert.equal(strong?.phonemes?.[2]?.phoneme, "ɹ");
  assert.equal(strong?.phonemes?.[3]?.phoneme, "ɔ");
  assert.equal(strong?.phonemes?.[3]?.accuracy, 99);
  assert.equal(strong?.phonemes?.[4]?.phoneme, "ŋ");
});

test("maps sound_most_like as the heard phone and keeps SAPI symbols when asked", async () => {
  const payload = JSON.parse(await readFile(heardFixture, "utf8")) as unknown;
  const ipa = mapSpeechaceAssessment(payload, "IPA");
  const phone = ipa.words?.[0]?.phonemes?.[0];
  assert.equal(ipa.words?.[0]?.word, "this");
  assert.equal(ipa.words?.[0]?.accuracy, 90);
  assert.equal(phone?.phoneme, "ð");
  assert.equal(phone?.accuracy, 78);
  assert.deepEqual(phone?.nBestPhonemes, [{ phoneme: "l", score: null }]);
  assert.equal(phone?.offsetMs, 8_040);
  assert.equal(phone?.durationMs, 90);
  assert.equal(phone?.offsetTicks, 80_400_000);
  assert.equal(ipa.words?.[0]?.phonemes?.[1]?.phoneme, "ɪ");
  assert.equal(ipa.scores.pronunciation, null);
  assert.equal(ipa.scores.fluency, null);

  const sapi = mapSpeechaceAssessment(payload, "SAPI");
  assert.equal(sapi.words?.[0]?.phonemes?.[0]?.phoneme, "dh");
  assert.deepEqual(sapi.words?.[0]?.phonemes?.[0]?.nBestPhonemes, [{ phoneme: "l", score: null }]);
});

test("Speechace error status stays a recognition failure and does not require a live call", async () => {
  assert.throws(
    () =>
      mapSpeechaceAssessment(
        {
          status: "error",
          short_message: "error_no_speech",
          detail_message: `no voice ${KEY}`,
        },
        "IPA",
      ),
    (error: unknown) =>
      error instanceof AssessmentError &&
      error.code === "RECOGNITION_FAILED" &&
      error.message === "Speechace scoring failed (error_no_speech).",
  );
  assert.deepEqual(resolveSpeechaceDialect(undefined), { locale: "en-US", dialect: "en-us" });
  assert.equal(resolveSpeechaceDialect("en-GB").dialect, "en-gb");

  const directory = await mkdtemp(path.join(tmpdir(), "pa-speechace-guard-"));
  const audioPath = path.join(directory, "clip.wav");
  await writeFile(audioPath, makePcmWav(160));
  try {
    await assert.rejects(
      () =>
        assessPronunciation(
          { audioPath, referenceText: "hello", provider: "speechace", timeoutMs: 5_000 },
          { env: {}, stderr: memoryWriter().stream, mode: "speechace", backend: unusedSpeechBackend() },
        ),
      (error: unknown) => error instanceof AssessmentError && error.code === "MISSING_CREDENTIALS",
    );
    await assert.rejects(
      () =>
        assessPronunciation(
          { audioPath, referenceText: "a".repeat(1_501), provider: "speechace", timeoutMs: 5_000 },
          {
            env: { SPEECHACE_API_KEY: KEY },
            stderr: memoryWriter().stream,
            mode: "speechace",
            backend: unusedSpeechBackend(),
          },
        ),
      (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_REFERENCE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("redacts a Speechace key query the same way as an Azure subscription query", () => {
  const redacted = redactText(
    `POST https://api.speechace.co/api/scoring/text/v9/json?key=${KEY}&dialect=en-us failed`,
    [KEY],
  );
  assert.equal(redacted.includes(KEY), false);
  assert.match(redacted, /api\.speechace\.co/);
  assert.match(redacted, /\[redacted\]/);
  assert.doesNotMatch(redacted, /[?&]key=[^[\s]/);
});

test("posts text scoring with dialect en-us and strips the key from failures", async () => {
  const audio = makePcmWav(1_600);
  const payload = JSON.parse(await readFile(scoreTextFixture, "utf8")) as unknown;
  let seenUrl = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = input instanceof URL ? input.toString() : String(input);
    const form = init?.body;
    assert.equal(init?.method, "POST");
    assert.ok(form instanceof FormData);
    assert.equal(form.get("text"), "hello");
    assert.equal(form.get("user_id"), null);
    const file = form.get("user_audio_file");
    assert.ok(file instanceof File);
    assert.equal(file.name, "audio.wav");
    assert.equal(file.type, "audio/wav");
    assert.equal(file.size, audio.length);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  const directory = await mkdtemp(path.join(tmpdir(), "pa-speechace-"));
  const audioPath = path.join(directory, "clip.wav");
  await writeFile(audioPath, audio);
  try {
    const stderr = memoryWriter();
    const body = await assessPronunciation(
      { audioPath, referenceText: "hello", provider: "speechace", timeoutMs: 5_000 },
      {
        env: { SPEECHACE_API_KEY: KEY },
        stderr: stderr.stream,
        mode: "speechace",
        backend: unusedSpeechBackend(),
        fetchImpl,
      },
    );
    const url = new URL(seenUrl);
    assert.equal(url.origin, "https://api.speechace.co");
    assert.equal(url.pathname, "/api/scoring/text/v9/json");
    assert.equal(url.searchParams.get("dialect"), "en-us");
    assert.equal(url.searchParams.get("key"), KEY);
    assert.equal(body.synthetic, false);
    assert.equal(body.provider.name, "speechace");
    assert.equal(body.provider.scoring, "speechace");
    assert.equal(body.provider.speechaceCalled, true);
    assert.equal(body.provider.azureCalled, false);
    assert.equal(body.provider.endpointHost, "api.speechace.co");
    assert.equal(body.provider.dialect, "en-us");
    assert.equal(body.request.dimension, null);
    assert.equal(body.request.enableMiscue, false);
    assert.equal(body.request.enableProsodyAssessment, false);
    assert.equal(stderr.text().includes(KEY), false);
    assert.doesNotMatch(stderr.text(), /https?:\/\//);
    assert.equal(JSON.stringify(body).includes(KEY), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await assert.rejects(
    () =>
      requestSpeechaceScore({
        key: KEY,
        dialect: "en-us",
        referenceText: "hello",
        audio,
        signal: new AbortController().signal,
        secrets: [KEY],
        fetchImpl: async () => {
          throw new Error(`connect https://api.speechace.co/api/scoring/text/v9/json?key=${KEY}&dialect=en-us`);
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentError);
      assert.equal(error.code, "PROVIDER_CONNECTION");
      assert.equal(JSON.stringify(error.details).includes(KEY), false);
      return true;
    },
  );

  await assert.rejects(
    () =>
      requestSpeechaceScore({
        key: KEY,
        dialect: "en-gb",
        referenceText: "hello",
        audio,
        signal: new AbortController().signal,
        secrets: [KEY],
        fetchImpl: async () => new Response(`denied ${KEY}`, { status: 401 }),
      }),
    (error: unknown) =>
      error instanceof AssessmentError &&
      error.code === "PROVIDER_AUTH" &&
      !JSON.stringify(error.details).includes(KEY),
  );
});

test("CLI and MCP speechace fixture mode redacts the key and stays on Azure by default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pa-speechace-cli-"));
  const audioPath = path.join(directory, "clip.wav");
  const secretFixture = path.join(directory, "secret.json");
  const azureFixture = path.join(directory, "azure.json");
  await writeFile(audioPath, makePcmWav(1_600));
  const leaked = JSON.parse(await readFile(scoreTextFixture, "utf8")) as {
    text_score: { text: string };
  };
  leaked.text_score.text = `said ${KEY} aloud`;
  await writeFile(secretFixture, JSON.stringify(leaked));
  await writeFile(azureFixture, JSON.stringify({ mode: "success", jsonResult: HELLO_RESULT }));
  const env = {
    PATH: process.env.PATH,
    SPEECHACE_API_KEY: KEY,
    PA_SPEECHACE_RESPONSE_FILE: secretFixture,
  };
  try {
    const defaultAzure = await run(
      ["--audio", audioPath, "--reference", "hello", "--timeout-ms", "5000"],
      {
        ...env,
        SPEECH_KEY: "azure-key",
        SPEECH_REGION: "westus",
        PA_SYNTHETIC_RESPONSE_FILE: azureFixture,
      },
    );
    assert.equal(defaultAzure.code, 0, defaultAzure.stderr);
    const azureBody = JSON.parse(defaultAzure.stdout) as SuccessBody;
    assert.equal(azureBody.provider.scoring, "azure");
    assert.equal(azureBody.provider.speechaceCalled, false);
    assert.equal(azureBody.assessment.words?.[0]?.phonemes?.[0]?.phoneme, "ɛ");
    assert.equal(defaultAzure.stdout.includes(KEY), false);

    const success = await run(
      ["--provider", "speechace", "--audio", audioPath, "--reference", "hello", "--timeout-ms", "5000"],
      env,
    );
    assert.equal(success.code, 0, success.stderr);
    assert.equal(success.stdout.includes(KEY), false);
    assert.equal(success.stderr.includes(KEY), false);
    const body = JSON.parse(success.stdout) as SuccessBody;
    assert.equal(body.ok, true);
    assert.equal(body.synthetic, true);
    assert.equal(body.provider.scoring, "speechace");
    assert.equal(body.provider.speechaceCalled, false);
    assert.equal(body.provider.azureCalled, false);
    assert.equal(body.assessment.displayText, "said [redacted] aloud");
    assert.equal(body.assessment.words?.[0]?.phonemes?.[1]?.phoneme, "ʌ");
    assert.equal(body.request.locale, "en-US");
    assert.equal(body.provider.dialect, "en-us");

    const british = await run(
      ["--provider", "speechace", "--locale", "en-GB", "--audio", audioPath, "--reference", "hello", "--timeout-ms", "5000"],
      { ...env, PA_SPEECHACE_RESPONSE_FILE: heardFixture },
    );
    assert.equal(british.code, 0, british.stderr);
    const gb = JSON.parse(british.stdout) as SuccessBody;
    assert.equal(gb.request.locale, "en-GB");
    assert.equal(gb.provider.dialect, "en-gb");
    assert.equal(gb.assessment.words?.[0]?.phonemes?.[0]?.nBestPhonemes?.[0]?.phoneme, "l");

    const rejected = await run(
      ["--provider", "speechace", "--locale", "fr-FR", "--audio", audioPath, "--reference", "bonjour", "--timeout-ms", "5000"],
      env,
    );
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.stdout).error.code, "INVALID_LOCALE");
    assert.equal(rejected.stdout.includes(KEY), false);

    const stderrChunks: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcp],
      cwd: path.resolve("."),
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        SPEECHACE_API_KEY: KEY,
        PA_SPEECHACE_RESPONSE_FILE: heardFixture,
      },
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    const client = new Client({ name: "speechace-fixture-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "assess_pronunciation",
        arguments: { audioPath, referenceText: "this", provider: "speechace", phonemeAlphabet: "SAPI" },
      });
      assert.notEqual(result.isError, true);
      const text = textOf(result.content);
      assert.equal(text.includes(KEY), false);
      const mcpBody = JSON.parse(text) as SuccessBody;
      assert.equal(mcpBody.provider.scoring, "speechace");
      assert.equal(mcpBody.provider.speechaceCalled, false);
      assert.equal(mcpBody.assessment.words?.[0]?.phonemes?.[0]?.phoneme, "dh");
      assert.deepEqual(mcpBody.assessment.words?.[0]?.phonemes?.[0]?.nBestPhonemes, [{ phoneme: "l", score: null }]);
      assert.equal(Buffer.concat(stderrChunks).toString("utf8").includes(KEY), false);
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
