---
name: verify-pronunciation-assessment
description: Run a real Azure Speech pronunciation-assessment smoke when SPEECH_KEY and SPEECH_REGION are already in the environment. Use for live verification of pronunciation-assessment-mcp. Unit tests are not a real Azure call.
---

# Verify pronunciation assessment

Unit tests and `PA_SYNTHETIC_RESPONSE_FILE` do not call Azure. They are not a live validation.

`--provider speechace` is a separate scorer. This smoke does not call Speechace. `PA_SPEECHACE_RESPONSE_FILE` does not call Speechace either.

The live command sends audio and reference text to the caller's Azure Speech resource. Read `SPEECH_KEY` from the environment. Do not print it, copy it into a file, or pass it as an argument. Do not create Azure resources, change pricing tiers, or deploy anything.

## Configuration

- `SPEECH_KEY`: the caller's Speech resource key.
- `SPEECH_REGION`: that resource's region, for example `westus`.
- `SPEECH_ENDPOINT`: optional. The portal host `https://<region>.api.cognitive.microsoft.com/` is not the recognition websocket. This package uses `SpeechConfig.fromSubscription` for that host, which connects to `wss://<region>.stt.speech.microsoft.com/stt/speech/universal/v2`.

## Integration smoke

Uses the bundled Microsoft sample and the reference text `what's the weather like`. The sample is not a recording of a user.

```bash
export SPEECH_REGION=westus
# export SPEECH_ENDPOINT=https://westus.api.cognitive.microsoft.com/
unset PA_SYNTHETIC_RESPONSE_FILE
node -e 'console.log(Boolean(process.env.SPEECH_KEY), process.env.SPEECH_REGION)'
pronunciation-assess-smoke
```

Expect the boolean check to print `true` and the configured region, and not to print the key.

A successful stdout JSON object has `provider.azureCalled: true`, `provider.connection` set to `subscription`, and `integrationSmoke.speaker` set to `microsoft-official-sample`. That proves the configured resource accepted the official sample. It does not score a person.

If `PA_SYNTHETIC_RESPONSE_FILE` is set, the command refuses to run.

## Your own recording

Pass a local WAV PCM file: 16 kHz, 16-bit, mono, at most 30 seconds. Do not pass a URL.

```bash
pronunciation-assess --audio /absolute/path/to/take.wav --reference "the known reference text"
```

## What to report

- Exit code
- `ok`, `provider.azureCalled`, `provider.connection`, and `provider.region`
- Whether prosody was null
- Recognition status
- That HundredMark scores are model scores, not an absolute judgment

Do not paste `SPEECH_KEY`, websocket URLs, or audio bytes.
