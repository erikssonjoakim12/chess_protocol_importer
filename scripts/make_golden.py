"""Write the expected answers that the JavaScript version is checked against.

The Python version is the reference: whatever it makes of a scoresheet, the
browser version must make exactly the same of it (the same moves, flags,
hints and PGN text).

    .venv/Scripts/python scripts/make_golden.py

writes
    web/tests/golden/public.json      public-domain games with simulated
                                      handwriting slips (safe to commit)
    tests/private/golden.json         real scoresheets and real Gemini
                                      readings, when tests/private exists
                                      (never committed)
"""
import glob
import json
import os
import random
import sys

import chess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.notation import LOOKALIKE, MIRROR, san_to_swedish  # noqa: E402
from app.pgn_builder import derive_result, time_control_to_pgn  # noqa: E402
from app.readers.base import (combine_readings, flatten, normalize_reading,  # noqa: E402
                              parse_written_date)
from app.readers.gemini import _merge_pages  # noqa: E402
from app.resolver import resolve  # noqa: E402
from app.service import process  # noqa: E402

PUBLIC_OUT = os.path.join(ROOT, "web", "tests", "golden", "public.json")
PRIVATE_DIR = os.path.join(ROOT, "tests", "private")
PRIVATE_OUT = os.path.join(PRIVATE_DIR, "golden.json")

# Famous games, all public domain.
GAMES = {
    "opera": "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 "
             "Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#",
    "immortal": "e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 "
                "Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ "
                "Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#",
    "evergreen": "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d3 Qb3 Qf6 e5 Qg6 Re1 Nge7 "
                 "Ba3 b5 Qxb5 Rb8 Qa4 Bb6 Nbd2 Bb7 Ne4 Qf5 Bxd3 Qh5 Nf6+ gxf6 exf6 Rg8 Rad1 "
                 "Qxf3 Rxe7+ Nxe7 Qxd7+ Kxd7 Bf5+ Ke8 Bd7+ Kf8 Bxe7#",
}


def random_game(rng, plies):
    board = chess.Board()
    sans = []
    while len(sans) < plies and not board.is_game_over():
        move = rng.choice(sorted(board.legal_moves, key=lambda m: m.uci()))
        sans.append(board.san(move))
        board.push(move)
    return " ".join(sans)


def handwritten(san, rng):
    """How a player might write the move: Swedish, often without + or x."""
    text = san_to_swedish(san)
    if rng.random() < 0.5:
        text = text.replace("+", "").replace("#", "")
    if rng.random() < 0.15:
        text = text.replace("x", "")
    if text.startswith("O-O"):
        text = text.replace("O", "0")
    return text


LOOK = sorted("".join(sorted(p)) for p in LOOKALIKE)
MIRR = sorted("".join(sorted(p)) for p in MIRROR)


def swap_char(text, pairs, rng):
    spots = [(i, p) for i, ch in enumerate(text) for p in pairs if ch in p]
    if not spots:
        return text
    i, pair = rng.choice(spots)
    other = pair[1] if text[i] == pair[0] else pair[0]
    return text[:i] + other + text[i + 1:]


def noisy_plies(sans, rng, ops):
    plies = [{"text": handwritten(s, rng), "alternatives": [], "clock": "", "unclear": False}
             for s in sans]
    if rng.random() < 0.4:
        for p in plies:
            if rng.random() < 0.2:
                p["clock"] = str(rng.randint(0, 90))
    log = []
    for _ in range(ops):
        if not plies:
            break
        i = rng.randrange(len(plies))
        op = rng.choice(["lookalike", "lookalike", "mirror", "delete", "blank",
                         "second_reading", "second_reading", "unclear"])
        log.append("%s@%d" % (op, i))
        p = plies[i]
        if op == "lookalike":
            p["text"] = swap_char(p["text"], LOOK, rng)
        elif op == "mirror":
            p["text"] = swap_char(p["text"], MIRR, rng)
        elif op == "delete":
            del plies[i]
        elif op == "blank":
            p["text"] = ""
        elif op == "second_reading":
            other = swap_char(p["text"], LOOK + MIRR, rng)
            if other != p["text"]:
                p["alternatives"] = [other]
                p["unclear"] = True
        elif op == "unclear":
            p["unclear"] = True
    return plies, log


def summarize(resolution):
    """What must match between the versions (scores are left out: they are
    only shown, and rounding differs between languages)."""
    return {
        "counts": resolution["counts"],
        "complete": resolution["complete"],
        "checkmate": resolution["checkmate"],
        "plies": [{
            "status": p["status"], "san": p["san"], "uci": p["uci"],
            "corrected": p["corrected"], "mirrored": p["mirrored"], "hint": p["hint"],
            "suggestion": p["suggestion"] and {k: p["suggestion"][k] for k in
                                               ("action", "index", "san", "message")},
            "candidates": [c["san"] for c in p["candidates"]],
            "number": p["number"], "color": p["color"],
        } for p in resolution["plies"]],
    }


def resolve_case(name, plies, headers=None, end_marker=None):
    out = process(dict(headers or {}), plies, end_marker)
    return {"name": name, "kind": "process",
            "input": {"plies": plies, "headers": headers or {}, "end_marker": end_marker},
            "expected": {"resolution": summarize(out["resolution"]), "pgn": out["pgn"],
                         "result": out["result"], "derived_result": out["derived_result"],
                         "result_warning": out["result_warning"]}}


def reading_case(name, pages_by_model):
    """pages_by_model: for each page, the raw answers of the models that read it.
    Mirrors what the Gemini reader does: combine per page, merge the pages,
    then the normal pipeline."""
    per_page = [combine_readings(models) for models in pages_by_model]
    merged = per_page[0] if len(per_page) == 1 else _merge_pages(per_page)
    reading = normalize_reading(merged)
    headers = dict(reading["headers"])
    out = process(headers, flatten(reading), reading["end_marker"])
    return {"name": name, "kind": "reading", "input": {"pages_by_model": pages_by_model},
            "expected": {"reading": reading, "resolution": summarize(out["resolution"]),
                         "pgn": out["pgn"], "result": out["result"],
                         "result_warning": out["result_warning"]}}


def public_cases():
    rng = random.Random(20261010)
    cases = []
    games = dict(GAMES)
    for n in range(6):
        games["random%d" % n] = random_game(rng, rng.randint(40, 120))
    for name, moves in games.items():
        sans = moves.split()
        clean = [{"text": handwritten(s, rng), "alternatives": [], "clock": "", "unclear": False}
                 for s in sans]
        cases.append(resolve_case(name + "/clean", clean))
        for k in range(8):
            plies, log = noisy_plies(sans, rng, rng.randint(1, 3))
            cases.append(resolve_case("%s/noisy%d %s" % (name, k, " ".join(log)), plies))
    # The user picked moves from the list (confirmed), including a wrong one.
    plies = [{"text": t} for t in "e4 e5 Sf3 Sc6".split()]
    plies[2]["confirmed"] = True
    cases.append(resolve_case("confirmed", plies))
    cases.append(resolve_case("confirmed-illegal", [{"text": "Nbd2", "confirmed": True}]))
    # Headers, results and end words through the whole pipeline.
    with open(os.path.join(ROOT, "tests", "fixtures", "demo_reading.json"), encoding="utf-8") as f:
        demo = json.load(f)
    cases.append(reading_case("demo", [[demo]]))
    junk = dict(demo, headers=dict(demo["headers"], white_team="Norrby SK 6 0/1?? (Not entirely clear",
                                   black_team="Söderby SS", date="", date_raw="6/10-2026",
                                   white_elo="1850 1850", time_control="60 min (+30s/drag)"))
    other = dict(demo, headers=dict(demo["headers"], white_team="Norrby SK Krub", black="",
                                    black_team="Söderby SS"))
    cases.append(reading_case("two-models-junk-headers", [[junk, other]]))
    second = {"headers": {"round": "3"}, "pages": [{"rows": [
        {"number": 1, "white": {"move": "Td8+"}, "black": {"move": "tid."}}]}]}
    first = dict(demo, pages=[{"rows": demo["pages"][0]["rows"][:16]}])
    cases.append(reading_case("two-pages-end-word", [[first], [second]]))
    return cases


def private_cases():
    cases = []
    fixture = os.path.join(PRIVATE_DIR, "game1_reading.json")
    if os.path.exists(fixture):
        with open(fixture, encoding="utf-8") as f:
            game1 = json.load(f)
        cases.append(reading_case("game1", [[game1]]))
        plies = flatten(normalize_reading(game1))
        cases.append(resolve_case("game1/missing-move", plies[:2] + plies[3:]))
        blank = [dict(p) for p in plies]
        blank[24] = dict(blank[24], text="")
        cases.append(resolve_case("game1/blank", blank))
    # Real Gemini answers saved while benchmarking: raw_<run>_<model>.txt
    raw_dir = os.path.join(PRIVATE_DIR, "raw_readings")
    runs = {}
    for path in sorted(glob.glob(os.path.join(raw_dir, "raw_*.txt"))):
        run = os.path.basename(path).split("_")[1]
        try:
            with open(path, encoding="utf-8") as f:
                runs.setdefault(run, []).append(json.load(f))
        except ValueError:
            continue
    for run, answers in sorted(runs.items()):
        cases.append(reading_case("raw/" + run, [answers]))
    # Real resolved readings saved while benchmarking: out_<label>_<game>.json
    for path in sorted(glob.glob(os.path.join(raw_dir, "out_*.json"))):
        with open(path, encoding="utf-8") as f:
            saved = json.load(f)
        plies = [{k: p[k] for k in ("text", "alternatives", "unclear", "clock")}
                 for p in saved["resolution"]["plies"]]
        cases.append(resolve_case("out/" + os.path.basename(path), plies))
    return cases


def small_function_cases():
    """Plain input -> output pairs for the helper functions."""
    texts = ["60 min + 30s/move", "60 min (+30s/drag)", "90 min + 30 sek",
             "2 tim/40 drag 1 tim/20 30 min", "3600+30", "", "blixt", "1 h 30 min",
             "15+10", "25 min", "90 min/40 drag + 30 min + 30 s"]
    dates = ["6/10-2026", "8/10 2026", "2/7-06", "30/6-2025", "13/10 2006", "hmm",
             "13.10.2006", "32/1-2020", "1/13-2020", "8 / 10 - 2026"]
    results = [
        ({"white_score": "1", "black_score": "0"}, None, None),
        ({"white_score": "½", "black_score": "½"}, None, None),
        ({}, {"text": "uppg.", "column": "white"}, None),
        ({}, {"text": "tid.", "column": "black"}, None),
        ({}, {"text": "remi", "column": "white"}, None),
        ({"white_score": "1", "black_score": "0"}, {"text": "uppg.", "column": "white"}, None),
        ({}, None, "black"),
        ({}, None, None),
    ]
    return {
        "time_control": [[t, time_control_to_pgn(t)] for t in texts],
        "written_date": [[d, parse_written_date(d)] for d in dates],
        "derive_result": [[h, e, m, list(derive_result(h, e, m))] for h, e, m in results],
    }


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote %s (%d cases)" % (os.path.relpath(path, ROOT), len(data["cases"])))


if __name__ == "__main__":
    write(PUBLIC_OUT, {"cases": public_cases(), "functions": small_function_cases()})
    if os.path.isdir(PRIVATE_DIR):
        write(PRIVATE_OUT, {"cases": private_cases()})
