const MARKER = "[redacted]";
const KEY_QUERY = /(?:Ocp-Apim-Subscription-Key|subscription[-_]?key|(?:^|[?&])key)=([^&\s"]+)/gi;

export function redactText(input: string, secrets: readonly string[]): string {
  const active = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  let text = input
    .split(MARKER)
    .map((part) => replaceSecrets(part, active))
    .join(MARKER);
  text = text.replace(KEY_QUERY, (match) => match.slice(0, match.indexOf("=") + 1) + MARKER);
  text = text.replace(/(?:https?|wss?):\/\/[^\s"]+/gi, (url) => stripUrlSecrets(url));
  return text;
}

function replaceSecrets(part: string, secrets: readonly string[]): string {
  if (secrets.length === 0) {
    return part;
  }
  let sentinel = "\uE000";
  while (part.includes(sentinel) || secrets.some((secret) => secret.includes(sentinel))) {
    sentinel += "\uE000";
  }
  let text = part;
  for (const secret of secrets) {
    text = text.split(secret).join(sentinel);
  }
  return text.split(sentinel).join(MARKER);
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
    if (!isPlainObject(value)) {
      return value;
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[redactText(key, secrets)] = redactUnknown(nested, secrets);
    }
    return output;
  }
  return value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const secrets = [env.SPEECH_KEY, env.SPEECHACE_API_KEY]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  return [...new Set(secrets)];
}
