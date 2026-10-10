// Reads scoresheets with Google's Gemini API, straight from the browser, using
// the user's own API key (free tier is enough).
// Docs: https://ai.google.dev/api/generate-content
import { combineReadings, mergePages } from "./reading.js";

const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
// Every page is read by each of these at the same time and the readings are
// compared: where they disagree the chess engine decides, and asks if unsure.
// Two fast models in parallel beat one slow careful model: ~10-15 s instead
// of 1-1.5 min, and a misreading has to be made twice to slip through.
export const MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
// Tried one at a time if none of the above can read a page (busy, out of quota).
export const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];
// "Read carefully": models that think before answering. More accurate, but
// 1-1.5 min, and more often busy on the free tier.
export const CAREFUL_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];
export const CAREFUL_FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-3.1-flash-lite"];
const TIMEOUT_MS = 180000;
const RETRY_STATUS = new Set([429, 500, 503, 504]);
const RETRY_PAUSES_MS = [3000, 10000];  // before the 2nd and 3rd attempt on the same model
// Includes thinking. A normal page needs ~2-5k; this stops a model that loops.
const MAX_OUTPUT_TOKENS = 12000;

export const PROMPT = `\
The images are photos of a handwritten chess scoresheet ("protokoll"), usually \
from a Swedish tournament: the pages of ONE game, in order.

Transcribe exactly what is written. Do NOT correct, complete or improve the \
moves; a chess engine checks every move afterwards, so a faithful raw reading \
is what matters, including mistakes. When a cell is hard to read, give your \
best reading in "move", other plausible readings in "alternatives", and set \
"unclear" to true.

NOTATION. Usually Swedish algebraic: K = kung (king), D = dam (queen), T = torn \
(rook), L = löpare (bishop), S = springare (knight); pawn moves have no letter. \
x = capture, + = check, 0-0 / 0-0-0 = castling. Some sheets are in another \
language, e.g. English (K Q R B N) or German (K D T L S). Copy the piece \
letters exactly as written; never translate them into another language.

LAYOUT. Forms differ a lot, so look at the layout before transcribing.
- First fill in "layout": for each page, how many blocks of columns there \
are (e.g. 1-20, 21-40, 41-60) and the left-to-right order of the columns in \
a block, e.g. "number | Vit | Svart" or "Vit | number | Svart".
- Every row has a white ("Vit"/"White") move AND a black ("Svart"/"Black") move, except \
perhaps the last row of the game. The black column is often shaded grey, and \
on some forms the move number is printed BETWEEN the white and the black \
column, so black's move is to the right of the number. Never skip the black \
column.
- Output rows in move order. One row per move number, never the same row twice.
- On a later page the numbering may continue (41, 61, ...) or restart at 1. \
Put the number printed on the form in "number". Keep pages separate, one \
entry in "pages" per image, in image order.
- Only include rows that have something written in them. If a row really \
has only one of the two moves, leave the other one null.

CLOCK TIMES. Players often write the minutes left on their clock next to a \
move, after a slash: "/42", "/5", "/0". Put only the number in "clock" \
("42"). A slash and number is never part of the move.

GAME END. Words like "uppg." (resigned), "remi" (draw), "tid" / "tid." (lost \
on time), the same words in other languages ("resigns", "draw", "time") or a \
result like "1-0" written in a move cell are not moves. Report \
the first one in "end_marker" (text, the column it is in, and the move number \
of its row) and leave it out of the moves. Ignore signatures.

HEADER. First, in "header_notes", briefly say where on the form you find \
each player's name, rating, club and score, and anything that is unclear. \
Then fill "headers". Each header value is ONLY the value as written (e.g. \
"Norrby SK", "1850"): never an explanation, a question or a guess written \
out; doubts go in "header_notes". Fill in every field you can, "" when missing:
- event: the tournament, from the handwritten name and/or a printed title \
that names the tournament (e.g. "Höstturneringen 2025"). Not the club that \
printed the form.
- date: as YYYY.MM.DD. Swedish dates are day/month, so "8/10" is 8 October. \
Use ?? for unknown parts. date_raw: the date exactly as written.
- round ("Rond"/"Round"), board ("Bord"/"Board"), group ("Grupp"/"Klass"/"Section").
- white / black: the players' names. white_elo / black_elo: rating \
("R-tal", "Rat", "Elo", "Rating"), digits only. white_team / black_team: club \
("Klubb"/"Club"/"Team"). Some forms have club and rating on the line under \
the name with no label.
- time_control: as written ("Tid", "Dragserie", "Betänketid", "Time control").
- white_score / black_score: the points boxes ("Poäng"/"Score"): "1", "0" or "½".
- site: the place, only if stated.
Put anything else worth knowing (e.g. moves written in the wrong column) in \
"notes".
`;

const STR = { type: "STRING" };
const HEADER_ORDER = [
  "white", "black", "white_elo", "black_elo", "white_team", "black_team",
  "event", "date_raw", "date", "round", "board", "group", "time_control",
  "white_score", "black_score", "site"];
const CELL = {
  type: "OBJECT",
  nullable: true,
  properties: { move: STR, clock: STR, alternatives: { type: "ARRAY", items: STR }, unclear: { type: "BOOLEAN" } },
  propertyOrdering: ["move", "clock", "alternatives", "unclear"],
  required: ["move"],
};
export const SCHEMA = {
  type: "OBJECT",
  properties: {
    layout: STR,
    header_notes: STR,
    headers: {
      type: "OBJECT",
      properties: Object.fromEntries(HEADER_ORDER.map((k) => [k, STR])),
      // Most valuable first: if a model derails, it's usually late.
      propertyOrdering: HEADER_ORDER,
    },
    pages: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          rows: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { number: { type: "INTEGER" }, white: CELL, black: CELL },
              propertyOrdering: ["number", "white", "black"],
              required: ["number"],
            },
          },
        },
        required: ["rows"],
      },
    },
    end_marker: {
      type: "OBJECT",
      nullable: true,
      properties: { text: STR, column: { type: "STRING", enum: ["white", "black"] }, move_number: { type: "INTEGER" } },
    },
    notes: STR,
  },
  // Layout first: describing the form before reading it keeps the columns straight.
  propertyOrdering: ["layout", "header_notes", "headers", "pages", "end_marker", "notes"],
  required: ["layout", "headers", "pages"],
};

export class ReaderError extends Error {}
class Busy extends Error {
  constructor(status, detail) { super(`HTTP ${status} ${detail}`); this.status = status; }
}
class BadAnswer extends Error {}
class BadKey extends ReaderError {}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function requestBody(imageParts, pageNo, pageCount) {
  const parts = [];
  if (pageCount > 1) parts.push({ text: `This is page ${pageNo} of ${pageCount} of the game (sent separately).` });
  imageParts.forEach((p, i) => {
    parts.push({ text: `Image ${i + 1} of ${imageParts.length}:` });
    parts.push(p);
  });
  parts.push({ text: PROMPT });
  return {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS },
  };
}

function parseResponse(payload) {
  const candidate = (payload.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!parts) {
    const reason = (payload.promptFeedback || {}).blockReason || (candidate || {}).finishReason || "no content";
    throw new BadAnswer(`no answer (${reason})`);
  }
  if (candidate.finishReason === "MAX_TOKENS") throw new BadAnswer("the answer was cut off (too long)");
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadAnswer("not valid JSON: " + text.slice(0, 200));
  }
}

export class GeminiReader {
  constructor(apiKey, { careful = false, models = null, fallbacks = null } = {}) {
    if (!apiKey) throw new BadKey("No Gemini key yet. Add your free key under Settings.");
    this.apiKey = apiKey;
    this.models = models || (careful ? CAREFUL_MODELS : MODELS);
    this.fallbacks = (fallbacks || (careful ? CAREFUL_FALLBACK_MODELS : FALLBACK_MODELS))
      .filter((m) => !this.models.includes(m));
    this.usedModels = new Set();
  }

  /** images: [{blob, type}] in page order. Each page is read in its own
   *  request, in parallel, so a two-page game takes about as long as one. */
  async read(images) {
    const parts = await Promise.all(images.map(async (img) =>
      ({ inline_data: { mime_type: img.type || "image/jpeg", data: await toBase64(img.blob) } })));
    if (parts.length <= 1) return this.readPage(parts, 1, 1);
    const pages = await Promise.all(parts.map((p, i) => this.readPage([p], i + 1, parts.length)));
    return mergePages(pages);
  }

  /** Read one page with all models in parallel; fall back one by one. */
  async readPage(imageParts, pageNo, pageCount) {
    const body = JSON.stringify(requestBody(imageParts, pageNo, pageCount));
    const results = await Promise.all(this.models.map((m) => this.tryModel(m, body)));
    const readings = results.filter((r) => r.reading).map((r) => r.reading);
    const errors = results.filter((r) => r.error).map((r) => r.error);
    for (const model of this.fallbacks) {
      if (readings.length) break;
      const r = await this.tryModel(model, body);
      if (r.reading) readings.push(r.reading);
      else errors.push(r.error);
    }
    if (!readings.length) {
      throw new ReaderError(`Gemini couldn't read page ${pageNo} right now (tried ` +
        `${[...this.models, ...this.fallbacks].join(", ")}). Please try again in a few minutes. ` +
        `Details: ${errors[errors.length - 1]}`);
    }
    return combineReadings(readings);
  }

  /** {reading} or {error}. Bad keys and network trouble are thrown. */
  async tryModel(model, body) {
    let error = null;
    for (const pause of [...RETRY_PAUSES_MS, null]) {
      try {
        const reading = parseResponse(await this.post(model, body));
        this.usedModels.add(model);
        return { reading };
      } catch (e) {
        if (e instanceof BadAnswer) return { error: `${model}: ${e.message}` };  // e.g. stuck repeating itself
        if (!(e instanceof Busy)) throw e;
        error = `${model}: ${e.message}`;
        if (pause === null || e.status === 429) break;  // out of quota: no point in waiting a few seconds
        await sleep(pause);
      }
    }
    return { error };
  }

  async post(model, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(API_URL.replace("{model}", model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Busy(504, "no answer within 3 minutes");
      throw new ReaderError("Could not reach Gemini. Check your internet connection.");
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok) return resp.json();
    let detail = await resp.text();
    try { detail = JSON.parse(detail).error.message; } catch { /* keep the raw text */ }
    if (RETRY_STATUS.has(resp.status)) throw new Busy(resp.status, detail);
    if ([400, 401, 403].includes(resp.status) && /api key|permission|unauthori[sz]ed/i.test(detail)) {
      throw new BadKey("Gemini didn't accept the key. Check it under Settings. (" + detail + ")");
    }
    throw new ReaderError(`Gemini returned HTTP ${resp.status}: ${detail}`);
  }
}

/** A cheap call that tells whether a key works, for the settings screen. */
export async function checkKey(apiKey) {
  const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
    headers: { "x-goog-api-key": apiKey },
  }).catch(() => null);
  if (!resp) return { ok: false, message: "Could not reach Google. Check your internet connection." };
  if (resp.ok) return { ok: true, message: "The key works." };
  let detail = await resp.text();
  try { detail = JSON.parse(detail).error.message; } catch { /* keep the raw text */ }
  return { ok: false, message: "Google didn't accept the key: " + detail };
}
