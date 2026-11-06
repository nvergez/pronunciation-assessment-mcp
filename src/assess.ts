import { loadLocalWav } from "./audio.js";
import type { BackendAssessResult } from "./backend.js";
import { loadCredentials } from "./credentials.js";
import { AssessmentError } from "./errors.js";
import { diagnostic } from "./log.js";
import { mapAzureAssessment } from "./map-result.js";
import { DEFAULT_TIMEOUT_MS, SPEECH_SDK_VERSION } from "./limits.js";
import { redactText, secretsFromEnv } from "./redact.js";
import { buildAssessmentRequest, validateTimeout } from "./request-options.js";
import type { AssessDeps, AssessInput, SuccessBody } from "./types.js";

export async function assessPronunciation(input: AssessInput, deps: AssessDeps): Promise<SuccessBody> {
  const secrets = secretsFromEnv(deps.env);
  const audio = await loadLocalWav(input.audioPath);
  const request = buildAssessmentRequest({
    referenceText: input.referenceText,
    locale: input.locale,
    phonemeAlphabet: input.phonemeAlphabet,
    enableProsody: input.enableProsody,
  });
  const timeoutMs = validateTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const credentials = loadCredentials(deps.env);

  diagnostic(
    deps.stderr,
    `audio accepted (${audio.bytes.length} bytes, ${audio.info.durationMs} ms, ${audio.info.sampleRateHz} Hz mono pcm)`,
    secrets,
  );
  diagnostic(
    deps.stderr,
    `locale ${request.locale}; phoneme alphabet ${request.phonemeAlphabet ?? "omitted"}; prosody ${request.enableProsodyAssessment ? "requested" : "not requested"}`,
    secrets,
  );
  if (deps.mode === "synthetic") {
    diagnostic(deps.stderr, "synthetic fixture; Azure Speech was not called", secrets);
  } else if (credentials.connection === "endpoint") {
    diagnostic(deps.stderr, `calling Azure Speech via endpoint host ${credentials.endpointHost ?? "custom"}`, secrets);
  } else {
    diagnostic(deps.stderr, `calling Azure Speech for region ${credentials.region}`, secrets);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await deps.backend.assess({
      audio: audio.bytes,
      referenceText: request.referenceText,
      locale: request.locale,
      phonemeAlphabet: request.phonemeAlphabet,
      enableProsody: request.enableProsodyAssessment,
      nBestPhonemeCount: request.nBestPhonemeCount,
      credentials,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new AssessmentError("TIMEOUT", `Assessment timed out after ${timeoutMs} ms.`, {
        details: { timeoutMs },
      });
    }
    const assessment = interpretResult(result, secrets);
    diagnostic(deps.stderr, deps.mode === "synthetic" ? "fixture completed" : "assessment completed", secrets);
    return {
      ok: true,
      synthetic: deps.mode === "synthetic",
      audio: {
        fileName: audio.fileName,
        bytes: audio.bytes.length,
        durationMs: audio.info.durationMs,
        sampleRateHz: audio.info.sampleRateHz,
        channels: audio.info.channels,
        bitsPerSample: audio.info.bitsPerSample,
        encoding: "pcm",
      },
      request: {
        locale: request.locale,
        referenceText: request.referenceText,
        phonemeAlphabet: request.phonemeAlphabet,
        gradingSystem: request.gradingSystem,
        granularity: request.granularity,
        dimension: request.dimension,
        enableMiscue: true,
        enableProsodyAssessment: request.enableProsodyAssessment,
        nBestPhonemeCount: request.nBestPhonemeCount,
        prosodySupportedForLocale: request.prosodySupportedForLocale,
      },
      assessment,
      provider: {
        name: deps.mode === "synthetic" ? "synthetic-fixture" : "azure-speech",
        azureCalled: deps.mode === "azure",
        sdkVersion: deps.mode === "azure" ? SPEECH_SDK_VERSION : null,
        region: credentials.region,
        endpointHost: credentials.endpointHost,
        connection: credentials.connection,
        resultReason: result.resultReason,
        resultId: result.resultId,
        sessionId: result.sessionId,
      },
      notes: notesFor(deps.mode, request.enableProsodyAssessment, request.prosodySupportedForLocale),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AssessmentError("TIMEOUT", `Assessment timed out after ${timeoutMs} ms.`, {
        details: { timeoutMs },
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function interpretResult(result: BackendAssessResult, secrets: string[]) {
  if (result.resultReason === "Canceled") {
    throw cancellationError(result, secrets);
  }
  if (result.resultReason === "NoMatch") {
    throw new AssessmentError("RECOGNITION_FAILED", "Azure Speech did not match speech in the audio.", {
      details: { resultReason: "NoMatch" },
    });
  }
  if (result.resultReason !== "RecognizedSpeech") {
    throw new AssessmentError("PROVIDER_ERROR", `Unexpected recognition result: ${result.resultReason}.`);
  }
  if (result.jsonResult === null) {
    throw new AssessmentError("INCOMPLETE_RESULT", "Azure Speech did not return a JSON result.");
  }
  return mapAzureAssessment(result.jsonResult, result.sdkDisplayText);
}

function cancellationError(result: BackendAssessResult, secrets: string[]): AssessmentError {
  const providerMessage = result.cancellationErrorDetails
    ? redactProviderMessage(result.cancellationErrorDetails, secrets)
    : undefined;
  const details = providerMessage ? { providerMessage, errorCode: result.cancellationErrorCode } : {
    errorCode: result.cancellationErrorCode,
  };
  switch (result.cancellationErrorCode) {
    case "AuthenticationFailure":
      return new AssessmentError(
        "PROVIDER_AUTH",
        "Azure Speech rejected the credentials. Check SPEECH_KEY and SPEECH_REGION. The key is not included in this error.",
        { details },
      );
    case "Forbidden":
    case "TooManyRequests":
      return new AssessmentError(
        "PROVIDER_QUOTA",
        "Azure Speech refused the request because of quota or concurrency. Free (F0) allows one concurrent real-time request and that limit is not adjustable. This tool does not change the pricing tier.",
        { details },
      );
    case "ServiceTimeout":
      return new AssessmentError("PROVIDER_TIMEOUT", "Azure Speech timed out waiting for a response.", { details });
    case "ConnectionFailure":
      return new AssessmentError("PROVIDER_CONNECTION", "Azure Speech connection failed.", { details });
    default:
      return new AssessmentError("PROVIDER_ERROR", "Azure Speech canceled recognition.", { details });
  }
}

function redactProviderMessage(message: string, secrets: string[]): string {
  return truncate(redactText(message, secrets), 500);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function notesFor(mode: "azure" | "synthetic", prosodyRequested: boolean, prosodySupported: boolean): string[] {
  const notes = [
    "HundredMark scores are Azure Speech model scores from 0 to 100. They are not an absolute pronunciation measure and they are not a human rating.",
    "Each phoneme value is the expected phoneme from Azure. nBestPhonemes, when present, are service hypotheses. This tool does not select a spoken phoneme and does not produce a correction.",
  ];
  if (!prosodySupported) {
    notes.push("Prosody assessment is documented for en-US only and was not requested.");
  } else if (!prosodyRequested) {
    notes.push("Prosody assessment was not requested. A null prosody score is not a prosody rating.");
  } else {
    notes.push("Prosody assessment was requested. A null prosody score means Azure did not return ProsodyScore.");
  }
  if (mode === "synthetic") {
    notes.push("Synthetic fixture mode. Azure Speech was not called. This result is not a real assessment.");
  } else {
    notes.push("The audio and reference text were sent to Azure Speech for this assessment.");
  }
  return notes;
}
