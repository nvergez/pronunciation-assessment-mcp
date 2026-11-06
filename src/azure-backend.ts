import type { BackendAssessResult, SpeechBackend } from "./backend.js";
import { isRegionalCognitiveApiHost, type SpeechCredentials } from "./credentials.js";
import { AssessmentError } from "./errors.js";

type SpeechSdk = typeof import("microsoft-cognitiveservices-speech-sdk");

/**
 * The Speech SDK appends the subscription key to the websocket URL query.
 * Never log recognizer URLs, connection events, or raw SDK error strings
 * without redaction.
 */
export function createAzureBackend(): SpeechBackend {
  return {
    async assess(input): Promise<BackendAssessResult> {
      if (input.signal.aborted) {
        throw new AssessmentError("TIMEOUT", "Assessment was canceled before Azure was called.");
      }
      const sdk = await import("microsoft-cognitiveservices-speech-sdk");
      const speechConfig = createSpeechConfig(sdk, input.credentials);
      speechConfig.speechRecognitionLanguage = input.locale;
      speechConfig.outputFormat = sdk.OutputFormat.Detailed;

      const audioConfig = sdk.AudioConfig.fromWavFileInput(input.audio);
      const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
        input.referenceText,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        true,
      );
      if (input.phonemeAlphabet) {
        pronunciationConfig.phonemeAlphabet = input.phonemeAlphabet;
      }
      if (input.nBestPhonemeCount !== null) {
        pronunciationConfig.nbestPhonemeCount = input.nBestPhonemeCount;
      }
      pronunciationConfig.enableProsodyAssessment = input.enableProsody;

      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      let sessionId: string | null = null;
      recognizer.sessionStarted = (sender, event) => {
        void sender;
        sessionId = event.sessionId;
      };
      pronunciationConfig.applyTo(recognizer);

      try {
        return await recognizeOnce(sdk, recognizer, () => sessionId, input.signal);
      } finally {
        safeClose(() => recognizer.close());
        safeClose(() => audioConfig.close());
        safeClose(() => speechConfig.close());
      }
    },
  };
}

function safeClose(close: () => void): void {
  try {
    close();
  } catch {
    // Closing a recognizer twice, or after a timeout, is not an assessment result.
  }
}

function createSpeechConfig(sdk: SpeechSdk, credentials: SpeechCredentials) {
  if (credentials.endpoint && !isRegionalCognitiveApiHost(credentials.endpoint.hostname, credentials.region)) {
    const speechConfig = sdk.SpeechConfig.fromEndpoint(credentials.endpoint, credentials.key);
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_Region, credentials.region);
    return speechConfig;
  }
  return sdk.SpeechConfig.fromSubscription(credentials.key, credentials.region);
}

function recognizeOnce(
  sdk: SpeechSdk,
  recognizer: InstanceType<SpeechSdk["SpeechRecognizer"]>,
  sessionId: () => string | null,
  signal: AbortSignal,
): Promise<BackendAssessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };
    const onAbort = () => {
      finish(() => {
        try {
          recognizer.close();
        } catch {
          // The recognizer may already be closed.
        }
        reject(new AssessmentError("TIMEOUT", "Assessment timed out while calling Azure Speech."));
      });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    recognizer.recognizeOnceAsync(
      (result) => {
        finish(() => {
          try {
            resolve(toBackendResult(sdk, result, sessionId()));
          } catch (error) {
            reject(error);
          }
        });
      },
      (error) => {
        finish(() => {
          reject(new AssessmentError("PROVIDER_ERROR", `Azure Speech request failed: ${error}`));
        });
      },
    );
  });
}

function toBackendResult(
  sdk: SpeechSdk,
  result: InstanceType<SpeechSdk["SpeechRecognitionResult"]>,
  sessionId: string | null,
): BackendAssessResult {
  const resultReason = sdk.ResultReason[result.reason] ?? String(result.reason);
  const jsonRaw = result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult);
  let jsonResult: unknown | null = null;
  if (jsonRaw && jsonRaw.trim()) {
    try {
      jsonResult = JSON.parse(jsonRaw) as unknown;
    } catch {
      throw new AssessmentError("INCOMPLETE_RESULT", "Azure Speech returned a JSON result that could not be parsed.");
    }
  }

  if (result.reason === sdk.ResultReason.Canceled) {
    const cancellation = sdk.CancellationDetails.fromResult(result);
    return {
      jsonResult,
      resultReason,
      resultId: result.resultId || null,
      sessionId,
      cancellationReason: sdk.CancellationReason[cancellation.reason] ?? String(cancellation.reason),
      cancellationErrorCode: sdk.CancellationErrorCode[cancellation.ErrorCode] ?? String(cancellation.ErrorCode),
      cancellationErrorDetails: cancellation.errorDetails || null,
      sdkDisplayText: result.text || null,
    };
  }

  return {
    jsonResult,
    resultReason,
    resultId: result.resultId || null,
    sessionId,
    cancellationReason: null,
    cancellationErrorCode: null,
    cancellationErrorDetails: null,
    sdkDisplayText: result.text || null,
  };
}
