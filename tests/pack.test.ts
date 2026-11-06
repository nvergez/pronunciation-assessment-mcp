import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("pack:tarball creates a missing destination before npm pack writes the tarball", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts: { "pack:tarball": string };
  };
  const script = pkg.scripts["pack:tarball"];
  const buildPrefix = "npm run build && ";
  assert.equal(script.startsWith(buildPrefix), true);
  const parent = mkdtempSync(path.join(tmpdir(), "pa-pack-"));
  const destination = path.join(parent, "artifacts");
  const command = script.slice(buildPrefix.length).replaceAll("./artifacts", shellQuote(destination));
  try {
    execFileSync("sh", ["-c", command], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packed = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
    assert.deepEqual(packed, ["pronunciation-assessment-mcp-0.1.0.tgz"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
