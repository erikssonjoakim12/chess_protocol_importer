# Protokoll → PGN

Take a photo of a handwritten chess scoresheet in Swedish notation and get a
PGN ready for Lichess: moves, clock times and game details (players, ratings,
clubs, event, round, board, date, result).

The app runs entirely in the browser. It reads the handwriting with Google
Gemini using **your own free Gemini key**, which is kept only in your browser;
photos go straight from your device to Google. There is no server.

## How it works

1. **Reading.** Gemini transcribes what is written, mistakes included: moves in
   Swedish notation, clock times (`/42` = 42 minutes left), and the form's
   header fields.
   - **Read scoresheet** (fast, ~10-20 s): two fast models read every page at
     the same time, pages in parallel. Where the two readings differ, the
     chess engine decides, or asks you.
   - **Read carefully** (~1-1.5 min): models that think before answering.
     Use it when the fast reading needs many corrections. A misreading that
     is *also a legal move* can only be caught by reading better, not by the
     chess rules.
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
4. **Output.** Copy the PGN or download it (Lichess: Study → Add chapter →
   PGN → paste). Or click **Open in Lichess**: it creates a Lichess game page
   (board, moves, analysis, clocks) with a link you can share. No login is
   needed, but the game is public to anyone with the link.
5. **Add to study.** Log in with Lichess (Settings) and add the game as a
   chapter to one of your studies, or a new one (private by default). The
   chapter is named like "Rond 3 vs. <opponent>" and the board is turned to
   your side. The login uses Lichess's OAuth with PKCE, entirely in the
   browser; the app only asks for permission to read and write studies.
6. **Bulk import** (bulk.html): up to 15 games (40 photos) at once, from the
   computer or the phone's camera. Each photo is read on its own at a pace the
   free tier allows (closing the browser is fine; it continues later), the
   pages are grouped into games (you can join or split), you check each game,
   then choose a study per game (suggested: one per event, matching your
   existing studies) and add them all. Photos are kept on the device until the
   game is in a study.
7. **Saved games.** Every game you read is kept in the browser on that device,
   with your corrections, so it never has to be read again. Photos are not
   kept. "Download all" gives one .pgn file as a backup.

Two-page games: add both photos, page 1 first. It doesn't matter whether page 2
is numbered from 41/61 or restarts at 1.

## Your Gemini key

The first time, the app asks for a key:

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** and copy it.
3. Paste it into the app. It is checked with Google and kept in this browser.

No credit card is needed for the free tier. On the free tier Google may use
what you send to improve its products.

On the free tier there is little to worry about: Google does not charge a free
key, so the worst case if it leaked is someone using up your free quota. Don't
share it, and remove it from the app on shared devices. Optionally, lock it to
the app's web address and the Generative Language API in Google Cloud →
Credentials. If you switch on billing (e.g. for a paid model), do lock it, set
a budget with alerts, and replace the key if it may have leaked. The app's
settings explain each step.

## Running it on your computer

Browsers don't run apps straight from a folder, so a tiny local file server is
included (needs [Node.js](https://nodejs.org) 22 or newer). Double-click
`start.bat`, or:

```powershell
npm start                     # opens http://127.0.0.1:8000
node scripts/serve.js --lan   # also reachable from your phone on the same Wi-Fi
```

Any static file server pointed at `web/` works too. "Try the example game"
shows the app without photos or a key.

## Development

```
web/                 the app (plain HTML/CSS/JavaScript modules, no build step)
  core/              notations, matching, resolver, PGN, reading clean-up, Gemini reader
  vendor/            chess.js (BSD), copied in by `npm run vendor`
  pieces/            the cburnett chess pieces (BSD)
  tests/             tests; golden/ holds the answer keys
scripts/             serve.js, make_golden.js (answer keys), benchmark.js, vendor.js
tests/private/       real scoresheets and their answers (not in git)
```

```powershell
npm install          # chess.js, for npm run vendor
npm test             # all tests, including the answer keys
npm run golden       # after a deliberate change in behaviour: update the answer keys, then review git diff
npm run benchmark    # read real scoresheets with Gemini and count misreadings (needs .env and tests/private/)
```

**Answer keys** (`web/tests/golden/`): scoresheet readings and exactly what the
app must make of them: moves, flags, hints and PGN. They are public-domain
games (Morphy's Opera Game, the Immortal and Evergreen games, random games)
written with simulated handwriting slips, plus, locally only, real
scoresheets. They were first produced by an earlier Python version of the app.

Real scoresheets used for testing (`example_protocols/`, `tests/private/`) are
private and never committed.

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts keep their own licences:
chess.js (BSD-2-Clause, `web/vendor/`) and the cburnett chess pieces (BSD,
`web/pieces/`).
