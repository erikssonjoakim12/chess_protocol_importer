// The pipeline: reading -> plies -> resolved moves -> PGN.
import { buildPgn, deriveResult } from "./pgn.js";
import { flatten, normalizeReading } from "./reading.js";
import { resolve } from "./resolver.js";

/** Resolve plies and build the PGN. Called after reading and after every edit.
 *  If headers.result is set (the user chose it) it is used as is, otherwise
 *  the result is worked out from the scoresheet. */
export function processGame(headers, plies, endMarker = null) {
  const resolution = resolve(plies);
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
  };
}

/** A fresh reading (from a reader) -> everything the review screen needs. */
export function startReview(rawReading) {
  const reading = normalizeReading(rawReading);
  const headers = { ...reading.headers };
  const out = processGame(headers, flatten(reading), reading.end_marker);
  headers.result = out.result;
  return { ...out, reading, headers, end_marker: reading.end_marker,
           notes: reading.notes, header_flags: reading.header_flags };
}
