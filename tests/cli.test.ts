import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HELLO_RESULT, TEST_KEY, makePcmWav } from "./support.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("dist/cli.js");

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

test("CLI version, usage, remote paths, and synthetic success", async () => {
  const version = await run(["--version"], { PATH: process.env.PATH });
  assert.equal(version.code, 0);
  const versionBody = JSON.parse(version.stdout) as { version: string; name: string };
  assert.equal(versionBody.version, "0.1.0");
  assert.equal(versionBody.name, "pronunciation-assessment-mcp");

  const missing = await run([], { PATH: process.env.PATH });
  assert.equal(missing.code, 1);
  const missingBody = JSON.parse(missing.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.error.code, "INVALID_INPUT");
  assert.match(missing.stderr, /--audio/);

  const remote = await run(
    ["--audio", "https://example.com/a.wav", "--reference", "hello"],
    { PATH: process.env.PATH, SPEECH_KEY: TEST_KEY, SPEECH_REGION: "westus" },
  );
  assert.equal(remote.code, 1);
  assert.equal(JSON.parse(remote.stdout).error.code, "INVALID_AUDIO");
  assert.equal(remote.stdout.includes(TEST_KEY), false);
  assert.equal(remote.stderr.includes(TEST_KEY), false);

  const directory = await mkdtemp(path.join(tmpdir(), "pa-cli-"));
  try {
    const audioPath = path.join(directory, "clip.wav");
    const fixturePath = path.join(directory, "fixture.json");
    await writeFile(audioPath, makePcmWav(8_000));
    await writeFile(
      fixturePath,
      JSON.stringify({ mode: "error", message: `provider blew up ${TEST_KEY}` }),
    );
    const failed = await run(["--audio", audioPath, "--reference", "hello", "--timeout-ms", "5000"], {
      PATH: process.env.PATH,
      SPEECH_KEY: TEST_KEY,
      SPEECH_REGION: "westus",
      PA_SYNTHETIC_RESPONSE_FILE: fixturePath,
    });
    assert.equal(failed.code, 3);
    const body = JSON.parse(failed.stdout) as { ok: boolean; synthetic: boolean; error: { message: string } };
    assert.equal(body.ok, false);
    assert.equal(body.synthetic, true);
    assert.equal(body.error.message.includes(TEST_KEY), false);
    assert.match(body.error.message, /\[redacted\]/);
    assert.equal(failed.stderr.includes(TEST_KEY), false);

    await writeFile(fixturePath, JSON.stringify({ mode: "success", jsonResult: HELLO_RESULT }));
    const success = await run(
      ["--audio", audioPath, "--reference", "hello", "--no-prosody", "--timeout-ms", "5000"],
      {
        PATH: process.env.PATH,
        SPEECH_KEY: TEST_KEY,
        SPEECH_REGION: "westus",
        SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
        PA_SYNTHETIC_RESPONSE_FILE: fixturePath,
      },
    );
    assert.equal(success.code, 0, success.stderr);
    const assessed = JSON.parse(success.stdout) as {
      synthetic: boolean;
      request: { enableProsodyAssessment: boolean };
      provider: { azureCalled: boolean; connection: string; endpointHost: string | null };
      assessment: { words: Array<{ phonemes: Array<{ phoneme: string }> }> };
    };
    assert.equal(assessed.synthetic, true);
    assert.equal(assessed.provider.azureCalled, false);
    assert.equal(assessed.provider.connection, "subscription");
    assert.equal(assessed.provider.endpointHost, null);
    assert.equal(assessed.request.enableProsodyAssessment, false);
    assert.equal(assessed.assessment.words[0]?.phonemes[0]?.phoneme, "ɛ");
    assert.equal(success.stdout.includes(TEST_KEY), false);
    assert.match(success.stderr, /Azure Speech was not called/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
