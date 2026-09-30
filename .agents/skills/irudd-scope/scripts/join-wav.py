#!/usr/bin/env python3
"""Join Scope speech exports in order, preserving samples and adding turn gaps."""

import argparse
from pathlib import Path
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("turns", type=Path, nargs="+")
    args = parser.parse_args()
    if args.output.suffix.lower() != ".wav":
        parser.error("output must be a new .wav file")
    parts = []
    for path in args.turns:
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 24000, "NONE"):
                parser.error(f"{path}: expected 24 kHz mono 16-bit PCM WAV")
            frames = audio.getnframes()
            data = audio.readframes(frames)
            if not frames or len(data) != frames * 2:
                parser.error(f"{path}: empty or truncated WAV")
            parts.append(data)
    # Exclusive creation also protects an input path used accidentally as the output.
    with args.output.open("xb") as target:
        with wave.open(target, "wb") as audio:
            audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            gap = bytes(4320 * 2)  # 180 ms at 24 kHz.
            for index, data in enumerate(parts):
                if index:
                    audio.writeframesraw(gap)
                audio.writeframesraw(data)


if __name__ == "__main__":
    main()
