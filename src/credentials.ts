import { AssessmentError } from "./errors.js";

export interface SpeechCredentials {
  key: string;
  region: string;
  endpoint: URL | null;
  connection: "subscription" | "endpoint";
  endpointHost: string | null;
}

export function loadCredentials(env: NodeJS.ProcessEnv): SpeechCredentials {
  const key = env.SPEECH_KEY?.trim() ?? "";
  const region = env.SPEECH_REGION?.trim() ?? "";
  const endpointRaw = env.SPEECH_ENDPOINT?.trim() ?? "";

  if (!key) {
    throw new AssessmentError(
      "MISSING_CREDENTIALS",
      "SPEECH_KEY is not set. The key is read from the environment only and is never printed.",
    );
  }
  if (!region) {
    throw new AssessmentError(
      "MISSING_CREDENTIALS",
      "SPEECH_REGION is not set. Set it to your Speech resource region.",
    );
  }
  if (!/^[a-zA-Z0-9]+$/.test(region)) {
    throw new AssessmentError(
      "INVALID_CONFIG",
      "SPEECH_REGION must be an Azure region name such as westus.",
    );
  }

  if (!endpointRaw) {
    return subscriptionCredentials(key, region);
  }

  const endpoint = parseEndpoint(endpointRaw, region);
  // The portal value https://{region}.api.cognitive.microsoft.com/ is the
  // resource API host (token and REST). Speech SDK 1.53 does not treat it as
  // the recognition websocket. fromEndpoint() appends /stt/speech/universal/v2
  // and, unless an unauthenticated redirect returns another host, opens that
  // portal host. The recognition route for a regional key is fromSubscription,
  // which uses wss://{region}.stt.speech.microsoft.com/stt/speech/universal/v2.
  if (isRegionalCognitiveApiHost(endpoint.hostname, region)) {
    return subscriptionCredentials(key, region);
  }
  return {
    key,
    region,
    endpoint,
    connection: "endpoint",
    endpointHost: endpoint.hostname,
  };
}

function subscriptionCredentials(key: string, region: string): SpeechCredentials {
  return {
    key,
    region,
    endpoint: null,
    connection: "subscription",
    endpointHost: null,
  };
}

export function isRegionalCognitiveApiHost(hostname: string, region: string): boolean {
  return regionalCognitiveRegion(hostname) === region.toLowerCase();
}

export function parseEndpoint(raw: string, region: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AssessmentError("INVALID_CONFIG", "SPEECH_ENDPOINT is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new AssessmentError("INVALID_CONFIG", "SPEECH_ENDPOINT must use https.");
  }
  if (url.username || url.password) {
    throw new AssessmentError(
      "INVALID_CONFIG",
      "SPEECH_ENDPOINT must not embed credentials. Set SPEECH_KEY instead.",
    );
  }
  if (url.search || url.hash) {
    throw new AssessmentError(
      "INVALID_CONFIG",
      "SPEECH_ENDPOINT must not include a query string or fragment.",
    );
  }
  const hostRegion = regionalCognitiveRegion(url.hostname);
  if (hostRegion && hostRegion !== region.toLowerCase()) {
    throw new AssessmentError(
      "INVALID_CONFIG",
      `SPEECH_ENDPOINT host ${url.hostname} does not match SPEECH_REGION=${region}.`,
    );
  }
  return url;
}

function regionalCognitiveRegion(hostname: string): string | null {
  const match = /^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/i.exec(hostname);
  return match?.[1]?.toLowerCase() ?? null;
}
