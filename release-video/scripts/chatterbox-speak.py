"""Speak a text file in a cloned voice, using Chatterbox.

This is the `command` voice adapter's cloning engine: it takes a reference
recording of a real person and a piece of text, and writes a WAV.

Two things here are not obvious and matter for quality:

**Long text is chunked.** Chatterbox is trained on short utterances and its
quality falls off over roughly a few hundred characters — it starts rushing,
dropping words, or drifting in timbre. Narration for a single scene can easily
be four hundred characters. So the text is split at sentence boundaries into
chunks under a character budget, generated separately, and joined.

**The chunks are generated from one model instance.** The voice conditionals
are prepared once from the reference and reused, so every chunk is the same
voice. Re-loading the model per chunk would re-derive them and the joins would
be audible. The joins themselves land on sentence boundaries with a short gap,
which is where a speaker would pause anyway.

Usage:
    python chatterbox-speak.py --text-file in.txt --out out.wav \
        --reference assets/voice/rob-reference.wav
"""

from __future__ import annotations

import argparse
import re
import sys


def split_sentences(text: str) -> list[str]:
    """Split on sentence enders, but not on the dots inside a version number."""
    parts = re.split(r"(?<=[.!?])\s+(?=[^\s])", text.strip())
    return [p.strip() for p in parts if p.strip()]


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Group whole sentences into chunks that stay under the budget.

    A sentence longer than the budget on its own is split at clause
    boundaries rather than mid-word, because a chunk boundary inside a word is
    audible however well the voice matches.
    """
    chunks: list[str] = []
    current = ""

    for sentence in split_sentences(text):
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            clause = ""
            for piece in re.split(r"(?<=,)\s+", sentence):
                if clause and len(clause) + len(piece) + 1 > max_chars:
                    chunks.append(clause)
                    clause = piece
                else:
                    clause = f"{clause} {piece}".strip()
            if clause:
                current = clause
            continue

        if current and len(current) + len(sentence) + 1 > max_chars:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()

    if current:
        chunks.append(current)
    return chunks


def pick_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if not torch.cuda.is_available():
        return "cpu"
    # A GPU newer than the installed torch build reports a capability the
    # kernels were never compiled for. Generation then fails deep inside a
    # kernel launch rather than at load, so it is checked up front.
    major, _minor = torch.cuda.get_device_capability()
    supported = {int(a.removeprefix("sm_")[:2]) for a in torch.cuda.get_arch_list() if a.startswith("sm_")}
    if major not in supported:
        print(
            f"[chatterbox] GPU is sm_{major}x but this torch build targets {sorted(supported)}; using CPU.",
            file=sys.stderr,
        )
        return "cpu"
    return "cuda"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reference", required=True, help="WAV of the voice to clone")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--cfg-weight", type=float, default=0.5)
    parser.add_argument("--max-chars", type=int, default=280)
    parser.add_argument("--gap", type=float, default=0.14, help="Seconds of silence between chunks")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--seed", type=int, default=0, help="0 leaves sampling unseeded")
    args = parser.parse_args()

    import torch
    import torchaudio
    from chatterbox.tts import ChatterboxTTS

    if args.seed:
        torch.manual_seed(args.seed)

    with open(args.text_file, encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        raise SystemExit("text file is empty")

    device = pick_device(args.device)
    print(f"[chatterbox] device={device}", file=sys.stderr)

    model = ChatterboxTTS.from_pretrained(device=device)

    chunks = chunk_text(text, args.max_chars)
    print(f"[chatterbox] {len(chunks)} chunk(s)", file=sys.stderr)

    pieces = []
    gap = torch.zeros(1, int(model.sr * args.gap))
    for index, chunk in enumerate(chunks, start=1):
        print(f"[chatterbox] {index}/{len(chunks)}: {chunk[:60]}...", file=sys.stderr)
        wav = model.generate(
            chunk,
            audio_prompt_path=args.reference,
            exaggeration=args.exaggeration,
            cfg_weight=args.cfg_weight,
        )
        pieces.append(wav.detach().cpu())
        if index < len(chunks):
            pieces.append(gap)

    torchaudio.save(args.out, torch.cat(pieces, dim=1), model.sr)
    print(f"[chatterbox] wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
