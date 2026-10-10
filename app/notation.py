"""Normalising handwritten moves (Swedish or English notation) into comparable keys.

Everything is compared in *Swedish* form (K, D, T, L, S), because that is what
is handwritten, so the look-alike table below describes real handwriting slips.
"""
import re

ENGLISH_TO_SWEDISH = {"K": "K", "Q": "D", "R": "T", "B": "L", "N": "S"}
SWEDISH_PIECES = set("KDTLS")

# Pairs of characters that are easy to confuse in handwriting (or in the
# reader's interpretation of it). Substituting one for the other is cheap.
_LOOKALIKES = [
    "49", "4y", "9y", "9g", "9q", "gq", "17", "1l", "1i", "7T", "1L",
    "38", "35", "3S", "5S", "56", "6b", "6G", "0O", "0o", "Oo",
    "ce", "ae", "ad", "ag", "hb", "hk", "hn", "ft", "fl", "DP", "Dd",
    "KR", "Kk", "Ss", "Ll", "Tt", "28", "2z", "uh",
]
LOOKALIKE = {frozenset(p) for p in _LOOKALIKES}

# Writing the square as seen from the other side of the board: files a<->h,
# b<->g, c<->f, d<->e and ranks 1<->8, 2<->7, 3<->6, 4<->5. A legal move only
# found this way is always shown to the user, never fixed silently.
MIRROR = {frozenset(p) for p in ["ah", "bg", "cf", "de", "18", "27", "36", "45"]}
MIRROR_COST = 0.4

_CASTLE_LONG = re.compile(r"^[0oO]-?[0oO]-?[0oO]$")
_CASTLE_SHORT = re.compile(r"^[0oO]-?[0oO]$")


def handwritten_key(text):
    """Turn a handwritten move into a compact Swedish-notation key.

    'Sxd4+' -> 'Sd4', 'Nbd2' -> 'Sbd2', 'exd5' -> 'ed5', '0-0' -> 'O-O',
    'e8=D' / 'e8D' -> 'e8D'. Returns '' for empty input.
    """
    t = (text or "").strip()
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"(e\.?p\.?)$", "", t)
    t = t.rstrip("+#!?‡†")
    t = t.replace("†", "").replace("+", "").replace("#", "")
    if _CASTLE_LONG.match(t):
        return "O-O-O"
    if _CASTLE_SHORT.match(t):
        return "O-O"
    if not t:
        return ""
    # Piece letter: English to Swedish; lower-case s/t/l/k can't be files, so
    # they must be a sloppily written piece letter.
    first = t[0]
    if first in ENGLISH_TO_SWEDISH:
        t = ENGLISH_TO_SWEDISH[first] + t[1:]
    elif first in "stlk" and len(t) > 2:
        t = first.upper() + t[1:]
    # Promotion: '=Q', '=D', or a trailing piece letter after the last rank.
    m = re.match(r"^(.*[18])=?([KQRBNDTLS])$", t)
    if m:
        piece = ENGLISH_TO_SWEDISH.get(m.group(2), m.group(2))
        t = m.group(1) + piece
    t = t.replace("x", "").replace(":", "").replace("-", "").replace("=", "")
    return t


def san_to_swedish(san):
    """'Nxe4+' -> 'Sxe4+', 'e8=Q' -> 'e8=D'. For display."""
    out = []
    for i, ch in enumerate(san):
        prev = san[i - 1] if i else ""
        if ch in ENGLISH_TO_SWEDISH and (i == 0 or prev == "="):
            out.append(ENGLISH_TO_SWEDISH[ch])
        else:
            out.append(ch)
    return "".join(out)


def _sub_cost(a, b, mirror):
    if a == b:
        return 0.0
    if a.lower() == b.lower():
        return 0.15
    pair = frozenset((a, b))
    if pair in LOOKALIKE:
        return 0.35
    if mirror and pair in MIRROR:
        return MIRROR_COST
    return 1.0


def weighted_distance(a, b, mirror=True):
    """Levenshtein distance with cheap substitutions for look-alike characters
    (and, if `mirror`, for mirrored files/ranks)."""
    prev = [float(j) for j in range(len(b) + 1)]
    for i in range(1, len(a) + 1):
        cur = [float(i)] + [0.0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(
                prev[j] + 1.0,
                cur[j - 1] + 1.0,
                prev[j - 1] + _sub_cost(a[i - 1], b[j - 1], mirror),
            )
        prev = cur
    return prev[len(b)]


def similarity(a, b, mirror=True):
    """1.0 for identical keys, falling towards 0 as they differ."""
    if not a or not b:
        return 0.0
    return max(0.0, 1.0 - weighted_distance(a, b, mirror) / max(len(a), len(b)))
