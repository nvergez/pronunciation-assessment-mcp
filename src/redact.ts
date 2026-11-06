const KEY_QUERY = /(?:Ocp-Apim-Subscription-Key|subscription[-_]?key)=([^&\s"]+)/gi;

export function redactText(input: string, secrets: readonly string[]): string {
  let text = input;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      text = text.split(secret).join("[redacted]");
    }
  }
  text = text.replace(KEY_QUERY, (match) => match.slice(0, match.indexOf("=") + 1) + "[redacted]");
  text = text.replace(/(?:https?|wss?):\/\/[^\s"]+/gi, (url) => stripUrlSecrets(url));
  return text;
}

function stripUrlSecrets(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password && !parsed.search) {
      return url;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname}?[redacted]`;
  } catch {
    return "[redacted-url]";
  }
}

export function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redactUnknown(nested, secrets);
    }
    return output;
  }
  return value;
}

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const key = env.SPEECH_KEY?.trim() ?? "";
  return key.length >= 8 ? [key] : [];
}
