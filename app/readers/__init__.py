"""Scoresheet readers. Pick one with the READER environment variable.

To add a reader (another API, a local model, ...): subclass `Reader`, return
a reading in the shape described in base.py, and register it below.
"""
import os

from .base import Reader, ReaderError, combine_readings, flatten, normalize_reading


def _gemini(careful):
    from .gemini import GeminiReader
    return GeminiReader(careful=careful)


def _mock(careful):
    from .mock import MockReader
    return MockReader()


READERS = {"gemini": _gemini, "mock": _mock}


def get_reader(name=None, careful=False):
    """`careful` asks for a slower, more accurate reading where the reader has one."""
    name = (name or os.environ.get("READER") or "gemini").lower()
    if name not in READERS:
        raise ReaderError("Unknown reader '%s'. Choose one of: %s"
                          % (name, ", ".join(sorted(READERS))))
    return READERS[name](careful)
