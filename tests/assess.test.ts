import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessPronunciation } from "../src/assess.js";
import { createSyntheticBackend } from "../src/synthetic-backend.js";
import { AssessmentError } from "../src/errors.js";
import { HELLO_RESULT, TEST_KEY, collectKeys, makePcmWav, memoryWriter } from "./support.js";

async function withFixture(
  fixture: unknown,
  run: (paths: { audioPath: string; fixturePath: string; directory: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pa-assess-"));
  const audioPath = path.join(directory, "clip.wav");
  const fixturePath = path.join(directory, "fixture.json");
  await writeFile(audioPath, makePcmWav(16_000));
  await writeFile(fixturePath, JSON.stringify(fixture));
  try {
    await run({ audioPath, fixturePath, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SPEECH_KEY: TEST_KEY,
    SPEECH_REGION: "westus",
    SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
    ...extra,
  };
}

test("synthetic success preserves Azure fields and records that Azure was not called", async () => {
  await withFixture({ mode: "success", jsonResult: HELLO_RESULT, sessionId: "session-1" }, async ({ audioPath, fixturePath }) => {
    const stderr = memoryWriter();
    const body = await assessPronunciation(
      { audioPath, referenceText: "hello", timeoutMs: 5_000 },
      {
        env: env({ PA_SYNTHETIC_RESPONSE_FILE: fixturePath }),
        stderr: stderr.stream,
        mode: "synthetic",
        backend: createSyntheticBackend(fixturePath),
      },
    );
    assert.equal(body.ok, true);
    assert.equal(body.synthetic, true);
    assert.equal(body.provider.azureCalled, false);
    assert.equal(body.provider.name, "synthetic-fixture");
    assert.equal(body.provider.connection, "subscription");
    assert.equal(body.provider.endpointHost, null);
    assert.equal(body.provider.region, "westus");
    assert.equal(body.provider.sessionId, "session-1");
    assert.equal(body.assessment.words?.[0]?.phonemes?.[0]?.phoneme, "ɛ");
    assert.equal(body.request.phonemeAlphabet, "IPA");
    assert.equal(body.request.enableProsodyAssessment, true);
    assert.match(body.notes.join(" "), /not an absolute pronunciation measure/);
    assert.match(body.notes.join(" "), /does not select a spoken phoneme/);
    assert.match(body.notes.join(" "), /Azure Speech was not called/);
    assert.equal(collectKeys(body).includes("spokenPhoneme"), false);
    assert.equal(stderr.text().includes(TEST_KEY), false);
    assert.match(stderr.text(), /Azure Speech was not called/);
    assert.doesNotMatch(stderr.text(), /hello/);
  });
});

test("provider errors, auth failures, quota failures, and timeouts stay structured", async () => {
  await withFixture(
    { mode: "error", message: `upstream failed with ${TEST_KEY}` },
    async ({ audioPath, fixturePath }) => {
      await assert.rejects(
        () =>
          assessPronunciation(
            { audioPath, referenceText: "hello", timeoutMs: 5_000 },
            {
              env: env(),
              stderr: memoryWriter().stream,
              mode: "synthetic",
              backend: createSyntheticBackend(fixturePath),
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof AssessmentError);
          assert.equal(error.code, "PROVIDER_ERROR");
          assert.match(error.message, new RegExp(TEST_KEY));
          return true;
        },
      );
    },
  );

  await withFixture(
    { mode: "canceled", errorCode: "AuthenticationFailure", errorDetails: `bad ${TEST_KEY}` },
    async ({ audioPath, fixturePath }) => {
      await assert.rejects(
        () =>
          assessPronunciation(
            { audioPath, referenceText: "hello", timeoutMs: 5_000 },
            {
              env: env(),
              stderr: memoryWriter().stream,
              mode: "synthetic",
              backend: createSyntheticBackend(fixturePath),
            },
          ),
        (error: unknown) =>
          error instanceof AssessmentError &&
          error.code === "PROVIDER_AUTH" &&
          error.exitCode === 3,
      );
    },
  );

  await withFixture(
    { mode: "canceled", errorCode: "TooManyRequests", errorDetails: "throttle" },
    async ({ audioPath, fixturePath }) => {
      await assert.rejects(
        () =>
          assessPronunciation(
            { audioPath, referenceText: "hello", timeoutMs: 5_000 },
            {
              env: env(),
              stderr: memoryWriter().stream,
              mode: "synthetic",
              backend: createSyntheticBackend(fixturePath),
            },
          ),
        (error: unknown) =>
          error instanceof AssessmentError &&
          error.code === "PROVIDER_QUOTA" &&
          /does not change the pricing tier/.test(error.message),
      );
    },
  );

  await withFixture({ mode: "hang" }, async ({ audioPath, fixturePath }) => {
    await assert.rejects(
      () =>
        assessPronunciation(
          { audioPath, referenceText: "hello", timeoutMs: 80 },
          {
            env: env(),
            stderr: memoryWriter().stream,
            mode: "synthetic",
            backend: createSyntheticBackend(fixturePath),
          },
        ),
      (error: unknown) => error instanceof AssessmentError && error.code === "TIMEOUT" && error.exitCode === 4,
    );
  });
});

test("missing credentials and invalid audio fail before a backend result", async () => {
  await withFixture({ mode: "success", jsonResult: HELLO_RESULT }, async ({ audioPath, fixturePath }) => {
    await assert.rejects(
      () =>
        assessPronunciation(
          { audioPath, referenceText: "hello", timeoutMs: 1_000 },
          {
            env: { SPEECH_REGION: "westus" },
            stderr: memoryWriter().stream,
            mode: "azure",
            backend: createSyntheticBackend(fixturePath),
          },
        ),
      (error: unknown) => error instanceof AssessmentError && error.code === "MISSING_CREDENTIALS",
    );
    await assert.rejects(
      () =>
        assessPronunciation(
          { audioPath: "https://example.com/clip.wav", referenceText: "hello", timeoutMs: 1_000 },
          {
            env: env(),
            stderr: memoryWriter().stream,
            mode: "azure",
            backend: createSyntheticBackend(fixturePath),
          },
        ),
      (error: unknown) => error instanceof AssessmentError && error.code === "INVALID_AUDIO",
    );
  });
});
