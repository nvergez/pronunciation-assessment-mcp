import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TEST_KEY } from "./support.js";

const execFileAsync = promisify(execFile);
const smoke = path.resolve("dist/smoke.js");

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [smoke, ...args], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: unknown) => {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      if (typeof failed.code === "number") {
        return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
      throw error;
    },
  );
}

test("live smoke refuses missing credentials and fixture mode without calling Azure", async () => {
  const missing = await run([], {
    PATH: process.env.PATH,
    SPEECH_REGION: "westus",
    SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
  });
  assert.equal(missing.code, 2);
  const missingBody = JSON.parse(missing.stdout) as {
    ok: boolean;
    error: { code: string };
    integrationSmoke: { speaker: string; referenceText: string; label: string };
  };
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.error.code, "MISSING_CREDENTIALS");
  assert.equal(missingBody.integrationSmoke.speaker, "microsoft-official-sample");
  assert.equal(missingBody.integrationSmoke.label, "integration-smoke");
  assert.equal(missingBody.integrationSmoke.referenceText, "what's the weather like");
  assert.equal(missing.stderr.includes("will be sent"), false);
  assert.doesNotMatch(missing.stdout, /test-key/);

  const fixture = await run([], {
    PATH: process.env.PATH,
    SPEECH_KEY: TEST_KEY,
    SPEECH_REGION: "westus",
    PA_SYNTHETIC_RESPONSE_FILE: "/tmp/not-used.json",
  });
  assert.equal(fixture.code, 2);
  assert.equal(JSON.parse(fixture.stdout).error.code, "INVALID_CONFIG");
  assert.match(fixture.stdout, /would not call Azure/);

  const otherAudio = await run(["--audio", "/tmp/user.wav"], {
    PATH: process.env.PATH,
    SPEECH_KEY: TEST_KEY,
    SPEECH_REGION: "westus",
  });
  assert.equal(otherAudio.code, 1);
  assert.match(otherAudio.stdout, /bundled Microsoft sample/);
});
