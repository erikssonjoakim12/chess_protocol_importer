# Protokoll → PGN

Take a photo of a handwritten chess scoresheet in Swedish notation and get a
PGN ready to paste into a Lichess study: moves, clock times and game details
(players, ratings, clubs, event, round, board, date, result).

## How it works

1. **Reading.** The photos go to a vision AI (Google Gemini, free tier). It
   transcribes what is written, mistakes included: moves in Swedish notation,
   clock times (`/42` = 42 minutes left), and the form's header fields.
   - **Read scoresheet** (fast, ~10-20 s): two fast models read every page at
     the same time, pages in parallel. Where the two readings differ, the
     chess engine decides, or asks you.
   - **Read carefully** (~1-1.5 min): models that think before answering.
     Use it when the fast reading needs many corrections. Note that a
     misreading that is *also a legal move* can only be caught by reading
     better, not by the chess rules.
2. **Checking.** The game is replayed move by move. Each handwritten move is
   matched against the legal moves in the position, allowing for typical
   slips: look-alike characters (4/9, 1/7, S/5, c/e…) and mirrored squares
   (c/f, 2/7…). Check signs, captures and disambiguation (`Nbd2`) are worked
   out from the position.
3. **Review.** Anything uncertain is highlighted. You pick the right move from
   a short list, insert a forgotten move or delete a stray one, and the rest of
   the game is replayed instantly. When a move turns out to be impossible, the
   app also checks whether a *different* reading of an earlier move makes
   everything fit, and suggests it.
4. **Output.** Copy the PGN or download it. In Lichess: Study → Add chapter →
   PGN → paste.

Two-page games: add both photos, page 1 first. It doesn't matter whether page 2
is numbered from 41/61 or restarts at 1.

## Setup (Windows)

You need Python 3.9 or newer.

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

Get a free Gemini API key (it is personal: keep it in `.env`, never share it
or put it in a public app):

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** and copy it.
3. Paste it after `GEMINI_API_KEY=` in `.env`.

No credit card is needed for the free tier. Note that on the free tier Google
may use what you send to improve its products. For scoresheets that is
probably fine, but it's worth knowing.

## Running

Double-click `start.bat`, or:

```powershell
.venv\Scripts\python run.py          # opens http://127.0.0.1:8000
.venv\Scripts\python run.py --lan    # also open it from your phone on the same Wi-Fi
.venv\Scripts\python run.py --mock   # try the UI without an API key (example game)
```

Tests: `.venv\Scripts\python -m pytest`

## Clock times

A number after a slash next to a move is read as *minutes left* after that
move and becomes a Lichess clock comment (`[%clk 0:42:00]`), shown in the
study's move list. `/0` means under a minute and is stored as 30 seconds.

## Project layout

```
app/
  readers/      photo -> raw transcription. gemini.py, mock.py; add new readers here
  notation.py   Swedish/English notation, look-alike and mirror rules
  resolver.py   replays the game, matches handwriting to legal moves, suggestions
  pgn_builder.py tags, result, time control, clock comments, PGN text
  service.py    the pipeline
  main.py       web server (FastAPI)
static/         the web page
tests/          tests; fixtures/ has a public demo game, private/ (not in git) real ones
```

### Swapping the reader

Set `READER` in `.env`. To add one (another AI service, or a local model via
Ollama), subclass `Reader` in `app/readers/`, return the reading format
described in `app/readers/base.py`, and register it in
`app/readers/__init__.py`.
