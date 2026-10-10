// Suggesting which Lichess study each game goes into (bulk import), and how
// chapters are named and ordered. Only suggestions: the user decides.

export const MAX_CHAPTERS = 64;  // Lichess: chapters per study

/** Lower case, no accents or punctuation: "MAS Öppna KM," -> "mas oppna km". */
export function normalizeName(text) {
  return (text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for the same name, lower the more they differ ("mas oppna km" vs "mas oppen km" ≈ 0.92). */
export function nameSimilarity(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const SAME_EVENT = 0.8;
const yearOf = (h) => (/^\d{4}/.exec(h.date || "") || [""])[0];
/** The event name without a year in it ("MAS Öppna KM 2026" -> "MAS Öppna KM"). */
const eventOf = (h) => (h.event || "").replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();

/** "2026 MAS Öppna KM" for an event; null when the game has no event. */
export function studyNameFor(h) {
  const event = eventOf(h);
  if (!event) return null;
  return [yearOf(h), event].filter(Boolean).join(" ");
}

/** The chapter name: "Rond 3 vs. Opponent" when you played, else "White – Black". */
export function chapterName(h, side = null) {
  const opponent = side === "white" ? h.black : side === "black" ? h.white : "";
  if (h.round && opponent) return "Rond " + h.round + " vs. " + opponent;
  if (opponent) return "vs. " + opponent;
  const players = (h.white || "?") + " – " + (h.black || "?");
  return h.round ? "Rond " + h.round + ": " + players : players;
}

/** Chapter order: by round, then date, then as read. */
export function chapterOrder(games) {
  const round = (g) => { const n = parseFloat(g.headers.round); return Number.isFinite(n) ? n : Infinity; };
  return games.map((g, i) => [g, i])
    .sort(([a, i], [b, j]) => round(a) - round(b) || (a.headers.date || "").localeCompare(b.headers.date || "") || i - j)
    .map(([g]) => g);
}

/**
 * Suggest a study for each game.
 *   games:    [{id, headers}]
 *   existing: the user's Lichess studies [{id, name}]
 *   mode:     "event" (one study per event) or "single" (all in `singleName`)
 * Returns {studies: [{key, name, existingId, gameIds}], studyOf: {gameId: key}}.
 * A study is either an existing one (existingId) or a new one to create.
 */
export function suggestStudies(games, existing = [], mode = "event", singleName = "Imported games") {
  const studies = [];
  const studyOf = {};
  // Names match when the years are the same (or one has none) and the rest is
  // similar: "2026 MAS öppen KM" = "2026 MAS Öppna KM", but not "2025 MAS Öppna KM".
  const yearIn = (name) => (/\b(19|20)\d{2}\b/.exec(name) || [""])[0];
  const withoutYear = (name) => name.replace(/\b(19|20)\d{2}\b/g, " ");
  const sameStudy = (a, b) => {
    const ya = yearIn(a), yb = yearIn(b);
    return (!ya || !yb || ya === yb) && nameSimilarity(withoutYear(a), withoutYear(b)) >= SAME_EVENT;
  };
  const findExisting = (name) => {
    let best = null, bestScore = -1;
    for (const s of existing) {
      const score = nameSimilarity(s.name, name);
      if (sameStudy(s.name, name) && score > bestScore) { best = s; bestScore = score; }
    }
    return best;
  };
  const add = (name, gameId) => {
    let study = studies.find((s) => sameStudy(s.name, name));
    if (!study) {
      const match = findExisting(name);
      study = { key: "s" + studies.length, name: match ? match.name : name, existingId: match ? match.id : null, gameIds: [] };
      studies.push(study);
    }
    study.gameIds.push(gameId);
    studyOf[gameId] = study.key;
  };
  for (const g of games) {
    const name = mode === "single" ? singleName : studyNameFor(g.headers) || ("Games " + (yearOf(g.headers) || "without event")).trim();
    add(name, g.id);
  }
  return { studies, studyOf };
}
