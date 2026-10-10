// Saved games (this device only). Every game read is kept in the browser,
// with the corrections made to it, so it never has to be read again.
// Photos are kept separately (photos.js), only while a game is in progress.

const STORE_KEY = "protokoll-games-v1";
const MAX_SAVED = 500;

export function newGameId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadGames() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function storeGames(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;  // private browsing, storage full or blocked
  }
}

export const getGame = (id) => loadGames().find((g) => g.id === id) || null;

/** Save (or replace) one game, newest first. */
export function putGame(record) {
  return storeGames([record, ...loadGames().filter((g) => g.id !== record.id)]);
}

/** Update some fields of a saved game. */
export function patchGame(id, fields) {
  const g = getGame(id);
  if (g) putGame({ ...g, ...fields, updated: new Date().toISOString() });
}

export function deleteGame(id) {
  storeGames(loadGames().filter((g) => g.id !== id));
}

export function gameTitle(h) {
  const players = (h.white || "?") + " – " + (h.black || "?");
  const date = h.date && !h.date.startsWith("?") ? h.date.replace(/\./g, "-") : "";
  return [date, players].filter(Boolean).join(" · ");
}

/** A saved-game record from a review: enough to reopen it exactly where it
 *  was left. `old` (the earlier version) keeps its creation time, batch and photos. */
export function gameRecord(r, old = null) {
  return {
    ...(old || {}),
    id: r.id,
    created: old ? old.created : new Date().toISOString(),
    updated: new Date().toISOString(),
    title: gameTitle(r.headers),
    result: r.headers.result || r.derivedResult || "*",
    pgn: r.pgn,
    toCheck: r.res.counts.check + r.res.counts.fail,
    complete: r.res.complete,
    lichess: r.lichess === undefined ? (old && old.lichess) || null : r.lichess,
    study: r.study === undefined ? (old && old.study) || null : r.study,
    review: {
      headers: r.headers, plies: r.plies, endMarker: r.endMarker,
      notes: r.notes || "", headerFlags: [...(r.headerFlags || [])],
      notation: r.notation, detectedNotation: r.detectedNotation, notationAuto: r.notationAuto,
    },
  };
}
