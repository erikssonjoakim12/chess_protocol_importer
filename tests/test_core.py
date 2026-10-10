import io
import json
import os

import chess.pgn
import pytest
from fastapi.testclient import TestClient

from app.notation import handwritten_key, san_to_swedish
from app.pgn_builder import clock_seconds, derive_result, time_control_to_pgn
from app.readers import combine_readings, flatten, normalize_reading
from app.readers.base import is_end_word
from app.resolver import STATUS_CHECK, STATUS_FAIL, STATUS_OK, STATUS_PENDING, resolve
from app.service import process, read_photos

ROOT = os.path.dirname(os.path.dirname(__file__))
# A public demo game (Morphy's Opera Game, 1858) written with typical slips.
DEMO = os.path.join(ROOT, "tests", "fixtures", "demo_reading.json")
DEMO_MOVES = ("e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 "
              "Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#")
# Real games from real scoresheets. Kept out of git (private), so these tests
# only run where the files exist.
FIXTURE = os.path.join(ROOT, "tests", "private", "game1_reading.json")
REFERENCE = os.path.join(ROOT, "tests", "private", "game1_expected.pgn")
needs_private_data = pytest.mark.skipif(
    not (os.path.exists(FIXTURE) and os.path.exists(REFERENCE)),
    reason="private test data (real scoresheets) not available")


def plies(*texts):
    return [{"text": t} for t in texts]


@pytest.mark.parametrize("text,key", [
    ("Sxd4+", "Sd4"), ("Nbd2", "Sbd2"), ("exd5", "ed5"), ("0-0", "O-O"),
    ("0-0-0", "O-O-O"), ("o-o", "O-O"), ("e8=D", "e8D"), ("e8Q", "e8D"),
    ("Dxd8+", "Dd8"), ("sf3", "Sf3"), ("  Lb2 ", "Lb2"), ("", ""),
])
def test_handwritten_key(text, key):
    assert handwritten_key(text) == key


def test_san_to_swedish():
    assert san_to_swedish("Nxe4+") == "Sxe4+"
    assert san_to_swedish("e8=Q#") == "e8=D#"
    assert san_to_swedish("Bb2") == "Lb2"
    assert san_to_swedish("bxc3") == "bxc3"


def test_demo_game_gives_expected_pgn():
    with open(DEMO, encoding="utf-8") as f:
        reading = normalize_reading(json.load(f))
    out = process(dict(reading["headers"]), flatten(reading), reading["end_marker"])
    assert out["resolution"]["complete"]
    game = chess.pgn.read_game(io.StringIO(out["pgn"]))
    board = game.board()
    sans = []
    for move in game.mainline_moves():
        sans.append(board.san(move))
        board.push(move)
    assert " ".join(sans) == DEMO_MOVES
    assert out["result"] == "1-0" and game.headers["White"] == "Paul Morphy"
    assert "[%clk 0:30:00]" in out["pgn"]


@needs_private_data
def test_real_game_matches_lichess_reference():
    with open(FIXTURE, encoding="utf-8") as f:
        reading = normalize_reading(json.load(f))
    out = process(dict(reading["headers"]), flatten(reading), reading["end_marker"])
    assert out["resolution"]["complete"]
    assert out["result"] == "1-0"
    with open(REFERENCE, encoding="utf-8") as f:
        ref = chess.pgn.read_game(f)
    mine = chess.pgn.read_game(io.StringIO(out["pgn"]))
    assert list(mine.mainline_moves()) == list(ref.mainline_moves())
    for tag in ("Date", "Round", "White", "Black", "Result", "WhiteElo",
                "BlackElo", "WhiteTeam", "BlackTeam", "Board"):
        assert mine.headers[tag] == ref.headers[tag], tag


def test_handwriting_slip_is_corrected():
    r = resolve(plies("e9", "e5"))  # 9 for 4
    assert r["plies"][0]["san"] == "e4"
    assert r["plies"][0]["status"] == STATUS_OK


def test_check_sign_and_capture_are_added():
    r = resolve(plies("e4", "f5", "exf5", "g5", "Dh5"))
    assert r["plies"][4]["san"] == "Qh5#"
    assert r["checkmate"]


def test_underspecified_move_is_flagged():
    # Both knights can go to d2: 'Sd2' must be reviewed.
    r = resolve(plies("d4", "d5", "Sf3", "Sf6", "Sc3", "Sc6", "Lf4", "Lf5",
                      "e3", "e6", "Sb1", "Sb8", "Sd2"))
    last = r["plies"][-1]
    assert last["status"] == STATUS_CHECK
    assert {c["san"] for c in last["candidates"][:2]} == {"Nbd2", "Nfd2"}


def test_missing_move_stops_and_hints():
    # Black's reply to 1.e4 is missing, so 'Sf3' lands in black's column.
    r = resolve(plies("e4", "Sf3", "Sc6"))
    second = r["plies"][1]
    assert second["status"] == STATUS_FAIL
    assert "missing" in second["hint"]
    assert r["plies"][2]["status"] == STATUS_PENDING
    assert not r["complete"]


def test_confirmed_move_is_ok():
    r = resolve([{"text": "Nbd2", "confirmed": True}])
    assert r["plies"][0]["status"] == STATUS_FAIL  # not legal on move 1
    r = resolve([{"text": "Sf3", "confirmed": True}])
    assert r["plies"][0]["status"] == STATUS_OK


def test_mirrored_square_is_flagged_not_fixed():
    # 'Lf4' is impossible; Lc4 fits if c/f was mirrored. Must be confirmed.
    r = resolve(plies("e4", "e5", "Sf3", "Sc6", "Lf4"))
    last = r["plies"][-1]
    assert last["san"] == "Bc4"
    assert last["mirrored"] and last["status"] == STATUS_CHECK
    r = resolve(plies("e4", "e5", "Sf3", "Sc6", "Lc4"))
    assert not r["plies"][-1]["mirrored"]


def test_plain_lookalike_is_not_called_mirrored():
    r = resolve(plies("e9"))
    assert not r["plies"][0]["mirrored"]


def test_earlier_misread_is_suggested():
    # 2.Sc3 is legal but was really 2.Sf3 (c/f mirrored); 3.Sxe5 exposes it.
    r = resolve(plies("e4", "e5", "Sc3", "Sc6", "Sxe5"))
    suggestion = next(p["suggestion"] for p in r["plies"] if p["suggestion"])
    assert suggestion["index"] == 2 and suggestion["san"] == "Nf3"


def _real_game_plies():
    with open(FIXTURE, encoding="utf-8") as f:
        return flatten(normalize_reading(json.load(f)))


@needs_private_data
def test_forgotten_move_suggests_insert():
    ps = _real_game_plies()
    del ps[2]  # 2.g3 was never written down
    r = resolve(ps)
    fail = r["plies"][2]
    assert fail["status"] == STATUS_FAIL
    assert fail["suggestion"]["action"] == "insert"
    assert fail["suggestion"]["san"] == "g3"


@needs_private_data
def test_blank_cell_candidates_ranked_by_following_moves():
    ps = _real_game_plies()
    ps[24] = {"text": ""}  # 13.Na2 unreadable
    r = resolve(ps)
    assert r["plies"][24]["candidates"][0]["san"] == "Na2"


def test_blank_cell_filled_when_only_one_move_fits():
    # 1.e4 e5 2.? Nc6 3.Bb5: the blank must be a move that keeps e4, lets
    # black play Nc6 and white Bb5... and then 3...a6 4.Bxc6 dxc6 5.Nxe5 needs Nf3.
    r = resolve(plies("e4", "e5", "", "Sc6", "Lb5", "a6", "Lxc6", "dxc6", "Sxe5"))
    blank = r["plies"][2]
    assert blank["san"] == "Nf3" and blank["status"] == STATUS_CHECK
    assert r["complete"]


def _cell(move):
    return {"move": move}


def test_two_readings_agreeing_is_ok():
    a = {"pages": [{"rows": [{"number": 1, "white": _cell("e4"), "black": _cell("e5")}]}]}
    combined = combine_readings([a, a])
    r = resolve(flatten(combined))
    assert [p["status"] for p in r["plies"]] == [STATUS_OK, STATUS_OK]


def test_two_legal_readings_that_differ_are_flagged():
    # Like the real case where one model read Lf5 and the other Le5: both
    # readings are legal moves, so the engine can't tell. Ask the user.
    a = {"pages": [{"rows": [{"number": 1, "white": _cell("d4"), "black": _cell("d5")},
                             {"number": 2, "white": _cell("c4"), "black": _cell("Lf5")}]}]}
    b = {"pages": [{"rows": [{"number": 1, "white": _cell("d4"), "black": _cell("d5")},
                             {"number": 2, "white": _cell("c4"), "black": _cell("Lg4")}]}]}
    r = resolve(flatten(combine_readings([a, b])))
    last = r["plies"][-1]
    assert last["status"] == STATUS_CHECK
    assert {c["san"] for c in last["candidates"][:2]} == {"Bf5", "Bg4"}


def test_only_one_reading_legal_is_taken():
    a = {"pages": [{"rows": [{"number": 1, "white": _cell("e9"), "black": None}]}]}
    b = {"pages": [{"rows": [{"number": 1, "white": _cell("e4"), "black": None}]}]}
    r = resolve(flatten(combine_readings([a, b])))
    assert r["plies"][0]["san"] == "e4" and r["plies"][0]["status"] == STATUS_OK


def test_cell_missed_by_one_reading_is_kept():
    a = {"pages": [{"rows": [{"number": 1, "white": _cell("Sf3"), "black": None}]}]}
    b = {"pages": [{"rows": [{"number": 1, "white": _cell("Sf3"), "black": _cell("d5")}]}]}
    combined = combine_readings([a, b])
    black = combined["pages"][0]["rows"][0]["black"]
    assert black["move"] == "d5" and black["unclear"]


def test_alternative_readings_are_used():
    r = resolve([{"text": "Zq3", "alternatives": ["Sf3"]}])
    assert r["plies"][0]["san"] == "Nf3"


def test_second_page_restarting_at_one_is_concatenated():
    reading = normalize_reading({"pages": [
        {"rows": [{"number": 1, "white": {"move": "e4"}, "black": {"move": "e5"}}]},
        {"rows": [{"number": 1, "white": {"move": "Sf3"}, "black": {"move": "Sc6"}}]},
    ]})
    r = resolve(flatten(reading))
    assert [p["san"] for p in r["plies"]] == ["e4", "e5", "Nf3", "Nc6"]
    assert r["plies"][2]["number"] == 2


def test_repeated_partial_row_is_merged():
    # Seen from Gemini: row 1 once with only white's move, then complete.
    reading = normalize_reading({"pages": [{"rows": [
        {"number": 1, "white": {"move": "c4"}, "black": None},
        {"number": 1, "white": {"move": "c4"}, "black": {"move": "e6"}},
        {"number": 2, "white": {"move": "g3"}, "black": {"move": "d5"}},
    ]}]})
    assert [p["text"] for p in flatten(reading)] == ["c4", "e6", "g3", "d5"]


@pytest.mark.parametrize("word,column,expected", [
    ("tid.", "black", "1-0"), ("uppg.", "white", "0-1"), ("remi", "white", "1/2-1/2"),
])
def test_end_word_in_move_cell_becomes_end_marker(word, column, expected):
    row = {"number": 2, "white": _cell("Sf3"), "black": _cell(word)} if column == "black" \
        else {"number": 2, "white": _cell(word), "black": None}
    reading = normalize_reading({"pages": [{"rows": [
        {"number": 1, "white": _cell("e4"), "black": _cell("e5")}, row,
        {"number": 3, "white": _cell("Kalle"), "black": None},  # a signature
    ]}]})
    assert reading["end_marker"]["text"] == word
    assert all(not is_end_word(p["text"]) for p in flatten(reading))
    assert "Kalle" not in [p["text"] for p in flatten(reading)]
    assert derive_result({}, reading["end_marker"])[0] == expected


def test_looping_reader_junk_is_cut_from_headers():
    # Seen from gemini-3.5-flash-lite on a test sheet.
    junk = "Norrby SK 64016140406830500" + "0" * 3000 + " REDUCTION 3/40. (Wait, I see 40."
    reading = normalize_reading({"headers": {
        "white_team": junk, "white_elo": "1850 1850 1850", "round": "3" + "3" * 50,
        "date": "2026.10.06 (written 6/10-2026)", "white": "Anna Andersson\nKlubb: Norrby"}})
    h = reading["headers"]
    assert h["white_team"] == "Norrby SK"
    assert h["white_elo"] == "1850"
    assert h["round"] == ""          # nothing sane left
    assert h["date"] == "2026.10.06"
    assert h["white"] == "Anna Andersson"


@pytest.mark.parametrize("raw,clean", [
    # Real outputs from gemini-3.1-flash-lite "thinking aloud" in the club field.
    ("Norrby SK 6 0/1?? (Not entirely clear where score is, looks like 0 and 1", "Norrby SK"),
    ("Norrby SKкubbe Norrby SK (written as Norrby SK, with 1850 above", "Norrby SK"),
    ("Norrby SK 1850 Norrbi SK 6 10-2026 (blank is 1) 0 (the 0 is", "Norrby SK"),
    ("Söderby SS", "Söderby SS"),
    ("SK Springaren", "SK Springaren"),
])
def test_thinking_aloud_is_cut_from_club(raw, clean):
    headers = normalize_reading({"headers": {"white_team": raw}})
    assert headers["headers"]["white_team"] == clean
    assert ("white_team" in headers["header_flags"]) == (raw != clean)


def test_time_control_keeps_brackets():
    h = normalize_reading({"headers": {"time_control": "60 min (+30s/drag)"}})["headers"]
    assert h["time_control"] == "60 min (+30s/drag)"


@pytest.mark.parametrize("raw,date", [
    ("6/10-2026", "2026.10.06"), ("8/10 2026", "2026.10.08"), ("2/7-06", "2006.07.02"),
    ("30/6-2025", "2025.06.30"), ("13/10 2006", "2006.10.13"), ("hmm", ""),
])
def test_written_date_is_parsed_when_formatted_date_missing(raw, date):
    h = normalize_reading({"headers": {"date_raw": raw}})["headers"]
    assert h["date"] == date


def test_formatted_date_disagreeing_with_handwriting_is_flagged():
    r = normalize_reading({"headers": {"date": "2024.10.08", "date_raw": "8/10 2026"}})
    assert "date" in r["header_flags"]


def test_any_value_beats_an_empty_one():
    # One reading stalled before black's details; the other has them.
    a = {"headers": {"white": "Anna Andersson", "white_team": "Norrby SK"}, "pages": []}
    b = {"headers": {"white": "Anna Andersson", "black": "Bertil Berg",
                     "black_team": "Söderby SS", "white_team": "Norrby SK Krub"}, "pages": []}
    h = combine_readings([a, b])["headers"]
    assert h["black"] == "Bertil Berg" and h["black_team"] == "Söderby SS"
    assert h["white_team"] == "Norrby SK"


def test_two_readings_prefer_the_value_they_agree_on():
    a = {"headers": {"white_team": "Norrby SK" + "0" * 40}, "pages": []}
    b = {"headers": {"white_team": "Norrby SK"}, "pages": []}
    c = {"headers": {"white_team": "Norrby K"}, "pages": []}
    assert combine_readings([c, a, b])["headers"]["white_team"] == "Norrby SK"


def test_quotes_in_tags_keep_pgn_valid():
    pgn = process({"white": 'Anna "Annie" Andersson'}, [])["pgn"]
    game = chess.pgn.read_game(io.StringIO(pgn))
    assert game.headers["White"] == 'Anna "Annie" Andersson'


def test_row_with_only_black_move_keeps_colours_in_step():
    reading = normalize_reading({"pages": [{"rows": [
        {"number": 1, "white": {"move": "e4"}, "black": {"move": "e5"}},
        {"number": 2, "white": None, "black": {"move": "Sc6"}},
    ]}]})
    flat = flatten(reading)
    assert [p["text"] for p in flat] == ["e4", "e5", "", "Sc6"]


@pytest.mark.parametrize("text,pgn", [
    ("60 min + 30s/move", "3600+30"),
    ("60 min (+30s/drag)", "3600+30"),
    ("90 min + 30 sek", "5400+30"),
    ("2 tim/40 drag 1 tim/20 30 min", "40/7200:20/3600:1800"),
    ("3600+30", "3600+30"),
    ("", ""),
    ("blixt", "blixt"),
])
def test_time_control(text, pgn):
    assert time_control_to_pgn(text) == pgn


def test_clock_seconds():
    assert clock_seconds("42") == 42 * 60
    assert clock_seconds("0") == 30
    assert clock_seconds("") is None


@pytest.mark.parametrize("headers,end,expected", [
    ({"white_score": "1", "black_score": "0"}, None, "1-0"),
    ({"white_score": "½", "black_score": "½"}, None, "1/2-1/2"),
    ({}, {"text": "uppg.", "column": "white"}, "0-1"),
    ({}, {"text": "uppg.", "column": "black"}, "1-0"),
    ({}, {"text": "tid.", "column": "black"}, "1-0"),
    ({}, {"text": "remi", "column": "white"}, "1/2-1/2"),
    ({}, None, "*"),
])
def test_derive_result(headers, end, expected):
    assert derive_result(headers, end)[0] == expected


def test_conflicting_result_warns():
    result, warning = derive_result({"white_score": "1", "black_score": "0"},
                                    {"text": "uppg.", "column": "white"})
    assert result == "1-0" and warning


def test_api_read_and_process(monkeypatch):
    monkeypatch.setenv("READER", "mock")
    from app.main import app
    client = TestClient(app)
    res = client.post("/api/read", files=[("files", ("p1.jpg", b"fake", "image/jpeg"))])
    assert res.status_code == 200
    data = res.json()
    assert data["headers"]["white"] == "Paul Morphy"
    assert data["pgn"].rstrip().endswith("17. Rd8# 1-0")

    plies = [{"text": p["text"], "clock": p["clock"]} for p in data["resolution"]["plies"]]
    del plies[1]  # drop 1...e5: everything after should shift and fail
    res = client.post("/api/process", json={"headers": data["headers"], "plies": plies})
    assert res.status_code == 200
    assert not res.json()["resolution"]["complete"]


def test_read_photos_with_mock_reader():
    out = read_photos([], "mock")
    assert out["reader"] == "mock"
    assert out["headers"]["result"] == "1-0"


def test_gemini_retries_then_falls_back(monkeypatch):
    from app.readers import gemini
    monkeypatch.setattr(gemini, "RETRY_PAUSES", [0, 0])
    monkeypatch.setattr(gemini.time, "sleep", lambda s: None)
    calls = []

    def fake_post(self, model, body):
        calls.append(model)
        if model == "main":
            raise gemini._Busy(503, "high demand")
        return {"candidates": [{"content": {"parts": [{"text": '{"headers": {}, "pages": []}'}]}}]}

    monkeypatch.setattr(gemini.GeminiReader, "_post", fake_post)
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "backup")
    reader = gemini.GeminiReader(api_key="x", models=["main"])
    assert reader.read([(b"img", "image/jpeg")])["pages"] == []
    assert calls == ["main", "main", "main", "backup"]
    assert reader.used_models == {"backup"}


def test_gemini_gives_clear_error_when_all_busy(monkeypatch):
    from app.readers import gemini
    from app.readers.base import ReaderError
    monkeypatch.setattr(gemini, "RETRY_PAUSES", [0])
    monkeypatch.setattr(gemini.time, "sleep", lambda s: None)

    def busy(self, model, body):
        raise gemini._Busy(503, "high demand")

    monkeypatch.setattr(gemini.GeminiReader, "_post", busy)
    with pytest.raises(ReaderError, match="try again"):
        gemini.GeminiReader(api_key="x", models=["main"]).read([(b"img", "image/jpeg")])


def test_gemini_reads_pages_in_parallel_and_merges(monkeypatch):
    from app.readers import gemini

    def fake_post(self, model, body):
        page = 2 if b"page 2 of 2" in body else 1
        reading = {
            "headers": {"white": "A", "black": "B"} if page == 1 else {"round": "3"},
            "pages": [{"rows": [{"number": page, "white": {"move": "e4"}}]}],
            "end_marker": {"text": "uppg.", "column": "black", "move_number": 2} if page == 2 else None,
        }
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(reading)}]}}]}

    monkeypatch.setattr(gemini.GeminiReader, "_post", fake_post)
    merged = gemini.GeminiReader(api_key="x").read([(b"p1", "image/jpeg"), (b"p2", "image/jpeg")])
    assert [p["rows"][0]["number"] for p in merged["pages"]] == [1, 2]
    assert merged["headers"] == {"white": "A", "black": "B", "round": "3"}
    assert merged["end_marker"]["text"] == "uppg."


def test_gemini_looping_answer_falls_back(monkeypatch):
    from app.readers import gemini
    calls = []

    def fake_post(self, model, body):
        calls.append(model)
        if model == "main":
            return {"candidates": [{"finishReason": "MAX_TOKENS",
                                    "content": {"parts": [{"text": '{"layout": "aaaa'}]}}]}
        return {"candidates": [{"content": {"parts": [{"text": '{"headers": {}, "pages": []}'}]}}]}

    monkeypatch.setattr(gemini.GeminiReader, "_post", fake_post)
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "backup")
    reader = gemini.GeminiReader(api_key="x", models=["main"])
    assert reader.read([(b"i", "image/jpeg")])["pages"] == []
    assert calls == ["main", "backup"]
