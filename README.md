# pronunciation-assessment-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io) server and command-line tool that score a WAV recording against known reference text with Azure Speech Pronunciation Assessment.

The server speaks MCP over **stdio** on your machine. This repository does not host an HTTP MCP endpoint.

One shared core serves both the MCP tool `assess_pronunciation` and the `pronunciation-assess` CLI. The package is not published to npm. Install it from a clone.

## Purpose

Scripted pronunciation assessment: you supply the audio file and the text that should have been read. The tool returns the scores and timings Azure returns. It does not invent a spoken phoneme, and it does not produce a correction. `phoneme` is the expected phoneme from Azure. `nBestPhonemes`, when present, are service hypotheses. Missing scores stay `null`.

## Requirements

- Node.js 22 or newer (CI also runs on Node.js 24)
- An Azure Speech resource in your subscription
- `SPEECH_KEY` and `SPEECH_REGION` for that resource

The tool only calls the pronunciation assessment API. It does not create resources or change pricing tiers. A Free (F0) Speech resource allows a small monthly amount of real-time audio and one concurrent real-time request. Those limits are Azure limits, not settings in this program.

## Install

```bash
git clone <repository-url>
cd pronunciation-assessment-mcp
npm ci
npm run build
```

## Configure

Each user sets their own resource. Copy `.env.example` to a local `.env` if you want a file, and leave `.env` uncommitted. This package does not load `.env` automatically.

```bash
export SPEECH_KEY="your-speech-resource-key"
export SPEECH_REGION="westus"
```

`westus` is only an example. Use the region of your resource.

`SPEECH_ENDPOINT` is optional. The portal value `https://<region>.api.cognitive.microsoft.com/` is the resource API host, not the recognition websocket. For that host, in the same region as `SPEECH_REGION`, the client uses `SpeechConfig.fromSubscription`. Speech SDK 1.53.0 then connects to `wss://<region>.stt.speech.microsoft.com/stt/speech/universal/v2`. Passing that portal root to `fromEndpoint` is not reliable: the SDK requests an unauthenticated redirect, and if the response is not HTTP 200 it opens a websocket on the portal host, which closes with status 1006. Set `SPEECH_ENDPOINT` only for a private link or another non-portal speech endpoint. A portal host for a different region than `SPEECH_REGION` is rejected.

Do not put the key in a shell history line you share, in MCP config that is committed, or in argv.

## MCP

The server is stdio only. Point your local MCP client at the built file and let it inherit the environment:

```json
{
  "mcpServers": {
    "pronunciation-assessment": {
      "command": "node",
      "args": ["/absolute/path/to/pronunciation-assessment-mcp/dist/mcp.js"]
    }
  }
}
```

Tool: `assess_pronunciation`.

| Argument | Required | Meaning |
| --- | --- | --- |
| `audioPath` | yes | Local WAV path. URLs are rejected. |
| `referenceText` | yes | Text the recording should match. |
| `locale` | no | BCP-47 locale. Default `en-US`. |
| `phonemeAlphabet` | no | `IPA` or `SAPI`. |
| `enableProsody` | no | Request prosody. Supported for `en-US` only. |
| `timeoutMs` | no | Local timeout. Default 90000. |

The tool result text is the same JSON object the CLI writes to stdout. There is no remote MCP URL in this project.

After `npm run build` you can also run `node dist/mcp.js`, or the `pronunciation-assessment-mcp` bin from `node_modules/.bin` if you install the folder locally.

## CLI

```bash
node dist/cli.js \
  --audio /absolute/path/take.wav \
  --reference "what's the weather like"
```

| Flag | Meaning |
| --- | --- |
| `--audio` | Local WAV path. |
| `--reference` | Reference text. Surrounding whitespace is trimmed. |
| `--locale` | Default `en-US`. |
| `--phoneme-alphabet` | `IPA` or `SAPI`. Default IPA for `en-US`, SAPI for `zh-CN`. |
| `--no-prosody` | Do not request prosody. |
| `--timeout-ms` | Local timeout. Default 90000. |

JSON goes to stdout. Diagnostics go to stderr. Exit codes: `0` success, `1` invalid input, `2` configuration, `3` provider or recognition failure, `4` timeout.

`PA_SYNTHETIC_RESPONSE_FILE` is a test seam. When it is set, Azure is not called and the JSON has `synthetic: true`.

## Integration smoke

`pronunciation-assess-smoke` sends the bundled Microsoft sample `whatstheweatherlike.wav` with the reference text `what's the weather like`. That file is the official Speech SDK sample, not a recording of a user. A successful result has `provider.azureCalled: true`, `provider.connection` set to `subscription`, and `integrationSmoke.speaker` set to `microsoft-official-sample`. It shows that your Speech resource accepted the sample. It is not a pronunciation score for a person.

Unit tests do not call Azure. A green `npm test` is not a live validation.

## Audio and request limits

Checked locally, from Azure documentation retrieved 2026-11-06:

- WAV PCM, 16 kHz, 16-bit, mono. That matches the short-audio content type `audio/wav; codecs=audio/pcm; samplerate=16000`.
- At most 30 seconds and 2,000,000 bytes. Longer recognition uses continuous mode, and Azure does not return miscue tags there. This tool does not invent omission or insertion labels.
- Reference text is required. Azure does not publish a character maximum. This tool rejects more than 2000 characters after trim.
- 33 documented pronunciation-assessment locales. Default `en-US`.
- Prosody is requested only for `en-US`.
- Phoneme names: IPA for `en-US`; SAPI for `en-US` and `zh-CN`. Other locales can return phoneme scores with a null name.
- For `en-US`, five `nBestPhonemes` are requested and passed through.
- Grading is HundredMark (0–100). The SDK sets dimension `Comprehensive`, which is what returns fluency, completeness, and word error type.

Word `errorType` is Azure's string. Prosody `feedback` is the raw Azure object. Offsets are 100-nanosecond ticks. `offsetMs` is `ticks / 10000`. Omitted fields are `null`.

## Privacy

The audio bytes and the reference text are sent to Azure Speech in your resource's region. Do not point the tool at a recording you cannot send there. The subscription key is read from `SPEECH_KEY` and is not written to stdout, stderr, or the result JSON. The Speech SDK places the key on the websocket request; this program does not log that URL.

## Scores

HundredMark values are Azure Speech model scores from 0 to 100. They are not an absolute measure of pronunciation and they are not a human rating. Fluency, completeness, prosody, and the overall pronunciation score are included only when Azure returns them. A null prosody score means it was not returned, or not requested. It is not a zero.

## Security

- Keep `SPEECH_KEY` in the environment or a gitignored `.env`. `.env.example` has empty placeholders.
- Do not commit keys, `.env`, audio recordings of people, or PCM dumps.
- Do not pass the key on the command line.
- Review MCP client config before sharing it. Prefer inheriting the environment over writing the key into JSON.
- `PA_SYNTHETIC_RESPONSE_FILE` must be unset for a real assessment.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` builds `dist/` and runs unit tests plus CLI and MCP stdio smokes against synthetic fixtures. The SDK tests check the pronunciation JSON and the websocket host selection with `fetch` stubbed. They do not open a network connection to Azure.

GitHub Actions runs typecheck, test, and build on Node.js 22 and 24.

## License

MIT. See `LICENSE`.

`samples/whatstheweatherlike.wav` is redistributed from [Azure-Samples/cognitive-services-speech-sdk](https://github.com/Azure-Samples/cognitive-services-speech-sdk), which is MIT, Copyright (c) Microsoft Corporation. See `samples/NOTICE`.
