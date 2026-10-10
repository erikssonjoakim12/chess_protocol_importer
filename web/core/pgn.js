// Build the final PGN: tags from the scoresheet header, moves from the resolver.
import { Chess } from "../vendor/chess.js";

// "/0" on a scoresheet means "less than a minute left".
const UNDER_A_MINUTE_SECONDS = 30;

// Tag order in the output. The first seven are PGN's mandatory tags.
const TAG_ORDER = [
  ["Event", "event"], ["Site", "site"], ["Date", "date"], ["Round", "round"],
  ["White", "white"], ["Black", "black"], ["Result", "result"],
  ["WhiteElo", "white_elo"], ["WhiteTeam", "white_team"],
  ["BlackElo", "black_elo"], ["BlackTeam", "black_team"],
  ["TimeControl", "time_control"], ["Board", "board"], ["Section", "group"],
];
const REQUIRED = new Set(["Event", "Site", "Date", "Round", "White", "Black", "Result"]);
const RESULTS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

function scoreValue(value) {
  const v = (value || "").trim().replaceAll(",", ".").replaceAll(" ", "");
  if (v === "1" || v === "1.0") return 1.0;
  if (v === "0" || v === "0.0") return 0.0;
  if (["½", "1/2", "0.5", ".5"].includes(v)) return 0.5;
  return null;
}

function resultFromEndMarker(end) {
  if (!end) return null;
  const text = (end.text || "").toLowerCase().replaceAll(" ", "");
  if (RESULTS.has(text)) return text;
  if (text === "½-½" || text === "0.5-0.5") return "1/2-1/2";
  if (text.startsWith("rem")) return "1/2-1/2";
  if (text.startsWith("uppg") || text.startsWith("tid") || text.startsWith("ger")) {
    // The player who wrote it in their own column resigned / lost on time.
    if (end.column === "white") return "0-1";
    if (end.column === "black") return "1-0";
  }
  return null;
}

/** [result, warning or null] from score boxes, end words and mate. */
export function deriveResult(headers, endMarker = null, checkmateWinner = null) {
  const w = scoreValue(headers.white_score), b = scoreValue(headers.black_score);
  let fromScores = null;
  if ((w === 1.0 && b === 0.0) || (w === 1.0 && b === null) || (w === null && b === 0.0)) fromScores = "1-0";
  else if ((w === 0.0 && b === 1.0) || (w === 0.0 && b === null) || (w === null && b === 1.0)) fromScores = "0-1";
  else if (w === 0.5 || b === 0.5) fromScores = "1/2-1/2";
  const fromEnd = resultFromEndMarker(endMarker);
  const fromMate = { white: "1-0", black: "0-1" }[checkmateWinner] || null;

  const found = [fromScores, fromEnd, fromMate].filter((r) => r);
  if (!found.length) return ["*", null];
  if (new Set(found).size > 1) {
    return [found[0], "The score boxes, end of game note and final position disagree " +
                      `about the result (${found.join(", ")}). Please check it.`];
  }
  return [found[0], null];
}

const PERIOD = /(\d+(?:[.,]\d+)?)\s*(tim|h|min|m)[\p{L}\p{N}_]*\s*\/\s*(\d+)\s*(?:drag|d|moves?)?/giu;
const AMOUNT = /(\d+(?:[.,]\d+)?)\s*(tim|h|min|m|sek|s)?[\p{L}\p{N}_]*/giu;

function seconds(number, unit, defaultUnit) {
  const n = parseFloat(number.replace(",", "."));
  const u = (unit || defaultUnit).toLowerCase();
  if (u.startsWith("tim") || u.startsWith("h")) return Math.trunc(n * 3600);
  if (u.startsWith("m")) return Math.trunc(n * 60);
  return Math.trunc(n);
}

/** '60 min + 30s/drag' -> '3600+30'; '2 tim/40 drag 1 tim/20 30 min' ->
 *  '40/7200:20/3600:1800'. Anything not understood is returned unchanged. */
export function timeControlToPgn(text) {
  const raw = (text || "").trim();
  if (!raw || /^[\d/:+-]+$/.test(raw)) return raw;
  let t = raw.replaceAll("(", " ").replaceAll(")", " ");
  let increment = "";
  const inc = /\+\s*(\d+)\s*(s|sek|sec)?/i.exec(t);
  if (inc) {
    increment = "+" + parseInt(inc[1], 10);
    t = t.slice(0, inc.index) + " " + t.slice(inc.index + inc[0].length);
    t = t.replace(/\/\s*(drag|move|d)[\p{L}\p{N}_]*/giu, " ");
  }
  const periods = [...t.matchAll(PERIOD)].map((m) => `${m[3]}/${seconds(m[1], m[2], "min")}`);
  const rest = t.replace(PERIOD, " ");
  const amounts = [...rest.matchAll(AMOUNT)].filter((m) => m[1]);
  if (amounts.length > 1 || (!amounts.length && !periods.length)) return raw;
  let final = "";
  if (amounts.length) final = String(seconds(amounts[0][1], amounts[0][2], "min")) + increment;
  else if (increment) return raw;
  return [...periods, ...(final ? [final] : [])].join(":");
}

export function clockSeconds(minutesLeft) {
  const digits = String(minutesLeft || "").replace(/\D/g, "");
  if (!digits) return null;
  const minutes = parseInt(digits, 10);
  return minutes > 0 ? minutes * 60 : UNDER_A_MINUTE_SECONDS;
}

function clockComment(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `[%clk ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
}

export function buildTags(headers, result) {
  const values = { ...headers, result };
  values.time_control = timeControlToPgn(headers.time_control);
  values.white_elo = (headers.white_elo || "").replace(/\D/g, "");
  values.black_elo = (headers.black_elo || "").replace(/\D/g, "");
  const tags = [];
  for (const [tag, key] of TAG_ORDER) {
    // A double quote or backslash inside a tag value is read differently by
    // different PGN readers, so avoid them altogether.
    let value = (values[key] || "").trim().replaceAll('"', "'").replaceAll("\\", "/");
    if (tag === "Date" && !value) value = "????.??.??";
    if (value || REQUIRED.has(tag)) tags.push([tag, value || "?"]);
  }
  return tags;
}

/** The PGN text. Lines are wrapped at 80 columns exactly like python-chess,
 *  so both versions of the app produce identical files. */
export function buildPgn(headers, resolvedPlies, result) {
  const lines = [];
  let line = "";
  const flush = () => { if (line) lines.push(line.trimEnd()); line = ""; };
  const token = (t) => { if (80 - line.length < t.length) flush(); line += t; };
  const tags = buildTags(headers, result);
  for (const [tag, value] of tags) lines.push(`[${tag} "${value}"]`);
  if (tags.length) lines.push("");

  const board = new Chess();
  let forceNumber = true;
  for (const ply of resolvedPlies) {
    if (!ply.uci) break;
    const number = board.moveNumber();
    if (board.turn() === "w") token(number + ". ");
    else if (forceNumber) token(number + "... ");
    const move = board.move({ from: ply.uci.slice(0, 2), to: ply.uci.slice(2, 4),
                              promotion: ply.uci.slice(4) || undefined });
    token(move.san + " ");
    forceNumber = false;
    const secs = clockSeconds(ply.clock);
    if (secs !== null) {
      token("{ " + clockComment(secs) + " } ");
      forceNumber = true;
    }
  }
  token((tags.find(([t]) => t === "Result") || [, "*"])[1] + " ");
  flush();
  return lines.join("\n").trimEnd() + "\n";
}
