// Normalising handwritten moves (Swedish or English notation) into comparable keys.
//
// Everything is compared in *Swedish* form (K, D, T, L, S), because that is what
// is handwritten, so the look-alike table below describes real handwriting slips.

export const ENGLISH_TO_SWEDISH = { K: "K", Q: "D", R: "T", B: "L", N: "S" };

// Pairs of characters that are easy to confuse in handwriting (or in the
// reader's interpretation of it). Substituting one for the other is cheap.
const LOOKALIKES = [
  "49", "4y", "9y", "9g", "9q", "gq", "17", "1l", "1i", "7T", "1L",
  "38", "35", "3S", "5S", "56", "6b", "6G", "0O", "0o", "Oo",
  "ce", "ae", "ad", "ag", "hb", "hk", "hn", "ft", "fl", "DP", "Dd",
  "KR", "Kk", "Ss", "Ll", "Tt", "28", "2z", "uh",
];
const pairKey = (a, b) => (a < b ? a + b : b + a);
export const LOOKALIKE = new Set(LOOKALIKES.map((p) => pairKey(p[0], p[1])));

// Writing the square as seen from the other side of the board: files a<->h,
// b<->g, c<->f, d<->e and ranks 1<->8, 2<->7, 3<->6, 4<->5. A legal move only
// found this way is always shown to the user, never fixed silently.
export const MIRROR = new Set(["ah", "bg", "cf", "de", "18", "27", "36", "45"].map((p) => pairKey(p[0], p[1])));
export const MIRROR_COST = 0.4;

const CASTLE_LONG = /^[0oO]-?[0oO]-?[0oO]$/;
const CASTLE_SHORT = /^[0oO]-?[0oO]$/;

function rstripChars(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * Turn a handwritten move into a compact Swedish-notation key.
 * 'Sxd4+' -> 'Sd4', 'Nbd2' -> 'Sbd2', 'exd5' -> 'ed5', '0-0' -> 'O-O',
 * 'e8=D' / 'e8D' -> 'e8D'. Returns '' for empty input.
 */
export function handwrittenKey(text) {
  let t = (text || "").trim();
  t = t.replace(/\s+/g, "");
  t = t.replace(/(e\.?p\.?)$/, "");
  t = rstripChars(t, "+#!?‡†");
  t = t.replaceAll("†", "").replaceAll("+", "").replaceAll("#", "");
  if (CASTLE_LONG.test(t)) return "O-O-O";
  if (CASTLE_SHORT.test(t)) return "O-O";
  if (!t) return "";
  // Piece letter: English to Swedish; lower-case s/t/l/k can't be files, so
  // they must be a sloppily written piece letter.
  const first = t[0];
  if (first in ENGLISH_TO_SWEDISH) {
    t = ENGLISH_TO_SWEDISH[first] + t.slice(1);
  } else if ("stlk".includes(first) && t.length > 2) {
    t = first.toUpperCase() + t.slice(1);
  }
  // Promotion: '=Q', '=D', or a trailing piece letter after the last rank.
  const m = /^(.*[18])=?([KQRBNDTLS])$/.exec(t);
  if (m) t = m[1] + (ENGLISH_TO_SWEDISH[m[2]] || m[2]);
  return t.replaceAll("x", "").replaceAll(":", "").replaceAll("-", "").replaceAll("=", "");
}

/** 'Nxe4+' -> 'Sxe4+', 'e8=Q' -> 'e8=D'. For display. */
export function sanToSwedish(san) {
  let out = "";
  for (let i = 0; i < san.length; i++) {
    const ch = san[i];
    const prev = i ? san[i - 1] : "";
    out += ch in ENGLISH_TO_SWEDISH && (i === 0 || prev === "=") ? ENGLISH_TO_SWEDISH[ch] : ch;
  }
  return out;
}

function subCost(a, b, mirror) {
  if (a === b) return 0.0;
  if (a.toLowerCase() === b.toLowerCase()) return 0.15;
  const pair = pairKey(a, b);
  if (LOOKALIKE.has(pair)) return 0.35;
  if (mirror && MIRROR.has(pair)) return MIRROR_COST;
  return 1.0;
}

/** Levenshtein distance with cheap substitutions for look-alike characters
 *  (and, if `mirror`, for mirrored files/ranks). */
export function weightedDistance(a, b, mirror = true) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1.0, cur[j - 1] + 1.0, prev[j - 1] + subCost(a[i - 1], b[j - 1], mirror));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1.0 for identical keys, falling towards 0 as they differ. */
export function similarity(a, b, mirror = true) {
  if (!a || !b) return 0.0;
  return Math.max(0.0, 1.0 - weightedDistance(a, b, mirror) / Math.max(a.length, b.length));
}

/** Compare strings by code point, like Python's sort (not locale order). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
