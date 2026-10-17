# Your reference voice

The cloned voice is built from one short recording of you, kept here. Nothing
in this folder is committed (see `../../.gitignore`) — it is your voice, it
stays on your machine, and the pipeline only ever reads it locally.

## What to record

| | |
|---|---|
| File | `rob-reference.wav` |
| Length | 10–20 seconds of continuous speech |
| Format | mono, 24 kHz or better, 16-bit PCM WAV |
| Content | ordinary sentences, read the way you want the video to sound |

Alongside it, `rob-reference.txt` holds the **exact** transcript of what you
said — same words, same punctuation. Some cloning models use it to align the
sample, and a transcript that does not match the audio degrades the clone.

## How to record it

Anything that writes a clean WAV will do. With Windows Voice Recorder you will
get an `.m4a`, so convert it:

```bash
ffmpeg -i recording.m4a -ac 1 -ar 24000 -c:a pcm_s16le assets/voice/rob-reference.wav
```

What actually matters, in rough order of impact:

1. **No background noise.** No fan, no keyboard, no room echo. A model clones
   the room as readily as the voice.
2. **One take, no edits.** Splices become audible artefacts in every generated
   line.
3. **Read like you narrate**, not like you chat. The clone reproduces your
   pace and energy, so record at the pace you want the video to have.
4. **Vary the sentences.** Three or four ordinary sentences give the model more
   phonemes to work with than one sentence repeated.

Suggested script — it covers a wide phoneme range and takes about 15 seconds:

> This release adds a few things worth knowing about, so let me walk you
> through what changed and why it might matter to you. Most of it you will
> find in the usage views, and the rest is quietly in the background.

## Consent

Record this yourself, of your own voice. Do not use a recording of anyone else,
and do not point this at audio you found somewhere — a cloned voice saying
things the person never said is the whole problem with the technology, and it
is trivially easy to do by accident when the reference file is just a path in a
config.

## Checking it worked

```bash
npm run video -- doctor
```

reports whether the reference file is found and whether the Voicebox server is
answering. After that, generate one line and listen to it before committing to
a whole video:

```bash
npm run video -- plan --max-features 1
npm run video -- shots
npm run video -- voice
```

The WAVs land in `cache/narration/`.
