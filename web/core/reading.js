// What a reader returns, how it is cleaned up, how two readings of the same
// page are combined, and how it becomes a flat list of plies.
//
// A *reading* is a plain object:
//   {
//     headers: {event, site, date, date_raw, round, board, group, white, black,
//               white_elo, black_elo, white_team, black_team, time_control,
//               white_score, black_score},          // strings, "" if unknown
//     header_flags: [field names worth a second look],
//     pages: [{rows: [{number, white: Cell | null, black: Cell | null}]}],
//     end_marker: {text, column: "white" | "black", move_number} | null,
//     notes: string,
//   }
//   Cell = {move, clock, alternatives: [string], unclear: bool}
//
// Moves are transcribed as written (Swedish notation, typos and all); the
// resolver is responsible for making sense of them.
import { cmp, handwrittenKey } from "./notation.js";

export const HEADER_FIELDS = [
  "event", "site", "date", "date_raw", "round", "board", "group",
  "white", "black", "white_elo", "black_elo", "white_team", "black_team",
  "time_control", "white_score", "black_score",
];

const str = (v) => (v === null || v === undefined || v === false || v === 0 ? "" : String(v));
const isEmpty = (o) => !o || (typeof o === "object" && Object.keys(o).length === 0);

function stripChars(text, chars) {
  let a = 0, b = text.length;
  while (a < b && chars.includes(text[a])) a++;
  while (b > a && chars.includes(text[b - 1])) b--;
  return text.slice(a, b);
}

// Readers sometimes get stuck repeating a character, or "think aloud" inside a
// field ("Norrby SK 6 0/1?? (Not entirely clear where... Wait, let me
// re-check"). We keep the start of the value and cut at the first sign of
// such text, and flag the field so the user checks it.
const JUNK = /(.)\1{5,}|\d{9,}|\b(wait|hmm|actually|correction|assum[\p{L}\p{N}_]*|instructions?|I see|I must|let me|looks like|not (entirely )?clear|probably|likely)\b/iu;
// Anything outside Latin letters (incl. å ä ö é ü...), digits and plain punctuation.
const ODD_CHAR = /[^A-Za-z0-9À-ÖØ-öø-ÿ .,'&/+\-:½]/u;
// In a name or club: a rating, a date or a score ("1850", "6/10-2026", "0/1").
const NUMBERISH = /\s(\d{3,}|\d+[/\-.]\d+)(\s|$)/u;
const MAX_LEN = { event: 80, site: 40, white: 40, black: 40, white_team: 40,
                  black_team: 40, time_control: 40, date_raw: 20 };
const SHORT = new Set(["round", "board", "group", "white_score", "black_score"]);
const NAMEISH = new Set(["white", "black", "white_team", "black_team", "site"]);

/** [clean text, whether anything suspicious was cut off]. */
export function cleanText(value, maxLen = 60, nameish = false) {
  const original = str(value).replace(/\s+/g, " ").trim();
  let text = str(value).replaceAll("\r", "\n").split("\n")[0];
  // Names and clubs are plain words; other fields ("60 min (+30s/drag)") may
  // legitimately contain brackets and numbers.
  for (const pattern of [JUNK, ...(nameish ? [ODD_CHAR, NUMBERISH] : [])]) {
    const m = pattern.exec(text);
    if (m) text = text.slice(0, m.index);
  }
  text = stripChars(text.replace(/\s+/g, " "), " ,;:-");
  if (nameish) text = text.replace(/(\s\d)+$/, "");  // a stray score digit at the end
  if (text.length > maxLen) {
    const cut = text.slice(0, maxLen);
    const space = cut.lastIndexOf(" ");
    text = space >= 0 ? cut.slice(0, space) : cut;
  }
  text = stripChars(text, " ,;:-");
  return [text, text !== stripChars(original, " ,;:-")];
}

/** '6/10-2026', '8/10 2026', '2/7-06', '13.10.2006' (day first) -> '2026.10.06'. */
export function parseWrittenDate(raw) {
  const m = /(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[-/. ]\s*(\d{4}|\d{2})\b/.exec(raw || "");
  if (!m) return "";
  const day = parseInt(m[1], 10), month = parseInt(m[2], 10);
  let year = m[3];
  if (year.length === 2) year = (parseInt(year, 10) < 70 ? "20" : "19") + year;
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return "";
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

/** [value safe to show and put in the PGN, or ''; whether it looked suspicious]. */
export function cleanHeader(key, value) {
  const raw = str(value).trim();
  if (key === "white_elo" || key === "black_elo") {
    const m = /\b(\d{3,4})\b/.exec(raw);
    return [m ? m[1] : "", Boolean(raw) && (!m || m[1] !== raw)];
  }
  if (key === "date") {
    // Not \b: there is no word boundary next to "??" ("1858.??.??").
    const m = /(?<!\d)(\d{4}|\?{4})[.\-/](\d{2}|\?\?)[.\-/](\d{2}|\?\?)(?!\d)/.exec(raw);
    return [m ? [m[1], m[2], m[3]].join(".") : "", Boolean(raw) && !m];
  }
  if (SHORT.has(key)) return cleanText(raw, 12);
  return cleanText(raw, MAX_LEN[key] ?? 60, NAMEISH.has(key));
}

/** All header fields cleaned, plus the set of fields worth a second look. */
function cleanHeaders(rawHeaders) {
  rawHeaders = rawHeaders || {};
  const headers = {}, flags = new Set();
  for (const key of HEADER_FIELDS) {
    const [value, suspect] = cleanHeader(key, rawHeaders[key]);
    headers[key] = value;
    if (suspect) flags.add(key);
  }
  const written = parseWrittenDate(headers.date_raw);
  if (written && !headers.date) headers.date = written;
  else if (written && headers.date !== written) flags.add("date");  // formatted date and handwriting disagree
  return [headers, flags];
}

function cleanMove(value) {
  let text = str(value).trim();
  const junk = JUNK.exec(text);
  if (junk) text = text.slice(0, junk.index);
  return text.trim().slice(0, 12).trim();
}

function cleanCell(cell) {
  if (isEmpty(cell)) return null;
  const move = cleanMove(cell.move);
  const alts = (cell.alternatives || []).map(cleanMove).filter((a) => a);
  if (!move && !alts.length) return null;
  return {
    move,
    clock: str(cell.clock).replace(/\D/g, ""),
    alternatives: alts.filter((a) => a !== move),
    unclear: Boolean(cell.unclear),
  };
}

// Words written in a move cell to end the game: resigned, draw, lost on time, results.
const END_WORD = /^(upp?g\.?|uppgav|uppgivet|uppger|ger upp|remi[s.]?|tid\.?|tidsf[\p{L}\p{N}_]*|1-0|0-1|½-½|1\/2-1\/2|0[.,]5-0[.,]5|resigns?|draw|time)$/iu;

export function isEndWord(text) {
  return END_WORD.test((text || "").trim());
}

/** Same row number, and wherever both rows have a move it's the same move. */
function isRepeat(prev, row) {
  if (prev.number === null || prev.number !== row.number) return false;
  for (const color of ["white", "black"]) {
    const a = prev[color], b = row[color];
    if (a && b && a.move !== b.move) return false;
  }
  return true;
}

/** Fill in defaults so the rest of the app can rely on the shape. */
export function normalizeReading(raw) {
  raw = raw || {};
  const [headers, flags] = cleanHeaders(raw.headers);
  for (const f of raw.header_flags || []) flags.add(f);
  let end = isEmpty(raw.end_marker) ? null : raw.end_marker;
  if (end && !str(end.text).trim()) end = null;
  const pages = [];
  let ended = false;
  for (const page of raw.pages || []) {
    const rows = [];
    for (const row of (page && page.rows) || []) {
      if (ended) break;  // nothing after the end of the game is a move (signatures etc.)
      let white = cleanCell(row.white), black = cleanCell(row.black);
      const number = row.number ?? null;
      for (const [color, cell] of [["white", white], ["black", black]]) {
        if (cell && isEndWord(cell.move)) {
          // The reader put "uppg." etc. in a move cell; it's the end of the game.
          end = end || { text: cell.move, column: color, move_number: number };
          if (color === "white") white = black = null;
          else black = null;
          ended = true;
          break;
        }
      }
      if (!(white || black)) continue;
      const next = { number, white, black };
      if (rows.length && isRepeat(rows[rows.length - 1], next)) {
        // Readers sometimes emit a row twice, once incomplete; keep the fuller one.
        const last = rows[rows.length - 1];
        rows[rows.length - 1] = { number, white: last.white || white, black: last.black || black };
        continue;
      }
      rows.push(next);
    }
    pages.push({ rows });
  }
  return { headers, header_flags: [...flags].sort(cmp), pages, end_marker: end, notes: str(raw.notes) };
}

/** Several readings of one cell -> one cell. The first reading leads; if the
 *  others read something else, that goes into alternatives and the cell is
 *  marked unclear, so the resolver weighs the readings against the board. */
function combineCells(cells) {
  const missing = cells.some((c) => c === null);  // some readings saw nothing here
  cells = cells.filter((c) => c);
  if (!cells.length) return null;
  const first = { ...cells[0] };
  const alternatives = [...first.alternatives];
  let disagree = missing;
  for (const other of cells.slice(1)) {
    if (handwrittenKey(other.move) !== handwrittenKey(first.move)) {
      disagree = true;
      alternatives.push(other.move);
    }
    alternatives.push(...other.alternatives);
    if (!first.clock) first.clock = other.clock;
  }
  const seen = new Set([handwrittenKey(first.move)]);
  first.alternatives = [];
  for (const a of alternatives) {
    if (!seen.has(handwrittenKey(a))) {
      seen.add(handwrittenKey(a));
      first.alternatives.push(a);
    }
  }
  first.unclear = cells.some((c) => c.unclear) || disagree;
  return first;
}

/** Pick one header value from several readings: [[value, suspect]].
 *  Any value beats an empty one (a complete result with one thing to check is
 *  more useful than a gap). Then: what most readings agree on, a value that
 *  didn't need cleaning, and the shorter one when one value just has extra
 *  words at the end ('Norrby SK' vs 'Norrby SK Krub').
 *  Returns [value, whether the user should check it]. */
function chooseHeader(options) {
  options = options.filter(([v]) => v);
  if (!options.length) return ["", false];
  const values = options.map(([v]) => v);
  // Readings that agree, counting 'Norrby SK Krub' as agreeing with 'Norrby SK'.
  const support = (v) => values.filter((w) => w === v || w.toLowerCase().startsWith(v.toLowerCase() + " ")).length;
  const clean = (v) => !options.filter(([w]) => w === v).every(([, s]) => s);
  const rank = (v) => [support(v), clean(v) ? 1 : 0, -v.length];
  let best = values[0];
  for (const v of values.slice(1)) {
    const [a, b] = [rank(v), rank(best)];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = v;
  }
  const disagree = new Set(values).size > 1;
  return [best, disagree || !clean(best)];
}

/** Combine readings of the same page(s) by different models, row by row.
 *  Rows are matched on their printed move number. A cell that only one
 *  reading has is kept, but marked unclear. */
export function combineReadings(rawReadings) {
  const readings = rawReadings.map(normalizeReading);
  if (readings.length === 1) return readings[0];
  const combined = { headers: {}, header_flags: [], pages: [], end_marker: null, notes: "" };
  const flags = new Set();
  for (const key of HEADER_FIELDS) {
    const [value, suspect] = chooseHeader(readings.map((r) => [r.headers[key], r.header_flags.includes(key)]));
    combined.headers[key] = value;
    if (suspect) flags.add(key);
  }
  combined.header_flags = [...flags].sort(cmp);
  combined.end_marker = (readings.find((r) => r.end_marker) || {}).end_marker || null;
  combined.notes = readings.filter((r) => r.notes).map((r) => r.notes).join(" ");
  const pageCount = Math.max(...readings.map((r) => r.pages.length));
  for (let p = 0; p < pageCount; p++) {
    const pages = readings.filter((r) => p < r.pages.length).map((r) => r.pages[p]);
    const byNumber = [];  // [number, [rows]] in the leading reading's order
    const index = new Map();
    for (const page of pages) {
      for (const row of page.rows) {
        const key = row.number;
        if (key === null || !index.has(key)) {
          index.set(key, byNumber.length);
          byNumber.push([key, []]);
        }
        byNumber[index.get(key)][1].push(row);
      }
    }
    if (byNumber.some(([n]) => n !== null)) {
      byNumber.sort((a, b) => (a[0] === null) - (b[0] === null) || (a[0] || 0) - (b[0] || 0));
    }
    const rows = [];
    for (const [number, found] of byNumber) {
      // A reading that doesn't have this row at all counts as "saw nothing".
      const versions = found.concat(Array.from({ length: pages.length - found.length }, () => ({ white: null, black: null })));
      const row = { number };
      for (const color of ["white", "black"]) row[color] = combineCells(versions.map((v) => v[color]));
      rows.push(row);
    }
    combined.pages.push({ rows });
  }
  return combined;
}

/** Combine per-page readings into one, in page order. */
export function mergePages(readings) {
  const merged = { layout: "", headers: {}, header_flags: [], pages: [], end_marker: null, notes: "" };
  for (const reading of readings) {
    for (const [key, value] of Object.entries(reading.headers || {})) {
      if (value && !merged.headers[key]) {
        merged.headers[key] = value;
        if ((reading.header_flags || []).includes(key)) merged.header_flags.push(key);
      }
    }
    merged.pages.push(...(reading.pages || []));
    const end = reading.end_marker;
    if (end && (end.text || "").trim()) merged.end_marker = end;
    for (const key of ["layout", "notes"]) {
      if (reading[key]) merged[key] = (merged[key] + " " + reading[key]).trim();
    }
  }
  return merged;
}

/** Pages and rows -> one list of plies in game order.
 *  Pages are simply concatenated, so it does not matter whether page 2 is
 *  numbered 41.. or restarts at 1. A row with only a black move gets an empty
 *  white ply, so that colours stay in step (the user can delete it). */
export function flatten(reading) {
  const plies = [];
  reading.pages.forEach((page, p) => {
    for (const row of page.rows) {
      for (const color of ["white", "black"]) {
        const cell = row[color];
        if (!cell) {
          if (color === "white" && row.black) {
            plies.push({ text: "", alternatives: [], clock: "", unclear: true, page: p + 1,
                         written_number: row.number });
          }
          continue;
        }
        plies.push({ text: cell.move, alternatives: cell.alternatives, clock: cell.clock,
                     unclear: cell.unclear, page: p + 1, written_number: row.number });
      }
    }
  });
  return plies;
}
