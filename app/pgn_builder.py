"""Build the final PGN: tags from the scoresheet header, moves from the resolver."""
import re

import chess
import chess.pgn

# "/0" on a scoresheet means "less than a minute left".
UNDER_A_MINUTE_SECONDS = 30

# Tag order in the output. The first seven are PGN's mandatory tags.
TAG_ORDER = [
    ("Event", "event"), ("Site", "site"), ("Date", "date"), ("Round", "round"),
    ("White", "white"), ("Black", "black"), ("Result", "result"),
    ("WhiteElo", "white_elo"), ("WhiteTeam", "white_team"),
    ("BlackElo", "black_elo"), ("BlackTeam", "black_team"),
    ("TimeControl", "time_control"), ("Board", "board"), ("Section", "group"),
]
REQUIRED = {"Event", "Site", "Date", "Round", "White", "Black", "Result"}
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}


def _score(value):
    v = (value or "").strip().replace(",", ".").replace(" ", "")
    if v in ("1", "1.0"):
        return 1.0
    if v in ("0", "0.0"):
        return 0.0
    if v in ("½", "1/2", "0.5", ".5"):
        return 0.5
    return None


def _result_from_end_marker(end):
    if not end:
        return None
    text = (end.get("text") or "").lower().replace(" ", "")
    if text in RESULTS:
        return text
    if text in ("½-½", "0.5-0.5"):
        return "1/2-1/2"
    if text.startswith("rem"):
        return "1/2-1/2"
    if text.startswith("uppg") or text.startswith("tid") or text.startswith("ger"):
        # The player who wrote it in their own column resigned / lost on time.
        loser = end.get("column")
        if loser == "white":
            return "0-1"
        if loser == "black":
            return "1-0"
    return None


def derive_result(headers, end_marker=None, checkmate_winner=None):
    """Return (result, warning or None) from score boxes, end words and mate."""
    w, b = _score(headers.get("white_score")), _score(headers.get("black_score"))
    from_scores = None
    if (w, b) == (1.0, 0.0) or (w == 1.0 and b is None) or (w is None and b == 0.0):
        from_scores = "1-0"
    elif (w, b) == (0.0, 1.0) or (w == 0.0 and b is None) or (w is None and b == 1.0):
        from_scores = "0-1"
    elif w == 0.5 or b == 0.5:
        from_scores = "1/2-1/2"
    from_end = _result_from_end_marker(end_marker)
    from_mate = {"white": "1-0", "black": "0-1"}.get(checkmate_winner)

    found = [r for r in (from_scores, from_end, from_mate) if r]
    if not found:
        return "*", None
    if len(set(found)) > 1:
        return found[0], "The score boxes, end of game note and final position disagree " \
                         "about the result (%s). Please check it." % ", ".join(found)
    return found[0], None


_PERIOD = re.compile(r"(\d+(?:[.,]\d+)?)\s*(tim|h|min|m)\w*\s*/\s*(\d+)\s*(?:drag|d|moves?)?",
                     re.I)
_AMOUNT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(tim|h|min|m|sek|s)?\w*", re.I)


def _seconds(number, unit, default_unit):
    n = float(number.replace(",", "."))
    unit = (unit or default_unit).lower()
    if unit.startswith(("tim", "h")):
        return int(n * 3600)
    if unit.startswith("m"):
        return int(n * 60)
    return int(n)


def time_control_to_pgn(text):
    """'60 min + 30s/drag' -> '3600+30'; '2 tim/40 drag 1 tim/20 30 min' ->
    '40/7200:20/3600:1800'. Anything not understood is returned unchanged."""
    raw = (text or "").strip()
    if not raw or re.fullmatch(r"[\d/:+-]+", raw):
        return raw
    t = raw.replace("(", " ").replace(")", " ")
    increment = ""
    inc = re.search(r"\+\s*(\d+)\s*(s|sek|sec)?", t, re.I)
    if inc:
        increment = "+%d" % int(inc.group(1))
        t = t[:inc.start()] + " " + t[inc.end():]
        t = re.sub(r"/\s*(drag|move|d)\w*", " ", t, flags=re.I)
    periods = []
    for m in _PERIOD.finditer(t):
        periods.append("%s/%d" % (m.group(3), _seconds(m.group(1), m.group(2), "min")))
    rest = _PERIOD.sub(" ", t)
    amounts = [m for m in _AMOUNT.finditer(rest) if m.group(1)]
    if len(amounts) > 1 or (not amounts and not periods):
        return raw
    final = ""
    if amounts:
        final = str(_seconds(amounts[0].group(1), amounts[0].group(2), "min")) + increment
    elif increment:
        return raw
    return ":".join(periods + ([final] if final else []))


def clock_seconds(minutes_left):
    digits = re.sub(r"\D", "", str(minutes_left or ""))
    if not digits:
        return None
    minutes = int(digits)
    return minutes * 60 if minutes > 0 else UNDER_A_MINUTE_SECONDS


def build_tags(headers, result):
    values = dict(headers)
    values["result"] = result
    values["time_control"] = time_control_to_pgn(headers.get("time_control"))
    values["white_elo"] = re.sub(r"\D", "", headers.get("white_elo") or "")
    values["black_elo"] = re.sub(r"\D", "", headers.get("black_elo") or "")
    tags = []
    for tag, key in TAG_ORDER:
        value = (values.get(key) or "").strip()
        if tag == "Date" and not value:
            value = "????.??.??"
        if value or tag in REQUIRED:
            tags.append((tag, value or "?"))
    return tags


def build_pgn(headers, resolved_plies, result):
    game = chess.pgn.Game()
    game.headers.clear()
    for tag, value in build_tags(headers, result):
        game.headers[tag] = value
    node = game
    for ply in resolved_plies:
        if not ply.get("uci"):
            break
        node = node.add_variation(chess.Move.from_uci(ply["uci"]))
        seconds = clock_seconds(ply.get("clock"))
        if seconds is not None:
            node.set_clock(seconds)
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    return game.accept(exporter) + "\n"
