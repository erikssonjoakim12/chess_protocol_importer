// Normalising handwritten moves into comparable keys, for any notation profile
// (notations.js). Keys use the letters of the sheet's own notation, because
// that is what is handwritten, so the look-alike tables describe real
// handwriting slips. Swedish is the default.
import { notation, NOTATIONS } from "./notations.js";

const SWEDISH = NOTATIONS.swedish;

const pairKey = (a, b) => (a < b ? a + b : b + a);

// Writing the square as seen from the other side of the board: files a<->h,
// b<->g, c<->f, d<->e and ranks 1<->8, 2<->7, 3<->6, 4<->5. A legal move only
// found this way is always shown to the user, never fixed silently.
export const MIRROR = new Set(["ah", "bg", "cf", "de", "18", "27", "36", "45"].map((p) => pairKey(p[0], p[1])));
export const MIRROR_COST = 0.4;

// Per-profile tables, worked out once.
const tables = new Map();
function tablesFor(nt) {
  let t = tables.get(nt.id);
  if (!t) {
    const letters = new Set([...Object.values(nt.pieces), ...Object.keys(nt.foreign)]);
    t = {
      lookalike: new Set(nt.lookalikes.map((p) => pairKey(p[0], p[1]))),
      promotion: new RegExp("^(.*[18])=?([" + [...letters].join("") + "])$"),
    };
    tables.set(nt.id, t);
  }
  return t;
}

const CASTLE_LONG = /^[0oO]-?[0oO]-?[0oO]$/;
const CASTLE_SHORT = /^[0oO]-?[0oO]$/;

function rstripChars(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * Turn a handwritten move into a compact key in the sheet's notation.
 * Swedish: 'Sxd4+' -> 'Sd4', 'Nbd2' -> 'Sbd2', 'exd5' -> 'ed5', '0-0' -> 'O-O',
 * 'e8=D' / 'e8D' -> 'e8D'. Returns '' for empty input.
 */
export function handwrittenKey(text, nt = SWEDISH) {
  let t = (text || "").trim();
  t = t.replace(/\s+/g, "");
  t = t.replace(/(e\.?p\.?)$/, "");
  t = rstripChars(t, "+#!?‡†");
  t = t.replaceAll("†", "").replaceAll("+", "").replaceAll("#", "");
  if (CASTLE_LONG.test(t)) return "O-O-O";
  if (CASTLE_SHORT.test(t)) return "O-O";
  if (!t) return "";
  // Piece letter from another notation (a mixed sheet); a lower-case letter
  // that can't be a file must be a sloppily written piece letter.
  const first = t[0];
  if (first in nt.foreign) {
    t = nt.foreign[first] + t.slice(1);
  } else if (nt.lowercasePieces.includes(first) && t.length > 2) {
    t = first.toUpperCase() + t.slice(1);
  }
  // Promotion: '=Q', '=D', or a trailing piece letter after the last rank.
  const m = tablesFor(nt).promotion.exec(t);
  if (m) t = m[1] + (nt.foreign[m[2]] || m[2]);
  return t.replaceAll("x", "").replaceAll(":", "").replaceAll("-", "").replaceAll("=", "");
}

/** Standard (English) SAN -> the sheet's notation, for display.
 *  Swedish: 'Nxe4+' -> 'Sxe4+', 'e8=Q' -> 'e8=D'. */
export function sanToLocal(san, nt = SWEDISH) {
  let out = "";
  for (let i = 0; i < san.length; i++) {
    const ch = san[i];
    const prev = i ? san[i - 1] : "";
    out += ch in nt.pieces && (i === 0 || prev === "=") ? nt.pieces[ch] : ch;
  }
  return out;
}

/** Kept for the Swedish-only callers and tests. */
export const sanToSwedish = (san) => sanToLocal(san, SWEDISH);

function subCost(a, b, mirror, lookalike) {
  if (a === b) return 0.0;
  if (a.toLowerCase() === b.toLowerCase()) return 0.15;
  const pair = pairKey(a, b);
  if (lookalike.has(pair)) return 0.35;
  if (mirror && MIRROR.has(pair)) return MIRROR_COST;
  return 1.0;
}

/** Levenshtein distance with cheap substitutions for look-alike characters
 *  (and, if `mirror`, for mirrored files/ranks). */
export function weightedDistance(a, b, mirror = true, nt = SWEDISH) {
  const lookalike = tablesFor(nt).lookalike;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1.0, cur[j - 1] + 1.0, prev[j - 1] + subCost(a[i - 1], b[j - 1], mirror, lookalike));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1.0 for identical keys, falling towards 0 as they differ. */
export function similarity(a, b, mirror = true, nt = SWEDISH) {
  if (!a || !b) return 0.0;
  return Math.max(0.0, 1.0 - weightedDistance(a, b, mirror, nt) / Math.max(a.length, b.length));
}

/** Compare strings by code point, like Python's sort (not locale order). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { notation };
