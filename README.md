# pronunciation-assessment-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io) server and command-line tool that score a WAV recording against known reference text. The default scorer is Azure Speech Pronunciation Assessment. `--provider speechace` uses the Speechace text scoring API instead.

The server speaks MCP over **stdio** on your machine. This repository does not host an HTTP MCP endpoint.

One shared core serves both the MCP tool `assess_pronunciation` and the `pronunciation-assess` CLI. The package is not published to npm. Install it from a clone.

## Purpose

Scripted pronunciation assessment: you supply the audio file and the text that should have been read. The tool returns scores and timings from the selected provider. It does not invent a spoken phoneme, and it does not produce a correction. `phoneme` is the expected phoneme. For Azure, `nBestPhonemes` are service hypotheses when the service returns them. For Speechace, `nBestPhonemes` is `sound_most_like`, the phone Speechace heard, and its score stays `null` because Speechace does not return a separate hypothesis score. Missing scores stay `null`.

## Requirements

- Node.js 22 or newer (CI also runs on Node.js 24)
- For the default Azure provider: an Azure Speech resource, plus `SPEECH_KEY` and `SPEECH_REGION`
- For Speechace: `SPEECHACE_API_KEY`

The tool only calls the selected scoring API. It does not create resources or change pricing tiers. A Free (F0) Speech resource allows a small monthly amount of real-time audio and one concurrent real-time request. Those limits are Azure limits, not settings in this program. Speechace plan limits are separate and are not changed here.

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

Speechace is optional. Set it only when you pass `--provider speechace`:

```bash
export SPEECHACE_API_KEY="your-speechace-key"
```

The Speechace client posts the WAV to `https://api.speechace.co/api/scoring/text/v9/json` with `dialect=en-us` unless `--locale en-GB` selects `en-gb`. The key is a query parameter and is not written to stdout, stderr, or the result JSON.

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
| `provider` | no | `azure` or `speechace`. Default `azure`. |
| `locale` | no | BCP-47 locale. Default `en-US`. Speechace accepts `en-US` and `en-GB`. |
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
| `--provider` | `azure` (default) or `speechace`. |
| `--locale` | Default `en-US`. For Speechace, `en-US` is dialect `en-us` and `en-GB` is `en-gb`. |
| `--phoneme-alphabet` | `IPA` or `SAPI`. Azure defaults to IPA for `en-US` and SAPI for `zh-CN`. Speechace defaults to IPA and keeps ARPAbet symbols when `SAPI` is set. |
| `--no-prosody` | Do not request Azure prosody. Speechace text scoring does not return a prosody score. |
| `--timeout-ms` | Local timeout. Default 90000. |

JSON goes to stdout. Diagnostics go to stderr. Exit codes: `0` success, `1` invalid input, `2` configuration, `3` provider or recognition failure, `4` timeout.

`PA_SYNTHETIC_RESPONSE_FILE` is an Azure test seam. When it is set, Azure is not called and the JSON has `synthetic: true`. `PA_SPEECHACE_RESPONSE_FILE` is the same kind of seam for `--provider speechace`. Neither seam is a live assessment.

## Integration smoke

`pronunciation-assess-smoke` sends the bundled Microsoft sample `whatstheweatherlike.wav` with the reference text `what's the weather like`. That file is the official Speech SDK sample, not a recording of a user. A successful result has `provider.azureCalled: true`, `provider.connection` set to `subscription`, and `integrationSmoke.speaker` set to `microsoft-official-sample`. It shows that your Speech resource accepted the sample. It is not a pronunciation score for a person.

Unit tests do not call Azure. A green `npm test` is not a live validation.

## Audio and request limits

Checked locally, from Azure documentation retrieved 2026-11-06:

- WAV PCM, 16 kHz, 16-bit, mono. That matches the short-audio content type `audio/wav; codecs=audio/pcm; samplerate=16000`.
- At most 30 seconds and 2,000,000 bytes. Longer recognition uses continuous mode, and Azure does not return miscue tags there. This tool does not invent omission or insertion labels.
- Reference text is required. Azure does not publish a character maximum. This tool rejects more than 2000 characters after trim. Speechace text scoring rejects more than 1500 characters, and this tool enforces that limit when `--provider speechace` is set.
- 33 documented Azure pronunciation-assessment locales. Default `en-US`. Speechace text scoring here accepts `en-US` (`en-us`) and `en-GB` (`en-gb`) only.
- Prosody is requested only for `en-US`.
- Phoneme names: IPA for `en-US`; SAPI for `en-US` and `zh-CN`. Other locales can return phoneme scores with a null name.
- For `en-US`, five `nBestPhonemes` are requested and passed through.
- Grading is HundredMark (0–100). The SDK sets dimension `Comprehensive`, which is what returns fluency, completeness, and word error type.

Word `errorType` is Azure's string. Speechace text scoring does not return Azure miscue tags, so `errorType` is `null`. Prosody `feedback` is the raw Azure object, or `null` for Speechace. Azure offsets are 100-nanosecond ticks. `offsetMs` is `ticks / 10000`. Speechace `extent` values are 10 ms frames: `offsetMs` is `start × 10` and `durationMs` is `(end − start) × 10`, and the tick fields are those milliseconds converted the same way. Omitted fields are `null`.

Speechace word `accuracy` is `quality_score` rounded to the nearest integer. Phoneme `accuracy` is that phone's `quality_score`, also rounded. `nBestPhonemes` has one entry, `sound_most_like`, converted to the same alphabet as `phoneme`, with `score: null`. Utterance `pronunciation` and `accuracy` are `text_score.speechace_score.pronunciation` when Speechace returns it. `fluency` is `speechace_score.fluency` when present. Completeness, prosody, confidence, and SNR stay `null`.

## Privacy

The audio bytes and the reference text are sent to the selected provider: Azure Speech in your resource's region, or Speechace at `api.speechace.co` when `--provider speechace` is set. Do not point the tool at a recording you cannot send there. `SPEECH_KEY` and `SPEECHACE_API_KEY` are read from the environment and are not written to stdout, stderr, or the result JSON. The Speech SDK places the Azure key on the websocket request, and the Speechace client places its key on the request query; this program does not log either URL.

## Scores

HundredMark values are model scores from 0 to 100. They are not an absolute measure of pronunciation and they are not a human rating. Azure fluency, completeness, prosody, and the overall pronunciation score are included only when Azure returns them. Speechace pronunciation and fluency scores are included only when that response has them. A null score means it was not returned, or not requested. It is not a zero.

## Security

- Keep `SPEECH_KEY` and `SPEECHACE_API_KEY` in the environment or a gitignored `.env`. `.env.example` has empty placeholders.
- Do not commit keys, `.env`, audio recordings of people, or PCM dumps.
- Do not pass either key on the command line.
- Review MCP client config before sharing it. Prefer inheriting the environment over writing a key into JSON.
- `PA_SYNTHETIC_RESPONSE_FILE` and `PA_SPEECHACE_RESPONSE_FILE` must be unset for a real assessment.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` builds `dist/` and runs unit tests plus CLI and MCP stdio smokes against synthetic fixtures. The SDK tests check the pronunciation JSON and the websocket host selection with `fetch` stubbed. Speechace tests map published response excerpts and stub `fetch`. They do not open a network connection to Azure or Speechace.

GitHub Actions runs typecheck, test, and build on Node.js 22 and 24.

## License

MIT. See `LICENSE`.

`samples/whatstheweatherlike.wav` is redistributed from [Azure-Samples/cognitive-services-speech-sdk](https://github.com/Azure-Samples/cognitive-services-speech-sdk), which is MIT, Copyright (c) Microsoft Corporation. See `samples/NOTICE`.
