"""What every reader returns, and how that becomes a flat list of plies.

A reader turns photos of a scoresheet into a *reading*: a plain dict

    {
      "headers": {"event", "site", "date", "date_raw", "round", "board",
                  "group", "white", "black", "white_elo", "black_elo",
                  "white_team", "black_team", "time_control",
                  "white_score", "black_score"},          # strings, "" if unknown
      "pages": [{"rows": [{"number": int,
                           "white": Cell | None,
                           "black": Cell | None}]}],
      "end_marker": {"text": str, "column": "white" | "black",
                     "move_number": int} | None,
      "notes": str,
    }

    Cell = {"move": str, "clock": str, "alternatives": [str], "unclear": bool}

Moves are transcribed as written (Swedish notation, typos and all); the
resolver is responsible for making sense of them.
"""
import re

from ..notation import handwritten_key

HEADER_FIELDS = [
    "event", "site", "date", "date_raw", "round", "board", "group",
    "white", "black", "white_elo", "black_elo", "white_team", "black_team",
    "time_control", "white_score", "black_score",
]


class ReaderError(Exception):
    """A reader failed in a way worth showing to the user."""


class Reader:
    name = "base"

    def read(self, images):
        """`images` is a list of (bytes, mime_type) in page order."""
        raise NotImplementedError


def _clean_clock(value):
    digits = re.sub(r"\D", "", str(value or ""))
    return digits


# Readers sometimes get stuck repeating a character, or "think aloud" inside a
# field ("Norrby SK 6 0/1?? (Not entirely clear where... Wait, let me
# re-check"). We keep the start of the value and cut at the first sign of
# such text, and flag the field so the user checks it.
_JUNK = re.compile(r"(.)\1{5,}|\d{9,}|\b(wait|hmm|actually|correction|assum\w*|instructions?|"
                   r"I see|I must|let me|looks like|not (entirely )?clear|probably|likely)\b", re.I)
# Anything outside Latin letters (incl. å ä ö é ü...), digits and plain punctuation.
_ODD_CHAR = re.compile(r"[^A-Za-z0-9À-ÖØ-öø-ÿ .,'&/+\-:½]")
# In a name or club: a rating, a date or a score ("1850", "6/10-2026", "0/1").
_NUMBERISH = re.compile(r"\s(\d{3,}|\d+[/\-.]\d+)(\s|$)")
_MAX_LEN = {"event": 80, "site": 40, "white": 40, "black": 40, "white_team": 40,
            "black_team": 40, "time_control": 40, "date_raw": 20}
_SHORT = {"round", "board", "group", "white_score", "black_score"}
_NAMEISH = {"white", "black", "white_team", "black_team", "site"}


def clean_text(value, max_len=60, nameish=False):
    """Returns (clean text, whether anything suspicious was cut off)."""
    original = re.sub(r"\s+", " ", str(value or "")).strip()
    text = str(value or "").replace("\r", "\n").split("\n")[0]
    # Names and clubs are plain words; other fields ("60 min (+30s/drag)") may
    # legitimately contain brackets and numbers.
    for pattern in (_JUNK,) + ((_ODD_CHAR, _NUMBERISH) if nameish else ()):
        m = pattern.search(text)
        if m:
            text = text[:m.start()]
    text = re.sub(r"\s+", " ", text).strip(" ,;:-")
    if nameish:
        text = re.sub(r"(\s\d)+$", "", text)  # a stray score digit at the end
    if len(text) > max_len:
        text = text[:max_len].rsplit(" ", 1)[0]
    text = text.strip(" ,;:-")
    return text, text != original.strip(" ,;:-")


def parse_written_date(raw):
    """'6/10-2026', '8/10 2026', '2/7-06', '13.10.2006' (day first) -> '2026.10.06'."""
    m = re.search(r"(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[-/. ]\s*(\d{4}|\d{2})\b", raw or "")
    if not m:
        return ""
    day, month, year = int(m.group(1)), int(m.group(2)), m.group(3)
    if len(year) == 2:
        year = ("20" if int(year) < 70 else "19") + year
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return ""
    return "%s.%02d.%02d" % (year, month, day)


def clean_header(key, value):
    """(value safe to show and put in the PGN, or ''; whether it looked suspicious)."""
    raw = str(value or "").strip()
    if key in ("white_elo", "black_elo"):
        m = re.search(r"\b(\d{3,4})\b", raw)
        return (m.group(1) if m else ""), bool(raw) and (not m or m.group(1) != raw)
    if key == "date":
        # Not \b: there is no word boundary next to "??" ("1858.??.??").
        m = re.search(r"(?<!\d)(\d{4}|\?{4})[.\-/](\d{2}|\?\?)[.\-/](\d{2}|\?\?)(?!\d)", raw)
        return (".".join(m.groups()) if m else ""), bool(raw) and not m
    if key in _SHORT:
        return clean_text(raw, 12)
    return clean_text(raw, _MAX_LEN.get(key, 60), nameish=key in _NAMEISH)


def _clean_headers(raw_headers):
    """All header fields cleaned, plus the set of fields worth a second look."""
    raw_headers = raw_headers or {}
    headers, flags = {}, set()
    for key in HEADER_FIELDS:
        headers[key], suspect = clean_header(key, raw_headers.get(key))
        if suspect:
            flags.add(key)
    written = parse_written_date(headers["date_raw"])
    if written and not headers["date"]:
        headers["date"] = written
    elif written and headers["date"] != written:
        flags.add("date")  # the formatted date and the handwriting disagree
    return headers, flags


def _clean_move(value):
    text = str(value or "").strip()
    junk = _JUNK.search(text)
    if junk:
        text = text[:junk.start()]
    return text.strip()[:12].strip()


def _clean_cell(cell):
    if not cell:
        return None
    move = _clean_move(cell.get("move"))
    alts = [_clean_move(a) for a in (cell.get("alternatives") or [])]
    alts = [a for a in alts if a]
    if not move and not alts:
        return None
    return {
        "move": move,
        "clock": _clean_clock(cell.get("clock")),
        "alternatives": [a for a in alts if a != move],
        "unclear": bool(cell.get("unclear")),
    }


# Words written in a move cell to end the game: resigned, draw, lost on time, results.
_END_WORD = re.compile(
    r"^(upp?g\.?|uppgav|uppgivet|uppger|ger upp|remi[s.]?|tid\.?|tidsf\w*|"
    r"1-0|0-1|½-½|1/2-1/2|0[.,]5-0[.,]5|resigns?|draw|time)$", re.I)


def is_end_word(text):
    return bool(_END_WORD.match((text or "").strip()))


def _is_repeat(prev, row):
    """Same row number, and wherever both rows have a move it's the same move."""
    if prev["number"] is None or prev["number"] != row["number"]:
        return False
    for color in ("white", "black"):
        a, b = prev[color], row[color]
        if a and b and a["move"] != b["move"]:
            return False
    return True


def normalize_reading(raw):
    """Fill in defaults so the rest of the app can rely on the shape."""
    raw = raw or {}
    headers, flags = _clean_headers(raw.get("headers"))
    flags |= set(raw.get("header_flags") or [])
    end = raw.get("end_marker") or None
    if end and not str(end.get("text") or "").strip():
        end = None
    pages = []
    ended = False
    for page in raw.get("pages") or []:
        rows = []
        for row in page.get("rows") or []:
            if ended:
                break  # nothing after the end of the game is a move (signatures etc.)
            white, black = _clean_cell(row.get("white")), _clean_cell(row.get("black"))
            for color, cell in (("white", white), ("black", black)):
                if cell and is_end_word(cell["move"]):
                    # The reader put "uppg." etc. in a move cell; it's the end of the game.
                    end = end or {"text": cell["move"], "column": color,
                                  "move_number": row.get("number")}
                    if color == "white":
                        white = black = None
                    else:
                        black = None
                    ended = True
                    break
            if not (white or black):
                continue
            new = {"number": row.get("number"), "white": white, "black": black}
            if rows and _is_repeat(rows[-1], new):
                # Readers sometimes emit a row twice, once incomplete; keep the fuller one.
                rows[-1] = {"number": new["number"],
                            "white": rows[-1]["white"] or new["white"],
                            "black": rows[-1]["black"] or new["black"]}
                continue
            rows.append(new)
        pages.append({"rows": rows})
    return {"headers": headers, "header_flags": sorted(flags), "pages": pages,
            "end_marker": end, "notes": str(raw.get("notes") or "")}


def _combine_cells(cells):
    """Several readings of one cell -> one cell. The first reading leads; if
    the others read something else, that goes into alternatives and the cell
    is marked unclear, so the resolver weighs the readings against the board."""
    missing = any(c is None for c in cells)  # some readings saw nothing here
    cells = [c for c in cells if c]
    if not cells:
        return None
    first = dict(cells[0])
    alternatives = list(first["alternatives"])
    disagree = missing
    for other in cells[1:]:
        if handwritten_key(other["move"]) != handwritten_key(first["move"]):
            disagree = True
            alternatives.append(other["move"])
        alternatives.extend(other["alternatives"])
        if not first["clock"]:
            first["clock"] = other["clock"]
    seen = {handwritten_key(first["move"])}
    first["alternatives"] = []
    for a in alternatives:
        if handwritten_key(a) not in seen:
            seen.add(handwritten_key(a))
            first["alternatives"].append(a)
    first["unclear"] = any(c["unclear"] for c in cells) or disagree
    return first


def _choose_header(options):
    """Pick one header value from several readings: [(value, suspect)].

    Any value beats an empty one (a complete result with one thing to check is
    more useful than a gap). Then: what most readings agree on, a value that
    didn't need cleaning, and the shorter one when one value just has extra
    words at the end ('Norrby SK' vs 'Norrby SK Krub').
    Returns (value, whether the user should check it)."""
    options = [(v, s) for v, s in options if v]
    if not options:
        return "", False
    values = [v for v, _ in options]

    def support(v):
        # Readings that agree, counting 'Norrby SK Krub' as agreeing with 'Norrby SK'.
        return sum(1 for w in values if w == v or w.lower().startswith(v.lower() + " "))

    def clean(v):
        return not all(s for w, s in options if w == v)

    best = max(values, key=lambda v: (support(v), clean(v), -len(v)))
    disagree = len(set(values)) > 1
    return best, disagree or not clean(best)


def combine_readings(raw_readings):
    """Combine readings of the same page(s) by different models, row by row.

    Rows are matched on their printed move number. A cell that only one
    reading has is kept, but marked unclear.
    """
    readings = [normalize_reading(r) for r in raw_readings]
    if len(readings) == 1:
        return readings[0]
    combined = {"headers": {}, "header_flags": [], "pages": [], "end_marker": None, "notes": ""}
    flags = set()
    for key in HEADER_FIELDS:
        value, suspect = _choose_header([(r["headers"][key], key in r["header_flags"])
                                         for r in readings])
        combined["headers"][key] = value
        if suspect:
            flags.add(key)
    combined["header_flags"] = sorted(flags)
    combined["end_marker"] = next((r["end_marker"] for r in readings if r["end_marker"]), None)
    combined["notes"] = " ".join(r["notes"] for r in readings if r["notes"])
    page_count = max(len(r["pages"]) for r in readings)
    for p in range(page_count):
        pages = [r["pages"][p] for r in readings if p < len(r["pages"])]
        by_number = []  # (number, [rows]) in the leading reading's order
        index = {}
        for page in pages:
            for row in page["rows"]:
                key = row["number"]
                if key is None or key not in index:
                    index[key] = len(by_number)
                    by_number.append((key, []))
                by_number[index[key]][1].append(row)
        if any(n is not None for n, _ in by_number):
            by_number.sort(key=lambda item: (item[0] is None, item[0] or 0))
        rows = []
        for number, versions in by_number:
            # A reading that doesn't have this row at all counts as "saw nothing".
            versions = versions + [{"white": None, "black": None}] * (len(pages) - len(versions))
            row = {"number": number}
            for color in ("white", "black"):
                row[color] = _combine_cells([v[color] for v in versions])
            rows.append(row)
        combined["pages"].append({"rows": rows})
    return combined


def flatten(reading):
    """Pages and rows -> one list of plies in game order.

    Pages are simply concatenated, so it does not matter whether page 2 is
    numbered 41.. or restarts at 1. A row with only a black move gets an
    empty white ply, so that colours stay in step (the user can delete it).
    """
    plies = []
    for page_no, page in enumerate(reading["pages"], 1):
        for row in page["rows"]:
            for color in ("white", "black"):
                cell = row[color]
                if cell is None:
                    if color == "white" and row["black"] is not None:
                        plies.append({"text": "", "alternatives": [], "clock": "",
                                      "unclear": True, "page": page_no,
                                      "written_number": row["number"]})
                    continue
                plies.append({"text": cell["move"], "alternatives": cell["alternatives"],
                              "clock": cell["clock"], "unclear": cell["unclear"],
                              "page": page_no, "written_number": row["number"]})
    return plies
