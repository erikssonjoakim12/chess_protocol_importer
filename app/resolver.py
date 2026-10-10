"""Turn a list of handwritten plies into legal moves.

The game is replayed from the start. For each ply the handwritten text (plus
any alternative readings) is compared to every legal move in the position, and
the closest one is chosen. Uncertain choices are flagged for review; when no
legal move is close enough the replay stops there, because every following
move would be played in a wrong position anyway.

When the replay stops, earlier moves are revisited: a move that was legal but
wrongly written (say c3 for f3, mirrored) often only shows up a few moves
later. If another reading of an earlier move makes the rest of the game fit,
that is offered as a suggestion.
"""
from functools import lru_cache

import chess

from .notation import handwritten_key, san_to_swedish, similarity

STATUS_OK = "ok"            # exact match, or confirmed by the user
STATUS_CHECK = "check"      # best guess, please review
STATUS_FAIL = "fail"        # nothing fits, replay stops here
STATUS_PENDING = "pending"  # after a failure, not replayed

EXACT = 1.0
LOOSE = 0.97         # matches when ignoring disambiguation, e.g. 'Sd2' for 'Nbd2'
ALT_FACTOR = 0.95    # alternative readings count slightly less than the main one
MIN_SCORE = 0.5      # below this nothing fits
MIN_MARGIN = 0.12    # best must beat the runner-up by this much to be trusted
AUTO_FIX_SCORE = 0.8    # a single look-alike slip scores 0.82 ('e9') to 0.88 ('Sd7')
AUTO_FIX_MARGIN = 0.15  # ...and is only trusted when nothing else is close
MAX_CANDIDATES = 6
BACKTRACK_PLIES = 10    # how far back to look for a misread move
BACKTRACK_CANDIDATES = 6
LOOKAHEAD_PLIES = 12    # how far ahead to test a move chosen for an empty/unreadable cell
LOOKAHEAD_MIN_FIT = 4   # following plies that must fit before a move is proposed
LOOKAHEAD_MARGIN = 0.1  # ...and by how much better than the next best move
LOOKAHEAD_POOL = 16     # how many look-alike moves to test for an uncertain ply
LOOKAHEAD_POOL_MIN = 0.3


def _move_keys(board, move):
    """Return (strict_key, loose_keys) for a legal move, in Swedish form."""
    san = board.san(move)
    strict = handwritten_key(san_to_swedish(san))
    loose = set()
    if board.is_castling(move):
        return strict, loose
    to_sq = chess.square_name(move.to_square)
    from_sq = chess.square_name(move.from_square)
    promo = ""
    if move.promotion:
        promo = san_to_swedish("=" + chess.piece_symbol(move.promotion).upper())[1:]
    piece = board.piece_at(move.from_square)
    if piece.piece_type == chess.PAWN:
        loose.add(to_sq + promo)
        loose.add(from_sq + to_sq + promo)
    else:
        letter = san_to_swedish(piece.symbol().upper())
        loose.add(letter + to_sq)
        loose.add(letter + from_sq + to_sq)
    loose.discard(strict)
    return strict, loose


def _readings(text, alternatives):
    readings = [(handwritten_key(text), 1.0)]
    readings += [(handwritten_key(a), ALT_FACTOR) for a in alternatives or ()]
    return readings


def _score(readings, strict, loose, mirror=True):
    best = 0.0
    for key, weight in readings:
        if not key:
            continue
        if key == strict:
            s = EXACT
        elif key in loose:
            s = LOOSE
        else:
            s = max([similarity(key, strict, mirror)]
                    + [similarity(key, k, mirror) for k in loose])
        best = max(best, s * weight)
    return best


def rank_moves(board, text, alternatives=()):
    """All legal moves, best match first: list of (score, move, san)."""
    return [(score, chess.Move.from_uci(uci), san)
            for score, uci, san in _rank_cached(board.fen(), text or "", tuple(alternatives or ()))]


@lru_cache(maxsize=100000)
def _rank_cached(fen, text, alternatives):
    # Looking ahead tries the same plies in the same positions over and over,
    # and every edit replays the whole game, so this cache matters.
    board = chess.Board(fen)
    readings = _readings(text, alternatives)
    ranked = []
    for move in board.legal_moves:
        strict, loose = _move_keys(board, move)
        ranked.append((_score(readings, strict, loose), move.uci(), board.san(move)))
    ranked.sort(key=lambda r: (-r[0], r[2]))
    return tuple(ranked)


def _needs_mirror(board, move, text, alternatives):
    """True if the move only matches when reading a square mirrored."""
    strict, loose = _move_keys(board, move)
    return _score(_readings(text, alternatives), strict, loose, mirror=False) < AUTO_FIX_SCORE


def _exact_readings(board, text, alternatives):
    """{reading: san} for each reading that on its own matches a legal move
    (ignoring check signs, capture marks and disambiguation)."""
    found = {}
    for reading in [text] + list(alternatives or []):
        if not reading or reading in found:
            continue
        ranked = rank_moves(board, reading)
        if ranked and ranked[0][0] >= LOOSE and (len(ranked) == 1 or ranked[1][0] < ranked[0][0]):
            found[reading] = ranked[0][2]
    return found


def _missing_move_hint(board, text, alternatives):
    """Does the text fit the *other* side? Then a move was probably skipped."""
    if board.is_check():
        return None
    flipped = board.copy(stack=False)
    flipped.push(chess.Move.null())
    ranked = rank_moves(flipped, text, alternatives)
    if ranked and ranked[0][0] >= LOOSE:
        side = "white" if flipped.turn == chess.WHITE else "black"
        return ("'%s' looks like a %s move. A move may be missing before this one, "
                "or white and black may have been swapped." % (text, side))
    return None


def _suggest_earlier_fix(plies, history, fail_index, last_needs=AUTO_FIX_SCORE,
                         question_certain=True):
    """Find an earlier ply whose other reading makes everything up to and
    including `fail_index` fit (that last ply scoring at least `last_needs`).
    `history[j]` is (fen_before, chosen_uci, certain) for the plies already
    played. Clearly read (certain) moves are only questioned when
    `question_certain`: when the later move really doesn't fit."""
    first = max(0, fail_index - BACKTRACK_PLIES)
    for j in range(fail_index - 1, first - 1, -1):
        fen, chosen, certain = history[j]
        if certain and not question_certain:
            continue
        board = chess.Board(fen)
        text = plies[j].get("text") or ""
        alts = plies[j].get("alternatives") or []
        for score, move, san in rank_moves(board, text, alts)[:BACKTRACK_CANDIDATES]:
            if move.uci() == chosen or score < MIN_SCORE:
                continue
            trial = board.copy(stack=False)
            trial.push(move)
            fits = True
            for k in range(j + 1, fail_index + 1):
                ranked = rank_moves(trial, plies[k].get("text") or "",
                                    plies[k].get("alternatives") or [])
                needed = last_needs if k == fail_index else AUTO_FIX_SCORE
                if not ranked or ranked[0][0] < needed:
                    fits = False
                    break
                trial.push(ranked[0][1])
            if fits:
                number = board.fullmove_number
                dots = "." if board.turn == chess.WHITE else "..."
                return {
                    "action": "replace",
                    "index": j,
                    "san": san,
                    "san_sv": san_to_swedish(san),
                    "message": "If move %d%s was %s instead of what is written ('%s'), "
                               "the following moves fit." % (number, dots,
                                                            san_to_swedish(san), text),
                }
    return None


def _following_fit(board, plies, start):
    """How well the plies from `start` on fit: (summed score, count), counting
    in a row until the first ply that doesn't fit (score < AUTO_FIX_SCORE)."""
    board = board.copy(stack=False)
    total, n = 0.0, 0
    for k in range(start, min(len(plies), start + LOOKAHEAD_PLIES)):
        ranked = rank_moves(board, plies[k].get("text") or "", plies[k].get("alternatives") or [])
        if not ranked or ranked[0][0] < AUTO_FIX_SCORE:
            break
        board.push(ranked[0][1])
        total += ranked[0][0]
        n += 1
    return total, n


def _lookahead(board, plies, start):
    """Every legal move, ranked by how well the plies from `start` fit after
    it: list of (fit_score, fit_count, move, san), best first."""
    fits = []
    for move in board.legal_moves:
        san = board.san(move)
        after = board.copy(stack=False)
        after.push(move)
        total, n = _following_fit(after, plies, start)
        fits.append((total, n, move, san))
    fits.sort(key=lambda f: (-f[0], f[3]))
    return fits


def _unique_fit(fits, plies, start):
    """The single move after which the following plies clearly fit best."""
    needed = min(LOOKAHEAD_MIN_FIT, len(plies) - start)
    if not fits or needed <= 0 or fits[0][1] < needed:
        return None
    if len(fits) > 1 and fits[0][0] - fits[1][0] < LOOKAHEAD_MARGIN:
        return None
    return fits[0]


def _candidates(fits):
    return [{"san": san, "san_sv": san_to_swedish(san), "score": None, "fits": n}
            for _, n, _, san in fits[:MAX_CANDIDATES]]


def _needed(plies, start):
    """How many following plies must fit to trust a choice made by looking ahead."""
    return max(1, min(LOOKAHEAD_MIN_FIT, len(plies) - start - 1))


def _pick_by_future(board, plies, i, ranked, rivals):
    """For an uncertain ply: rank plausible moves by how well the following
    plies fit after them (and, second, how well they match the handwriting).

    Returns None if nothing follows, else {move, san, fits, unique, candidates}."""
    if i + 1 >= len(plies):
        return None
    own = {m: s for s, m, _ in ranked}
    needed = _needed(plies, i)

    def score_moves(pool):
        scored = []
        for score, move, san in pool:
            after = board.copy(stack=False)
            after.push(move)
            total, n = _following_fit(after, plies, i + 1)
            scored.append((total + score, n, move, san))
        return scored

    pool = [r for r in ranked if r[0] >= LOOKAHEAD_POOL_MIN][:LOOKAHEAD_POOL]
    pool_moves = {m for _, m, _ in pool}
    pool += [r for r in ranked if r[2] in rivals and r[1] not in pool_moves]
    scored = score_moves(pool)
    if not any(n >= needed for _, n, _, _ in scored):
        # None of the look-alikes lets the game go on: try every legal move.
        scored += score_moves([r for r in ranked if r[1] not in pool_moves])
    scored.sort(key=lambda s: (-s[0], s[3]))
    candidates = [{"san": san, "san_sv": san_to_swedish(san), "score": round(own[move], 2),
                   "fits": n} for _, n, move, san in scored[:MAX_CANDIDATES]]
    best = scored[0]
    unique = best[1] >= needed and (len(scored) == 1 or best[0] - scored[1][0] >= LOOKAHEAD_MARGIN)
    return {"move": best[2], "san": best[3], "fits": best[1], "unique": unique,
            "candidates": candidates}


def _suggest_insert(board, plies, i):
    """A move seems to be missing before ply i: which move makes ply i and
    the ones after it fit?"""
    fits = _lookahead(board, plies, i)
    best = _unique_fit(fits, plies, i) or (fits[0] if fits and fits[0][1] > 0 else None)
    if not best:
        return None
    side = "White" if board.turn == chess.WHITE else "Black"
    return {
        "action": "insert",
        "index": i,
        "san": best[3],
        "san_sv": san_to_swedish(best[3]),
        "fits": best[1],
        "message": "A move seems to be missing here. If %s played %s, the next %d "
                   "moves fit." % (side, san_to_swedish(best[3]), best[1]),
    }


def _new_entry(i, ply, board):
    return {
        "index": i,
        "number": board.fullmove_number,
        "color": "white" if board.turn == chess.WHITE else "black",
        "text": (ply.get("text") or "").strip(),
        "alternatives": [a for a in (ply.get("alternatives") or []) if a],
        "clock": ply.get("clock") or "",
        "written_number": ply.get("written_number"),
        "page": ply.get("page"),
        "confirmed": bool(ply.get("confirmed")),
        "unclear": bool(ply.get("unclear")),
        "corrected": False,
        "mirrored": False,
        "san": None, "san_sv": None, "uci": None,
        "score": 0.0, "candidates": [], "legal": [], "hint": None, "suggestion": None,
        "fen_before": board.fen(), "fen_after": None,
    }


def resolve(plies):
    """Replay plies and pick a legal move for each.

    `plies` is a list of dicts with keys: text, alternatives (optional),
    clock (optional), unclear (optional), confirmed (optional, bool: the user
    picked this move). Returns a dict with the per-ply results and a summary.
    """
    board = chess.Board()
    out = []
    history = []
    stopped = False
    for i, ply in enumerate(plies):
        entry = _new_entry(i, ply, board)
        text, alts = entry["text"], entry["alternatives"]
        out.append(entry)
        if stopped:
            entry["status"] = STATUS_PENDING
            continue

        ranked = rank_moves(board, text, alts)
        entry["legal"] = sorted(san for _, _, san in ranked)
        entry["candidates"] = [
            {"san": san, "san_sv": san_to_swedish(san), "score": round(s, 2)}
            for s, _, san in ranked[:MAX_CANDIDATES]
        ]
        if not ranked:  # game already over (mate/stalemate) but more moves written
            entry["status"] = STATUS_FAIL
            entry["hint"] = "The game is already over in this position."
            stopped = True
            continue

        best_score, best_move, best_san = ranked[0]
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        margin = best_score - runner_up
        entry["score"] = round(best_score, 2)

        mirrored = best_score < LOOSE and _needs_mirror(board, best_move, text, alts)
        entry["mirrored"] = mirrored
        # Readings (e.g. from two models) that each fit a legal move exactly.
        exact = _exact_readings(board, text, alts)
        rivals = sorted(set(exact.values()))

        if not text and not alts:
            # Nothing written: let the following moves decide.
            fits = _lookahead(board, plies, i + 1)
            entry["candidates"] = _candidates(fits)
            unique = _unique_fit(fits, plies, i + 1)
            if unique is None:
                entry["status"] = STATUS_FAIL
                entry["hint"] = ("Nothing was read here. Pick the move from the list; "
                                 "the ones that fit the following moves are first.")
                stopped = True
                continue
            best_move, best_san = unique[2], unique[3]
            entry["status"] = STATUS_CHECK
            entry["hint"] = ("Nothing was read here, but only %s fits the following moves. "
                             "Please confirm." % san_to_swedish(best_san))
        elif entry["confirmed"]:
            if best_score < LOOSE:
                entry["status"] = STATUS_FAIL
                entry["hint"] = "%s is not a legal move here." % text
                stopped = True
                continue
            entry["status"] = STATUS_OK
        elif len(rivals) == 1 and best_san in rivals:
            entry["status"] = STATUS_OK
            if text not in exact:
                # The main reading doesn't fit, but another reading fits exactly.
                entry["corrected"] = True
                entry["hint"] = "Read as '%s' or '%s'; only %s fits." % (
                    text, "' or '".join(exact), san_to_swedish(best_san))
        elif not rivals and best_score >= LOOSE and margin > 0:
            entry["status"] = STATUS_OK
        elif (not rivals and not mirrored and not entry["unclear"]
              and best_score >= AUTO_FIX_SCORE and margin >= AUTO_FIX_MARGIN):
            # A small slip (e.g. a 4 that looks like a 9) with no competitor.
            entry["status"] = STATUS_OK
            entry["corrected"] = True
            entry["hint"] = "Read as '%s', corrected to %s." % (text, san_to_swedish(best_san))
        else:
            # Unsure. Let the following moves help: a misread move usually
            # makes the next few moves impossible, the right one doesn't.
            pick = _pick_by_future(board, plies, i, ranked, rivals)
            insert = None
            if best_score < LOOSE and _missing_move_hint(board, text, alts):
                insert = _suggest_insert(board, plies, i)
                if insert and pick and insert["fits"] <= pick["fits"]:
                    insert = None  # a misreading explains it better than a missing move
            if pick:
                entry["candidates"] = pick["candidates"]
            if insert and insert["fits"] >= _needed(plies, i):
                entry["status"] = STATUS_FAIL
                entry["hint"] = ("'%s' looks like a %s move. A move may be missing before this "
                                 "one, or white and black may have been swapped."
                                 % (text, "black" if board.turn == chess.WHITE else "white"))
                entry["suggestion"] = insert
                stopped = True
                continue
            if pick and pick["unique"]:
                best_move, best_san = pick["move"], pick["san"]
                entry["status"] = STATUS_CHECK
                if len(rivals) > 1:
                    entry["hint"] = "The readings differ: %s. %s fits the following moves best." % (
                        " or ".join("'%s'" % r for r in exact), san_to_swedish(best_san))
                elif best_score < MIN_SCORE or pick["move"] != ranked[0][1]:
                    entry["hint"] = ("'%s' doesn't fit, but %s fits the following moves. "
                                     "Please confirm." % (text, san_to_swedish(best_san)))
                elif mirrored:
                    entry["hint"] = ("'%s' doesn't fit, but %s does if a square was written "
                                     "mirrored (like c/f or 2/7). Please confirm."
                                     % (text, san_to_swedish(best_san)))
                else:
                    entry["hint"] = "Read as '%s', interpreted as %s. Please confirm." % (
                        text, san_to_swedish(best_san))
            elif pick and pick["fits"] < _needed(plies, i):
                # Whatever is chosen here, the following moves stop making sense:
                # stop, so there's one clear thing to fix instead of a cascade.
                entry["status"] = STATUS_FAIL
                entry["hint"] = ("No move fits both '%s' and the moves after it. Pick the right "
                                 "move from the list; the ones that fit the following moves "
                                 "are first." % text)
                entry["suggestion"] = insert or _suggest_earlier_fix(plies, history, i)
                stopped = True
                continue
            elif len(rivals) > 1:
                entry["status"] = STATUS_CHECK
                entry["hint"] = "The readings differ: %s. Which one is right?" % " or ".join(
                    "'%s' (%s)" % (reading, san_to_swedish(san)) for reading, san in exact.items())
            elif best_score >= MIN_SCORE:
                entry["status"] = STATUS_CHECK
                if mirrored:
                    entry["hint"] = ("'%s' doesn't fit, but %s does if a square was written "
                                     "mirrored (like c/f or 2/7). Please confirm."
                                     % (text, san_to_swedish(best_san)))
                elif margin < MIN_MARGIN:
                    entry["hint"] = "Several moves fit '%s'. Is %s right?" % (
                        text, san_to_swedish(best_san))
                else:
                    entry["hint"] = "Read as '%s', interpreted as %s." % (
                        text, san_to_swedish(best_san))
            else:
                entry["status"] = STATUS_FAIL
                entry["hint"] = "No legal move matches '%s'. Pick the right move from the list." % text
                entry["suggestion"] = insert or _suggest_earlier_fix(plies, history, i)
                stopped = True
                continue

        if entry["status"] == STATUS_CHECK and text:
            # Would a different reading of an earlier move make this one exact?
            # A clearly read earlier move is only questioned if this one doesn't
            # really fit (e.g. only after mirroring), not when it merely fits
            # in more than one way ("Sd7": which knight?).
            entry["suggestion"] = _suggest_earlier_fix(
                plies, history, i, last_needs=LOOSE, question_certain=best_score < LOOSE)

        entry["san"] = best_san
        entry["san_sv"] = san_to_swedish(best_san)
        entry["uci"] = best_move.uci()
        # Clearly read: OK, not auto-corrected, and the readings agreed.
        certain = entry["status"] == STATUS_OK and not entry["corrected"] and not entry["unclear"]
        history.append((board.fen(), best_move.uci(), certain))
        board.push(best_move)
        entry["fen_after"] = board.fen()

    counts = {s: 0 for s in (STATUS_OK, STATUS_CHECK, STATUS_FAIL, STATUS_PENDING)}
    for e in out:
        counts[e["status"]] += 1
    return {
        "plies": out,
        "counts": counts,
        "complete": counts[STATUS_FAIL] == 0 and counts[STATUS_PENDING] == 0,
        "final_fen": board.fen(),
        "checkmate": board.is_checkmate(),
        "next_number": board.fullmove_number,
        "next_color": "white" if board.turn == chess.WHITE else "black",
    }
