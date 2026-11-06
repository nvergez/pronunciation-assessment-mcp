import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HELLO_RESULT, TEST_KEY, makePcmWav } from "./support.js";

test("MCP stdio client lists and calls assess_pronunciation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pa-mcp-"));
  const audioPath = path.join(directory, "clip.wav");
  const fixturePath = path.join(directory, "fixture.json");
  await writeFile(audioPath, makePcmWav(4_000));
  await writeFile(fixturePath, JSON.stringify({ mode: "success", jsonResult: HELLO_RESULT }));
  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.js")],
    cwd: path.resolve("."),
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      SPEECH_KEY: TEST_KEY,
      SPEECH_REGION: "westus",
      SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
      PA_SYNTHETIC_RESPONSE_FILE: fixturePath,
    },
  });
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  }
  const client = new Client({ name: "pronunciation-assessment-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "assess_pronunciation"));

    const success = await client.callTool({
      name: "assess_pronunciation",
      arguments: { audioPath, referenceText: "hello" },
    });
    assert.notEqual(success.isError, true);
    const successText = textOf(success.content);
    const body = JSON.parse(successText) as {
      ok: boolean;
      synthetic: boolean;
      provider: { azureCalled: boolean };
      assessment: { scores: { prosody: number | null } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.synthetic, true);
    assert.equal(body.provider.azureCalled, false);
    assert.equal(body.assessment.scores.prosody, null);
    assert.equal(successText.includes(TEST_KEY), false);

    const invalid = await client.callTool({
      name: "assess_pronunciation",
      arguments: { audioPath: "https://example.com/a.wav", referenceText: "hello" },
    });
    assert.equal(invalid.isError, true);
    const errorBody = JSON.parse(textOf(invalid.content)) as { ok: boolean; error: { code: string } };
    assert.equal(errorBody.ok, false);
    assert.equal(errorBody.error.code, "INVALID_AUDIO");

    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    assert.equal(stderrText.includes(TEST_KEY), false);
    assert.match(stderrText, /Azure Speech was not called/);
  } finally {
    await client.close();
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
