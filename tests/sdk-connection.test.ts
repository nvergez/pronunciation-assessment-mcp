import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadCredentials } from "../src/credentials.js";

const require = createRequire(import.meta.url);
const sdk = require("microsoft-cognitiveservices-speech-sdk") as typeof import("microsoft-cognitiveservices-speech-sdk");
const { SpeechConnectionFactory } = require("microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/SpeechConnectionFactory.js") as {
  SpeechConnectionFactory: new () => {
    create: (
      config: unknown,
      auth: { token: string; headerName: string },
      connectionId: string,
    ) => Promise<{ uri: string }>;
  };
};
const { RecognizerConfig } = require("microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/RecognizerConfig.js") as {
  RecognizerConfig: new (speechServiceConfig: undefined, parameters: unknown) => {
    recognitionMode: string;
  };
};
const { RecognitionMode } = require("microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/ServiceMessages/PhraseDetection/PhraseDetectionContext.js") as {
  RecognitionMode: { Interactive: string };
};

const FAKE_KEY = "fake-key-not-sent-anywhere-0000";

test("portal fromEndpoint is not the recognition websocket; fromSubscription is", async () => {
  const portalMiss = await traceConnection(
    () => {
      const config = sdk.SpeechConfig.fromEndpoint(new URL("https://westus.api.cognitive.microsoft.com/"), FAKE_KEY);
      config.setProperty(sdk.PropertyId.SpeechServiceConnection_Region, "westus");
      return config;
    },
    async () => ({ status: 404, text: async () => "missing" }),
  );
  assert.deepEqual(portalMiss.fetches, [
    {
      protocol: "https:",
      host: "westus.api.cognitive.microsoft.com",
      pathname: "/stt/speech/universal/v2",
      redirect: "true",
      sentAuthHeader: false,
    },
  ]);
  assert.deepEqual(portalMiss.websocket, {
    protocol: "https:",
    host: "westus.api.cognitive.microsoft.com",
    pathname: "/stt/speech/universal/v2",
  });

  const portalRedirect = await traceConnection(
    () => {
      const config = sdk.SpeechConfig.fromEndpoint(new URL("https://westus.api.cognitive.microsoft.com/"), FAKE_KEY);
      config.setProperty(sdk.PropertyId.SpeechServiceConnection_Region, "westus");
      return config;
    },
    async () => ({
      status: 200,
      text: async () => "https://westus.stt.speech.microsoft.com/stt/speech/universal/v2",
    }),
  );
  assert.equal(portalRedirect.fetches.length, 1);
  assert.equal(portalRedirect.fetches[0]?.sentAuthHeader, false);
  assert.deepEqual(portalRedirect.websocket, {
    protocol: "wss:",
    host: "westus.stt.speech.microsoft.com",
    pathname: "/stt/speech/universal/v2",
  });

  const subscription = await traceConnection(
    () => sdk.SpeechConfig.fromSubscription(FAKE_KEY, "westus"),
    async () => {
      throw new Error("fromSubscription must not fetch a redirect");
    },
  );
  assert.deepEqual(subscription.fetches, []);
  assert.deepEqual(subscription.websocket, {
    protocol: "wss:",
    host: "westus.stt.speech.microsoft.com",
    pathname: "/stt/speech/universal/v2",
  });

  const configured = loadCredentials({
    SPEECH_KEY: FAKE_KEY,
    SPEECH_REGION: "westus",
    SPEECH_ENDPOINT: "https://westus.api.cognitive.microsoft.com/",
  });
  assert.equal(configured.connection, "subscription");
  assert.equal(configured.endpoint, null);
});

async function traceConnection(
  createConfig: () => import("microsoft-cognitiveservices-speech-sdk").SpeechConfig,
  fetchImpl: () => Promise<{ status: number; text: () => Promise<string> }>,
): Promise<{
  fetches: Array<{ protocol: string; host: string; pathname: string; redirect: string | null; sentAuthHeader: boolean }>;
  websocket: { protocol: string; host: string; pathname: string };
}> {
  const speechConfig = createConfig();
  speechConfig.speechRecognitionLanguage = "en-US";
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  const properties = (speechConfig as unknown as { properties: unknown }).properties;
  const recognizerConfig = new RecognizerConfig(undefined, properties);
  recognizerConfig.recognitionMode = RecognitionMode.Interactive;
  const fetches: Array<{ protocol: string; host: string; pathname: string; redirect: string | null; sentAuthHeader: boolean }> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    const url = new URL(String(input));
    fetches.push({
      protocol: url.protocol,
      host: url.host,
      pathname: url.pathname,
      redirect: url.searchParams.get("GenerateRedirectResponse"),
      sentAuthHeader: Boolean(init?.headers),
    });
    return fetchImpl();
  }) as typeof fetch;
  try {
    const connection = await new SpeechConnectionFactory().create(
      recognizerConfig,
      { token: FAKE_KEY, headerName: "Ocp-Apim-Subscription-Key" },
      "offline-connection",
    );
    const websocket = new URL(connection.uri);
    assert.equal(websocket.searchParams.get("Ocp-Apim-Subscription-Key") === FAKE_KEY, true);
    websocket.searchParams.delete("Ocp-Apim-Subscription-Key");
    return {
      fetches,
      websocket: {
        protocol: websocket.protocol,
        host: websocket.host,
        pathname: websocket.pathname,
      },
    };
  } finally {
    globalThis.fetch = previous;
  }
}
