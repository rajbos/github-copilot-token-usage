# Release video generator

Turns a release into a narrated MP4.

Everything except the voice runs on this machine: planning, screenshots,
timing, captions, motion and encoding never touch the network. The voice is
pluggable, and that is the one place the choice matters — `piper`, `sapi`,
`silence` and a local `command` engine keep the whole build offline and free,
while `mistral` sends narration text to a hosted service and is billed per
request. Which one is active is `voice.engine` in `config.json`, and `doctor`
says so out loud.

```
What's New catalog ─┬─> scene manifest ──> screenshots ──> narration WAVs
                    │        (edit me)      (headless)      (Piper / your voice)
  package.nls.json ─┘                │                           │
                                     ▼                           ▼
                            title + download cards      measured durations
                             (HTML -> PNG)                       │
                                     └───────────┬───────────────┘
                                                 ▼
                     MP4  <──  NVENC encode  <──  xfade + captions
```

The finished video runs: **cold open** on a real screen from this release →
**logo sting** → one scene per catalogued feature → **download card** with the
repository URL and the marketplaces it ships to.

One command:

```bash
npm run video -- build
```

## Why this is more automatable than it looks

The hard part of an automated product-update video is usually "which screenshot
goes with which release note" — normally a job for a vision model, and the
flakiest link in the chain.

This repository has already answered it. Every entry in
`vscode-extension/src/whatsNew/catalog.ts` carries a `surface` naming the exact
view, tab and DOM anchor the feature added, and
`.github/skills/visual-view-diff/views.config.json` can render any of those
headlessly. A feature therefore maps to a screenshot by **lookup, not
inference** — and its anchor is measured on the page so the Ken Burns zoom
lands on the new section rather than the middle of the screen.

The local model's job shrinks to what models are actually good at: writing
prose. It never picks a file, a duration or a coordinate.

## Setup

### Required

1. **FFmpeg** with `zoompan`, `xfade`, `subtitles` (libass) and `loudnorm`.
   Already present on this machine, with NVENC.
2. **The webview bundles**, which the screenshots are rendered from:
   ```bash
   cd ../vscode-extension && npm install && npm run compile
   ```
3. **This package**:
   ```bash
   npm install && npm run build
   ```

Then check everything at once:

```bash
npm run video -- doctor
```

### The voice

`config.json` ships with `voice.engine: "command"`, wired to
[Piper](https://github.com/OHF-Voice/piper1-gpl): neural, **CPU-only**, MIT.
CPU-only matters here — it means narration never competes with NVENC for the
6 GB of VRAM, so the stages can overlap freely.

One-time setup (Python 3.11 — 3.14 has no wheels for this):

```bash
py -3.11 -m venv .venv-tts
.venv-tts/Scripts/python -m pip install piper-tts
.venv-tts/Scripts/python -m piper.download_voices --download-dir assets/voice/piper en_GB-alan-medium
```

The voice models are ~60–120 MB each and are gitignored; re-run that last
command to get them back. `en_US-ryan-high` is a slower, higher-quality
alternative — swap the `-m` value in `config.json`.

Two fallbacks are always available without any install:

- `voice.engine: "sapi"` — Windows' built-in synthesizer. Pre-neural and rough,
  but it needs nothing at all, so it is the fastest way to check that a *script*
  works before caring how it sounds.
- `voice.engine: "silence"` — no speech; durations estimated. For checking
  motion and pacing on their own.

To use your own voice, record a reference (see
[`assets/voice/README.md`](assets/voice/README.md)), install
[Voicebox](https://github.com/voicebox-app) with **Chatterbox Turbo**, start
it, and switch:

```json
"voice": { "engine": "voicebox" }
```

Voicebox is the right shape for this machine for one specific reason: it keeps
the TTS model in **its own process**. With 6 GB of VRAM, a pipeline that loads
a TTS model, Whisper and an NVENC session into one process will run out; over
HTTP they simply take turns.

Check the request schema your build expects at `http://127.0.0.1:8000/docs` and
adjust `voice.voicebox.path` / `extra` in `config.json` if the field names
differ. No code change should be needed.

> Chatterbox embeds a PerTh watermark in its output. That is fine for product
> videos; know that it is there.

#### On SAPI

If you fall back to it, expect rough output. `Microsoft David` and `Zira` are
pre-neural, and this machine has no natural voices installed — the WinRT/OneCore
list adds only `Mark`, from the same generation. SAPI is there to prove the
pipeline, not to narrate anything you would publish.

#### Your own voice (Mistral, hosted)

The fastest route to a cloned voice, and the only engine here that is **not
local**. Clone your voice in Mistral's console, then:

```json
"voice": { "engine": "mistral" }
```

```bash
export MISTRAL_API_KEY=...        # never goes in config.json
npm run video -- doctor
npm run video -- say --text-file content/voice-test.txt --output output/test.wav
```

`voiceId` and `model` live in `config.json`; the key is read from the
environment variable named by `apiKeyEnv` and is never written to a committed
file, never logged, and never included in an error message.

Two consequences of it being hosted, both real:

- **Narration text leaves the machine**, and each call is billed. The narration
  cache matters more here than anywhere else — an unchanged scene is never
  re-sent — which is why the cache key covers the text and voice but
  deliberately *not* the API key. Rotating a key must not throw away audio that
  would come back byte-identical.
- **It is dramatically faster.** The 105-word test paragraph took 16 seconds
  wall clock, against roughly 14 minutes for Chatterbox on CPU. That is the
  difference between rendering a whole video in your voice and not bothering.

The adapter is plain `fetch`, not `@mistralai/mistralai`: this package has no
runtime dependencies and the SDK would add a tree of them for one POST. The
request body mirrors the SDK's arguments one-for-one, so their documented
example and `synthesizeMistral` stay easy to compare.

#### Your own voice (Chatterbox, local)

Piper cannot clone — it has fixed voices. For your own voice, the repository
ships a Chatterbox adapter (MIT licensed, and the right size for a 6 GB card):

```bash
.venv-tts/Scripts/python -m pip install chatterbox-tts
```

Put a reference recording at `assets/voice/rob-reference.wav` (see
[assets/voice/README.md](assets/voice/README.md)), then point the `command`
engine at the wrapper:

```json
"argv": [
  ".venv-tts/Scripts/python.exe", "scripts/chatterbox-speak.py",
  "--text-file", "{{textFile}}", "--out", "{{out}}",
  "--reference", "{{referenceWav}}",
  "--exaggeration", "0.5", "--cfg-weight", "0.5"
],
"stdinText": false
```

Audition it on any text before committing to a render:

```bash
npm run video -- say --text-file content/voice-test.txt --output output/test.wav
```

Two things to know:

- **`scripts/chatterbox-speak.py` chunks long text.** Chatterbox is trained on
  short utterances and degrades over a few hundred characters — it rushes and
  drops words. The wrapper splits at sentence boundaries and generates each
  chunk from one model instance, so the voice conditionals (and therefore the
  voice) stay identical across the joins.
- **It will very likely run on CPU.** PyPI's `torch` for Windows is CPU-only,
  and an RTX PRO Blackwell card is `sm_120`, which needs a CUDA 12.8 build that
  `torch` 2.6 does not have. The wrapper checks the GPU's compute capability
  against `torch.cuda.get_arch_list()` and falls back to CPU rather than
  failing inside a kernel launch. Expect minutes per paragraph — fine for
  auditioning, slow for a full render.

Because it is slow and non-deterministic, Chatterbox is best kept for the final
cut rather than for iterating. The engine `config.json` currently ships with is
`mistral`, which clones the same voice far faster; `piper` is the one to switch
to when you want a build that stays offline and free.

#### Switching engines

Changing the engine (or any parameter that affects the sound) changes the
narration cache key, so every line regenerates on the next run — which is the
point, since a half-old half-new soundtrack would be worse than either:

```bash
npm run video -- build --from voice
```

### Optional extras

| Set | Get | Cost |
|---|---|---|
| `llm.enabled: true` | Narration rewritten into one flowing script by `qwen3:8b` on Ollama | ~1 min; falls back to the catalog wording if the model is down |
| `subtitles.align: true` | Word-level caption timing via `whisper-ctranslate2` | An extra Python install; falls back to sentence-level timing |

Both degrade to the deterministic path rather than failing the build.

## Using it

```bash
npm run video -- build                        # everything
npm run video -- build --version 0.18.0       # a specific release
npm run video -- build --max-features 3       # a short one
npm run video -- build --llm                  # with narration polish
npm run video -- timeline                     # running order, no rendering
```

### The manifest is the seam

`plan` writes `content/manifest.json` and every later stage reads it. **Edit it
by hand.** Reword narration, reorder scenes, change a transition, nudge a focus
point — then:

```bash
npm run video -- build --from voice
```

Only what you changed is regenerated. To re-plan from the catalog without
losing wording you have already tuned:

```bash
npm run video -- plan --keep-narration
```

### Stages

| Stage | Reads | Writes | Re-runs when |
|---|---|---|---|
| `plan` | catalog + `package.nls.json` | `content/manifest.json` | the release changes |
| `shots` | manifest + webview bundles | `assets/screenshots/*.png` | the UI changes |
| `voice` | manifest | `cache/narration/*.wav` | narration text changes |
| `subs` | manifest | `cache/subtitles/*.ass` | any timing changes |
| `render` | everything | `output/*.mp4` | anything changes |
| `qa` | the MP4 | a report | always cheap |

Every stage is cached on content, so `--from` is rarely needed — just re-run
`build` and it will skip what is still valid. `--force` ignores all caches.

## Design decisions worth knowing

**Audio is the timing authority.** Scene lengths come from `ffprobe` on the
generated WAV, never from an estimate. A sentence that takes longer to say than
it looks gets a longer scene, automatically. This is the single rule that
prevents narration being cut off by a transition.

**Scenes render separately, then assemble.** One 12-input `-filter_complex`
fails after minutes with an error that names a label rather than a scene.
Instead each scene becomes its own small MP4, content-addressed on its image
bytes, motion and duration — so changing one screenshot re-renders one scene.

**Filter graphs are written to files**, never to a command line. That avoids
every layer of shell quoting and leaves the exact graph in
`cache/filtergraphs/` to read when something does fail.

**Nothing runs through a shell.** Every external program is spawned with an
argv array, and every path is resolved and checked to be inside this directory
before any I/O. Narration text and model output can never be re-parsed as
commands.

**The supersample factor is computed, not chosen.** `zoompan` crops in whole
source pixels, so if the crop rectangle moves less than one pixel between two
frames, those frames come out identical and the move judders. A slow zoom over
a long scene does exactly that — the first cut of this pipeline had roughly
every other frame duplicated. `supersampleFor()` solves for the upscale needed
to keep the crop moving every frame, clamped at 6× so a frame still fits in
memory. `motion.test.ts` asserts the invariant.

A corollary: **scenes that are long need a bigger zoom**, not a smaller one.
`motion.zoomTo` is 1.12 for this reason. Dropping it toward 1.0 makes the
motion less smooth, not more subtle, because it pushes the per-frame movement
back below a pixel.

**Loudness is measured in one pass and corrected in the next.** `loudnorm` is
used only to measure; the correction is an explicit gain plus a peak limiter.
The reason is a mode switch that is easy to miss: asked for `linear=true`,
`loudnorm` reverts to riding the gain — without saying so — whenever the
constant gain it would need breaches the true-peak ceiling. Narration always
breaches it, so "linear" would not have been linear.

It also re-samples *after* loudness work. That filter runs internally at
192 kHz and emits at that rate, which otherwise reaches the encoder and lands
as a strange 96 kHz AAC stream — the actual defect behind the first cut's
rough-sounding audio.

Note that a low loudness range is **normal** here: an untouched SAPI narration
WAV measures about 2.9 LU. Single-voice TTS is naturally flat, so the QA
threshold sits at 2 LU rather than at a music-like value.

**Titles are ASS, not `drawtext`.** One text engine for captions and titles
means one place for fonts and escaping to go wrong — and it avoids
`drawtext`'s `fontfile=C:\...` colon, which needs escaping through two layers
of filter parsing.

**The cards are web pages.** The logo sting and the download card are HTML,
photographed by the same headless browser that takes the screenshots — so they
get real typography, real layout and sharp SVG logos, for no extra dependency.
Branding lives in `config.json` under `branding`, pointing at the
repository's own `assets/`; logos are inlined as data URIs, because a
`file://` page cannot reliably load `file://` sub-resources and a card that
renders without its logo would pass every check here.

**Narration is written for a listener, not a reader.** `narration.ts` supplies
what the catalog leaves implicit — which view you are on, what appeared there,
and a subject for the sentence — using the same display names that are on
screen. See its header comment for why the catalog's own wording cannot be
read aloud as-is.

## Finishing in DaVinci Resolve

The pipeline deliberately does not automate Resolve. Resolve Free's scripting
surface is partial (several calls are Studio-only) and it must be installed,
configured and usually running — a poor foundation for a repeatable build.

Use it the other way round: let this produce the first cut, then open
`output/*.mp4` in Resolve Free only for the episodes that need hand-tuned
callouts or motion. The scene intermediates in `cache/scenes/` import
individually if you want to recut rather than polish.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no webview bundles at …` | `cd ../vscode-extension && npm run compile` |
| `view "x" is not in views.config.json` | A new panel was added without registering it. See AGENTS.md, *Webview changes must be validated by clicking*. |
| `view "x" has no state "y"` | The catalog names a tab that the harness has no `state` for. Add it to `views.config.json`. |
| Screenshots look empty | The fixture for that view has no data. Fixtures live in `.github/skills/visual-view-diff/fixtures/`. |
| Voice says a product name wrong | Add a respelling to `pronunciation.json`. Captions keep the real spelling. |
| Captions drift late in the video | Should be impossible — both captions and `xfade` offsets come from `timeline.ts`. If it happens, that module is the bug. |
| NVENC fails | Set `encode.encoder` to `libx264`. Everything else is unchanged. |

## What still needs a human

Per the source research, and true here:

- Whether the chosen screenshot actually tells the story.
- Product-name pronunciation (first time only — then it is in the map).
- Long-sentence pacing.
- Whether a transition is tasteful rather than merely available.

Watch the first cut. That is what it is for.
