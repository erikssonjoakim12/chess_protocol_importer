"""A reader that ignores the photos and returns a saved reading.

Handy for working on the app without an API key or using up quota:
set READER=mock and MOCK_READING=path/to/reading.json.
"""
import json
import os

from .base import Reader, ReaderError

DEFAULT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures",
                            "demo_reading.json")


class MockReader(Reader):
    name = "mock"

    def __init__(self, path=None):
        self.path = path or os.environ.get("MOCK_READING") or DEFAULT_PATH

    def read(self, images):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except OSError as e:
            raise ReaderError("Mock reader could not open %s: %s" % (self.path, e))
