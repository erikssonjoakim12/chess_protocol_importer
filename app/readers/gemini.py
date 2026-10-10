"""Reads scoresheets with Google's Gemini API (free tier is enough).

Uses the plain REST endpoint, so no Google SDK is needed.
Docs: https://ai.google.dev/api/generate-content
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .base import Reader, ReaderError, combine_readings

API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Every page is read by each of these at the same time and the readings are
# compared: where they disagree the chess engine decides, and asks if unsure.
# Two fast models in parallel beat one slow careful model: ~10-15 s instead
# of 1-1.5 min, and a misreading has to be made twice to slip through.
DEFAULT_MODELS = "gemini-3.1-flash-lite,gemini-3.5-flash-lite"
# Tried one at a time if none of the above can read a page (busy, out of quota).
DEFAULT_FALLBACK_MODELS = "gemini-3.5-flash,gemini-3.8-flash"
# "Read carefully": models that think before answering. More accurate, but
# 1-1.5 min, and more often busy on the free tier.
DEFAULT_CAREFUL_MODELS = "gemini-3.5-flash,gemini-3.8-flash"
DEFAULT_CAREFUL_FALLBACK_MODELS = "gemini-3.7-flash,gemini-3.1-flash-lite"
TIMEOUT_SECONDS = 180
RETRY_STATUS = {429, 500, 503, 504}
RETRY_PAUSES = [3, 10]  # seconds to wait before the 2nd and 3rd attempt on the same model
# Thinking makes reading slower but more careful. "" leaves the model's default.
DEFAULT_THINKING = ""
# Includes thinking. A normal page needs ~2-5k; this stops a model that loops.
MAX_OUTPUT_TOKENS = 12000

PROMPT = """\
The images are photos of a handwritten chess scoresheet ("protokoll") from a \
Swedish tournament: the pages of ONE game, in order.

Transcribe exactly what is written. Do NOT correct, complete or improve the \
moves; a chess engine checks every move afterwards, so a faithful raw reading \
is what matters, including mistakes. When a cell is hard to read, give your \
best reading in "move", other plausible readings in "alternatives", and set \
"unclear" to true.

NOTATION. Swedish algebraic: K = kung (king), D = dam (queen), T = torn (rook), \
L = löpare (bishop), S = springare (knight); pawn moves have no letter. \
x = capture, + = check, 0-0 / 0-0-0 = castling. Keep the Swedish letters.

LAYOUT. Forms differ a lot, so look at the layout before transcribing.
- First fill in "layout": for each page, how many blocks of columns there \
are (e.g. 1-20, 21-40, 41-60) and the left-to-right order of the columns in \
a block, e.g. "number | Vit | Svart" or "Vit | number | Svart".
- Every row has a white ("Vit") move AND a black ("Svart") move, except \
perhaps the last row of the game. The black column is often shaded grey, and \
on some forms the move number is printed BETWEEN the white and the black \
column, so black's move is to the right of the number. Never skip the black \
column.
- Output rows in move order. One row per move number, never the same row twice.
- On a later page the numbering may continue (41, 61, ...) or restart at 1. \
Put the number printed on the form in "number". Keep pages separate, one \
entry in "pages" per image, in image order.
- Only include rows that have something written in them. If a row really \
has only one of the two moves, leave the other one null.

CLOCK TIMES. Players often write the minutes left on their clock next to a \
move, after a slash: "/42", "/5", "/0". Put only the number in "clock" \
("42"). A slash and number is never part of the move.

GAME END. Words like "uppg." (resigned), "remi" (draw), "tid" / "tid." (lost \
on time) or a result like "1-0" written in a move cell are not moves. Report \
the first one in "end_marker" (text, the column it is in, and the move number \
of its row) and leave it out of the moves. Ignore signatures.

HEADER. First, in "header_notes", briefly say where on the form you find \
each player's name, rating, club and score, and anything that is unclear. \
Then fill "headers". Each header value is ONLY the value as written (e.g. \
"Norrby SK", "1850"): never an explanation, a question or a guess written \
out; doubts go in "header_notes". Fill in every field you can, "" when missing:
- event: the tournament, from the handwritten name and/or a printed title \
that names the tournament (e.g. "Höstturneringen 2025"). Not the club that \
printed the form.
- date: as YYYY.MM.DD. Swedish dates are day/month, so "8/10" is 8 October. \
Use ?? for unknown parts. date_raw: the date exactly as written.
- round ("Rond"), board ("Bord"), group ("Grupp"/"Klass").
- white / black: the players' names. white_elo / black_elo: rating \
("R-tal", "Rat", "Elo"), digits only. white_team / black_team: club \
("Klubb"). Some forms have club and rating on the line under the name with \
no label.
- time_control: as written ("Tid", "Dragserie", "Betänketid").
- white_score / black_score: the points boxes ("Poäng"): "1", "0" or "½".
- site: the place, only if stated.
Put anything else worth knowing (e.g. moves written in the wrong column) in \
"notes".
"""

_STR = {"type": "STRING"}
_HEADER_ORDER = [
    "white", "black", "white_elo", "black_elo", "white_team", "black_team",
    "event", "date_raw", "date", "round", "board", "group", "time_control",
    "white_score", "black_score", "site"]
_CELL = {
    "type": "OBJECT",
    "nullable": True,
    "properties": {
        "move": _STR,
        "clock": _STR,
        "alternatives": {"type": "ARRAY", "items": _STR},
        "unclear": {"type": "BOOLEAN"},
    },
    "propertyOrdering": ["move", "clock", "alternatives", "unclear"],
    "required": ["move"],
}
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "layout": _STR,
        "header_notes": _STR,
        "headers": {
            "type": "OBJECT",
            "properties": {k: _STR for k in _HEADER_ORDER},
            # Most valuable first: if a model derails, it's usually late.
            "propertyOrdering": _HEADER_ORDER,
        },
        "pages": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "rows": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "number": {"type": "INTEGER"},
                                "white": _CELL,
                                "black": _CELL,
                            },
                            "propertyOrdering": ["number", "white", "black"],
                            "required": ["number"],
                        },
                    },
                },
                "required": ["rows"],
            },
        },
        "end_marker": {
            "type": "OBJECT",
            "nullable": True,
            "properties": {
                "text": _STR,
                "column": {"type": "STRING", "enum": ["white", "black"]},
                "move_number": {"type": "INTEGER"},
            },
        },
        "notes": _STR,
    },
    # Layout first: describing the form before reading it keeps the columns straight.
    "propertyOrdering": ["layout", "header_notes", "headers", "pages", "end_marker", "notes"],
    "required": ["layout", "headers", "pages"],
}


class GeminiReader(Reader):
    name = "gemini"

    def __init__(self, api_key=None, models=None, fallbacks=None, careful=False):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        if careful:
            configured = os.environ.get("GEMINI_CAREFUL_MODELS") or DEFAULT_CAREFUL_MODELS
            configured_fallbacks = os.environ.get("GEMINI_CAREFUL_FALLBACK_MODELS",
                                                  DEFAULT_CAREFUL_FALLBACK_MODELS)
        else:
            configured = (os.environ.get("GEMINI_MODELS") or os.environ.get("GEMINI_MODEL")
                          or DEFAULT_MODELS)
            configured_fallbacks = os.environ.get("GEMINI_FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS)
        self.models = _model_list(models, configured)
        self.fallbacks = [m for m in _model_list(fallbacks, configured_fallbacks)
                          if m not in self.models]
        self.thinking = os.environ.get("GEMINI_THINKING", DEFAULT_THINKING).strip().lower()
        self.used_models = set()
        if not self.api_key:
            raise ReaderError(
                "GEMINI_API_KEY is not set. Get a free key at "
                "https://aistudio.google.com/apikey and put it in the .env file.")

    def _request_body(self, images, page_no=1, page_count=1):
        parts = []
        if page_count > 1:
            parts.append({"text": "This is page %d of %d of the game (sent separately)."
                                  % (page_no, page_count)})
        for i, (data, mime) in enumerate(images, 1):
            parts.append({"text": "Image %d of %d:" % (i, len(images))})
            parts.append({"inline_data": {"mime_type": mime,
                                          "data": base64.b64encode(data).decode("ascii")}})
        parts.append({"text": PROMPT})
        config = {
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
        }
        if self.thinking:
            config["thinkingConfig"] = {"thinkingLevel": self.thinking}
        return {"contents": [{"role": "user", "parts": parts}], "generationConfig": config}

    def read(self, images):
        """Each page is read in its own request, in parallel, so a two-page
        game takes about as long as a one-page game."""
        if len(images) <= 1:
            return self._read_page(images, 1, 1)
        with ThreadPoolExecutor(max_workers=len(images)) as pool:
            jobs = [pool.submit(self._read_page, [image], i, len(images))
                    for i, image in enumerate(images, 1)]
            return _merge_pages([job.result() for job in jobs])

    def _read_page(self, images, page_no, page_count):
        """Read one page with all models in parallel; fall back one by one."""
        body = json.dumps(self._request_body(images, page_no, page_count)).encode("utf-8")
        with ThreadPoolExecutor(max_workers=len(self.models)) as pool:
            results = list(pool.map(lambda m: self._try_model(m, body), self.models))
        readings = [r for r, _ in results if r is not None]
        errors = [e for _, e in results if e]
        for model in self.fallbacks:
            if readings:
                break
            reading, error = self._try_model(model, body)
            if reading is not None:
                readings.append(reading)
            else:
                errors.append(error)
        if not readings:
            raise ReaderError("Gemini couldn't read page %d right now (tried %s). Please try "
                              "again in a few minutes. Details: %s"
                              % (page_no, ", ".join(self.models + self.fallbacks), errors[-1]))
        return combine_readings(readings)

    def _try_model(self, model, body):
        """Returns (reading, None) or (None, error message)."""
        error = None
        for pause in RETRY_PAUSES + [None]:
            try:
                reading = _parse_response(self._post(model, body))
            except _Busy as e:
                error = "%s: %s" % (model, e)
                if pause is None or e.code == 429:
                    break  # out of quota: no point in waiting a few seconds
                time.sleep(pause)
                continue
            except _BadAnswer as e:
                return None, "%s: %s" % (model, e)  # e.g. stuck repeating itself
            self.used_models.add(model)
            return reading, None
        return None, error

    def _post(self, model, body):
        req = urllib.request.Request(
            API_URL.format(model=model), data=body, method="POST",
            headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            try:
                detail = json.loads(detail)["error"]["message"]
            except (ValueError, KeyError, TypeError):
                pass
            if e.code in RETRY_STATUS:
                raise _Busy(e.code, detail)
            raise ReaderError("Gemini returned HTTP %d: %s" % (e.code, detail))
        except urllib.error.URLError as e:
            raise ReaderError("Could not reach Gemini: %s" % e.reason)


class _Busy(Exception):
    """Overloaded or out of quota: worth retrying, or trying another model."""

    def __init__(self, code, detail):
        super().__init__("HTTP %d %s" % (code, detail))
        self.code = code


def _model_list(explicit, configured):
    if explicit:
        return list(explicit)
    return [m.strip() for m in (configured or "").split(",") if m.strip()]


class _BadAnswer(Exception):
    """The model answered, but not with usable JSON."""


def _parse_response(payload):
    try:
        candidate = payload["candidates"][0]
        parts = candidate["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        reason = (payload.get("promptFeedback") or {}).get("blockReason") \
            or ((payload.get("candidates") or [{}])[0]).get("finishReason") or "no content"
        raise _BadAnswer("no answer (%s)" % reason)
    if candidate.get("finishReason") == "MAX_TOKENS":
        raise _BadAnswer("the answer was cut off (too long)")
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    try:
        return json.loads(text)
    except ValueError:
        raise _BadAnswer("not valid JSON: %s" % text[:200])


def _merge_pages(readings):
    """Combine per-page readings into one, in page order."""
    merged = {"layout": "", "headers": {}, "header_flags": [], "pages": [],
              "end_marker": None, "notes": ""}
    for reading in readings:
        for key, value in (reading.get("headers") or {}).items():
            if value and not merged["headers"].get(key):
                merged["headers"][key] = value
                if key in (reading.get("header_flags") or []):
                    merged["header_flags"].append(key)
        merged["pages"].extend(reading.get("pages") or [])
        end = reading.get("end_marker")
        if end and (end.get("text") or "").strip():
            merged["end_marker"] = end
        for key in ("layout", "notes"):
            if reading.get(key):
                merged[key] = (merged[key] + " " + reading[key]).strip()
    return merged
