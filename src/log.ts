import type { Writable } from "node:stream";
import { redactText } from "./redact.js";

export function diagnostic(stderr: Writable, message: string, secrets: readonly string[] = []): void {
  stderr.write(`pronunciation-assessment: ${redactText(message, secrets)}\n`);
}
