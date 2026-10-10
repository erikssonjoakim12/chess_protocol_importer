// The pipeline: reading -> plies -> resolved moves -> PGN.
import { DEFAULT_NOTATION, NOTATIONS } from "./notations.js";
import { buildPgn, deriveResult } from "./pgn.js";
import { flatten, normalizeReading } from "./reading.js";
import { resolve } from "./resolver.js";

/** Resolve plies and build the PGN. Called after reading and after every edit.
 *  If headers.result is set (the user chose it) it is used as is, otherwise
 *  the result is worked out from the scoresheet. `notationId`: the sheet's
 *  notation (notations.js). */
export function processGame(headers, plies, endMarker = null, notationId = DEFAULT_NOTATION) {
  const resolution = resolve(plies, notationId);
  let mateWinner = null;
  if (resolution.checkmate) mateWinner = resolution.next_color === "white" ? "black" : "white";
  const [derived, warning] = deriveResult(headers, endMarker, mateWinner);
  const result = (headers.result || "").trim() || derived;
  return {
    resolution,
    result,
    derived_result: derived,
    result_warning: warning,
    pgn: buildPgn(headers, resolution.plies, result),
    notation: notationId,
  };
}

/** Which notation is the sheet written in? No extra AI call: first the piece
 *  letters used (a sheet with only S/L/T/D is Swedish, only N/B/R/Q English);
 *  when that is unclear, the game is replayed in each notation and the one in
 *  which more moves fit wins (ties: Swedish). */
export function detectNotation(plies) {
  const letters = (re) => plies.filter((p) => re.test((p.text || "").trim())).length;
  const counts = Object.fromEntries(Object.values(NOTATIONS).map((nt) => {
    const own = Object.values(nt.pieces).filter((l) => l !== "K");
    return [nt.id, letters(new RegExp("^[" + own.join("") + "]"))];
  }));
  const clear = Object.keys(counts).filter((id) => counts[id] >= 2 &&
    Object.keys(counts).every((other) => other === id || counts[other] === 0));
  if (clear.length === 1) return clear[0];
  let best = DEFAULT_NOTATION, bestFit = null;
  for (const id of [DEFAULT_NOTATION, ...Object.keys(NOTATIONS).filter((n) => n !== DEFAULT_NOTATION)]) {
    const c = resolve(plies, id).counts;
    const fit = [c.ok, -(c.fail + c.pending), -c.check];
    if (!bestFit || fit[0] > bestFit[0] || (fit[0] === bestFit[0] && (fit[1] > bestFit[1] ||
        (fit[1] === bestFit[1] && fit[2] > bestFit[2])))) {
      best = id;
      bestFit = fit;
    }
  }
  return best;
}

/** A fresh reading (from a reader) -> everything the review screen needs.
 *  `notationId`: "auto" (detect) or a notation id. */
export function startReview(rawReading, notationId = "auto") {
  const reading = normalizeReading(rawReading);
  const headers = { ...reading.headers };
  const plies = flatten(reading);
  const detected = detectNotation(plies);
  const out = processGame(headers, plies, reading.end_marker, notationId === "auto" ? detected : notationId);
  headers.result = out.result;
  return { ...out, reading, headers, end_marker: reading.end_marker, detected_notation: detected,
           notes: reading.notes, header_flags: reading.header_flags };
}
