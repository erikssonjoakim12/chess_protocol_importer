// Turn a list of handwritten plies into legal moves.
//
// The game is replayed from the start. For each ply the handwritten text (plus
// any alternative readings) is compared to every legal move in the position, and
// the closest one is chosen. Uncertain choices are flagged for review; when no
// legal move is close enough the replay stops there, because every following
// move would be played in a wrong position anyway.
//
// When the replay stops, earlier moves are revisited: a move that was legal but
// wrongly written (say c3 for f3, mirrored) often only shows up a few moves
// later. If another reading of an earlier move makes the rest of the game fit,
// that is offered as a suggestion.
import { Chess } from "../vendor/chess.js";
import { cmp, handwrittenKey as keyIn, notation, sanToLocal, similarity as similarityIn } from "./notation.js";

// The notation of the sheet being resolved (notations.js). Set at the start of
// resolve(); everything below matches handwriting in that notation.
let nt = notation();
const handwrittenKey = (text) => keyIn(text, nt);
const local = (san) => sanToLocal(san, nt);
const similarity = (a, b, mirror) => similarityIn(a, b, mirror, nt);

export const STATUS_OK = "ok";            // exact match, or confirmed by the user
export const STATUS_CHECK = "check";      // best guess, please review
export const STATUS_FAIL = "fail";        // nothing fits, replay stops here
export const STATUS_PENDING = "pending";  // after a failure, not replayed

const EXACT = 1.0;
const LOOSE = 0.97;         // matches when ignoring disambiguation, e.g. 'Sd2' for 'Nbd2'
const ALT_FACTOR = 0.95;    // alternative readings count slightly less than the main one
const MIN_SCORE = 0.5;      // below this nothing fits
const MIN_MARGIN = 0.12;    // best must beat the runner-up by this much to be trusted
const AUTO_FIX_SCORE = 0.8;    // a single look-alike slip scores 0.82 ('e9') to 0.88 ('Sd7')
const AUTO_FIX_MARGIN = 0.15;  // ...and is only trusted when nothing else is close
const MAX_CANDIDATES = 6;
const BACKTRACK_PLIES = 10;    // how far back to look for a misread move
const BACKTRACK_CANDIDATES = 6;
const LOOKAHEAD_PLIES = 12;    // how far ahead to test a move chosen for an empty/unreadable cell
const LOOKAHEAD_MIN_FIT = 4;   // following plies that must fit before a move is proposed
const LOOKAHEAD_MARGIN = 0.1;  // ...and by how much better than the next best move
const LOOKAHEAD_POOL = 16;     // how many look-alike moves to test for an uncertain ply
const LOOKAHEAD_POOL_MIN = 0.3;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ---------- Positions (a thin layer over chess.js) ----------

function load(fen) {
  return new Chess(fen, { skipValidation: true });
}

const square = (sq0x88) => "abcdefgh"[sq0x88 & 15] + (8 - (sq0x88 >> 4));
const CASTLING_BITS = 32 | 64;  // chess.js BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE
const legalCache = new Map();

/** Legal moves as {uci, san, from, to, piece, promotion, castling, after}.
 *
 *  chess.js's moves({verbose: true}) is about 12x slower than needed here: for
 *  every move it generates all moves again (for the SAN) and builds two FEN
 *  strings. Like chess.js itself does inside its Move class, we use its
 *  internal _moves/_moveToSan/_makeMove/_undoMove, and only work out the
 *  position after a move (`after`) when it is actually needed. chess.js is
 *  pinned (web/vendor, 1.4.0); the answer-key tests catch any change. */
function legalMoves(fen) {
  let moves = legalCache.get(fen);
  if (moves) return moves;
  const board = load(fen);
  const internal = board._moves({ legal: true });
  moves = internal.map((m) => {
    const from = square(m.from), to = square(m.to), promotion = m.promotion || "";
    let after = null;
    return {
      uci: from + to + promotion,
      san: board._moveToSan(m, internal),
      from, to, piece: m.piece, promotion,
      castling: Boolean(m.flags & CASTLING_BITS),
      get after() {
        if (after === null) {
          board._makeMove(m);
          after = board.fen();
          board._undoMove();
        }
        return after;
      },
    };
  });
  if (legalCache.size > RANK_CACHE_MAX) legalCache.clear();
  legalCache.set(fen, moves);
  return moves;
}

function play(fen, uci) {
  const board = load(fen);
  board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
  return board.fen();
}

const turnOf = (fen) => fen.split(" ")[1];
const moveNumberOf = (fen) => parseInt(fen.split(" ")[5], 10);

/** The same position with the other side to move (a "null move"). */
function flipTurn(fen) {
  const f = fen.split(" ");
  const black = f[1] === "b";
  f[1] = black ? "w" : "b";
  f[3] = "-";
  f[4] = String(parseInt(f[4], 10) + 1);
  if (black) f[5] = String(parseInt(f[5], 10) + 1);
  return f.join(" ");
}

// ---------- Matching handwriting to moves ----------

/** [strictKey, looseKeys] for a legal move, in Swedish form. */
function moveKeys(move) {
  const strict = handwrittenKey(local(move.san));
  const loose = new Set();
  if (move.castling) return [strict, loose];
  let promo = "";
  if (move.promotion) promo = local("=" + move.promotion.toUpperCase()).slice(1);
  if (move.piece === "p") {
    loose.add(move.to + promo);
    loose.add(move.from + move.to + promo);
  } else {
    const letter = local(move.piece.toUpperCase());
    loose.add(letter + move.to);
    loose.add(letter + move.from + move.to);
  }
  loose.delete(strict);
  return [strict, loose];
}

function readings(text, alternatives) {
  return [[handwrittenKey(text), 1.0], ...(alternatives || []).map((a) => [handwrittenKey(a), ALT_FACTOR])];
}

function score(reads, strict, loose, mirror = true) {
  let best = 0.0;
  for (const [key, weight] of reads) {
    if (!key) continue;
    let s;
    if (key === strict) s = EXACT;
    else if (loose.has(key)) s = LOOSE;
    else {
      s = similarity(key, strict, mirror);
      for (const k of loose) s = Math.max(s, similarity(key, k, mirror));
    }
    best = Math.max(best, s * weight);
  }
  return best;
}

// Looking ahead tries the same plies in the same positions over and over,
// and every edit replays the whole game, so this cache matters.
const rankCache = new Map();
const RANK_CACHE_MAX = 200000;

/** All legal moves, best match first: [{score, move}], move as from legalMoves(). */
export function rankMoves(fen, text, alternatives = []) {
  const key = nt.id + "|" + fen + "\u0000" + (text || "") + "\u0000" + (alternatives || []).join("\u0001");
  let ranked = rankCache.get(key);
  if (!ranked) {
    const reads = readings(text || "", alternatives);
    ranked = legalMoves(fen).map((move) => {
      const [strict, loose] = moveKeys(move);
      return { score: score(reads, strict, loose), move };
    });
    ranked.sort((a, b) => b.score - a.score || cmp(a.move.san, b.move.san));
    if (rankCache.size > RANK_CACHE_MAX) rankCache.clear();
    rankCache.set(key, ranked);
  }
  return ranked;
}

/** True if the move only matches when reading a square mirrored. */
function needsMirror(move, text, alternatives) {
  const [strict, loose] = moveKeys(move);
  return score(readings(text, alternatives), strict, loose, false) < AUTO_FIX_SCORE;
}

/** Map {reading -> san} for each reading that on its own matches a legal move
 *  (ignoring check signs, capture marks and disambiguation). */
function exactReadings(fen, text, alternatives) {
  const found = new Map();
  for (const reading of [text, ...(alternatives || [])]) {
    if (!reading || found.has(reading)) continue;
    const ranked = rankMoves(fen, reading);
    if (ranked.length && ranked[0].score >= LOOSE && (ranked.length === 1 || ranked[1].score < ranked[0].score)) {
      found.set(reading, ranked[0].move.san);
    }
  }
  return found;
}

/** Does the text fit the *other* side? Then a move was probably skipped. */
function missingMoveHint(fen, text, alternatives) {
  if (load(fen).inCheck()) return null;
  const flipped = flipTurn(fen);
  const ranked = rankMoves(flipped, text, alternatives);
  if (ranked.length && ranked[0].score >= LOOSE) {
    const side = turnOf(flipped) === "w" ? "white" : "black";
    return `'${text}' looks like a ${side} move. A move may be missing before this one, ` +
           "or white and black may have been swapped.";
  }
  return null;
}

const plyText = (p) => (p && p.text) || "";
const plyAlts = (p) => (p && p.alternatives) || [];

/** Find an earlier ply whose other reading makes everything up to and
 *  including `failIndex` fit (that last ply scoring at least `lastNeeds`).
 *  `history[j]` is [fenBefore, chosenUci, certain] for the plies already
 *  played. Clearly read (certain) moves are only questioned when
 *  `questionCertain`: when the later move really doesn't fit. */
function suggestEarlierFix(plies, history, failIndex, lastNeeds = AUTO_FIX_SCORE, questionCertain = true) {
  const first = Math.max(0, failIndex - BACKTRACK_PLIES);
  for (let j = failIndex - 1; j >= first; j--) {
    const [fen, chosen, certain] = history[j];
    if (certain && !questionCertain) continue;
    const text = plyText(plies[j]);
    for (const { score: s, move } of rankMoves(fen, text, plyAlts(plies[j])).slice(0, BACKTRACK_CANDIDATES)) {
      if (move.uci === chosen || s < MIN_SCORE) continue;
      let trial = move.after;
      let fits = true;
      for (let k = j + 1; k <= failIndex; k++) {
        const ranked = rankMoves(trial, plyText(plies[k]), plyAlts(plies[k]));
        const needed = k === failIndex ? lastNeeds : AUTO_FIX_SCORE;
        if (!ranked.length || ranked[0].score < needed) { fits = false; break; }
        trial = ranked[0].move.after;
      }
      if (fits) {
        const dots = turnOf(fen) === "w" ? "." : "...";
        return {
          action: "replace", index: j, san: move.san, san_local: local(move.san),
          message: `If move ${moveNumberOf(fen)}${dots} was ${local(move.san)} instead of what ` +
                   `is written ('${text}'), the following moves fit.`,
        };
      }
    }
  }
  return null;
}

/** How well the plies from `start` on fit: [summedScore, count], counting
 *  in a row until the first ply that doesn't fit (score < AUTO_FIX_SCORE). */
function followingFit(fen, plies, start) {
  let total = 0.0, n = 0;
  for (let k = start; k < Math.min(plies.length, start + LOOKAHEAD_PLIES); k++) {
    const ranked = rankMoves(fen, plyText(plies[k]), plyAlts(plies[k]));
    if (!ranked.length || ranked[0].score < AUTO_FIX_SCORE) break;
    fen = ranked[0].move.after;
    total += ranked[0].score;
    n += 1;
  }
  return [total, n];
}

/** Every legal move, ranked by how well the plies from `start` fit after it:
 *  [{total, n, move}], best first. */
function lookahead(fen, plies, start) {
  const fits = legalMoves(fen).map((move) => {
    const [total, n] = followingFit(move.after, plies, start);
    return { total, n, move };
  });
  fits.sort((a, b) => b.total - a.total || cmp(a.move.san, b.move.san));
  return fits;
}

/** The single move after which the following plies clearly fit best. */
function uniqueFit(fits, plies, start) {
  const needed = Math.min(LOOKAHEAD_MIN_FIT, plies.length - start);
  if (!fits.length || needed <= 0 || fits[0].n < needed) return null;
  if (fits.length > 1 && fits[0].total - fits[1].total < LOOKAHEAD_MARGIN) return null;
  return fits[0];
}

function fitCandidates(fits) {
  return fits.slice(0, MAX_CANDIDATES).map((f) =>
    ({ san: f.move.san, san_local: local(f.move.san), score: null, fits: f.n }));
}

/** How many following plies must fit to trust a choice made by looking ahead. */
function needed(plies, start) {
  return Math.max(1, Math.min(LOOKAHEAD_MIN_FIT, plies.length - start - 1));
}

const round2 = (x) => Math.round(x * 100) / 100;

/** For an uncertain ply: rank plausible moves by how well the following plies
 *  fit after them (and, second, how well they match the handwriting).
 *  Returns null if nothing follows, else {move, fits, unique, candidates}. */
function pickByFuture(plies, i, ranked, rivals) {
  if (i + 1 >= plies.length) return null;
  const own = new Map(ranked.map((r) => [r.move.uci, r.score]));
  const need = needed(plies, i);
  const scoreMoves = (pool) => pool.map(({ score: s, move }) => {
    const [total, n] = followingFit(move.after, plies, i + 1);
    return { total: total + s, n, move };
  });
  const pool = ranked.filter((r) => r.score >= LOOKAHEAD_POOL_MIN).slice(0, LOOKAHEAD_POOL);
  const poolMoves = new Set(pool.map((r) => r.move.uci));
  pool.push(...ranked.filter((r) => rivals.includes(r.move.san) && !poolMoves.has(r.move.uci)));
  let scored = scoreMoves(pool);
  if (!scored.some((s) => s.n >= need)) {
    // None of the look-alikes lets the game go on: try every legal move.
    scored = scored.concat(scoreMoves(ranked.filter((r) => !poolMoves.has(r.move.uci))));
  }
  scored.sort((a, b) => b.total - a.total || cmp(a.move.san, b.move.san));
  const candidates = scored.slice(0, MAX_CANDIDATES).map((s) =>
    ({ san: s.move.san, san_local: local(s.move.san), score: round2(own.get(s.move.uci)), fits: s.n }));
  const best = scored[0];
  const unique = best.n >= need && (scored.length === 1 || best.total - scored[1].total >= LOOKAHEAD_MARGIN);
  return { move: best.move, fits: best.n, unique, candidates };
}

/** A move seems to be missing before ply i: which move makes ply i and the
 *  ones after it fit? */
function suggestInsert(fen, plies, i) {
  const fits = lookahead(fen, plies, i);
  const best = uniqueFit(fits, plies, i) || (fits.length && fits[0].n > 0 ? fits[0] : null);
  if (!best) return null;
  const side = turnOf(fen) === "w" ? "White" : "Black";
  return {
    action: "insert", index: i, san: best.move.san, san_local: local(best.move.san), fits: best.n,
    message: `A move seems to be missing here. If ${side} played ${local(best.move.san)}, ` +
             `the next ${best.n} moves fit.`,
  };
}

function newEntry(i, ply, fen) {
  return {
    index: i,
    number: moveNumberOf(fen),
    color: turnOf(fen) === "w" ? "white" : "black",
    text: (ply.text || "").trim(),
    alternatives: (ply.alternatives || []).filter((a) => a),
    clock: ply.clock || "",
    written_number: ply.written_number ?? null,
    page: ply.page ?? null,
    confirmed: Boolean(ply.confirmed),
    unclear: Boolean(ply.unclear),
    corrected: false,
    mirrored: false,
    san: null, san_local: null, uci: null,
    score: 0.0, candidates: [], legal: [], hint: null, suggestion: null,
    fen_before: fen, fen_after: null,
  };
}

/**
 * Replay plies and pick a legal move for each.
 *
 * `plies` is a list of {text, alternatives?, clock?, unclear?, confirmed?
 * (the user picked this move)}; `notationId` the sheet's notation
 * (notations.js, Swedish by default). Returns the per-ply results and a summary.
 */
export function resolve(plies, notationId) {
  nt = notation(notationId);
  let fen = START_FEN;
  const out = [];
  const history = [];
  let stopped = false;
  for (let i = 0; i < plies.length; i++) {
    const entry = newEntry(i, plies[i], fen);
    const { text, alternatives: alts } = entry;
    out.push(entry);
    if (stopped) {
      entry.status = STATUS_PENDING;
      continue;
    }

    const ranked = rankMoves(fen, text, alts);
    entry.legal = ranked.map((r) => r.move.san).sort(cmp);
    entry.candidates = ranked.slice(0, MAX_CANDIDATES).map((r) =>
      ({ san: r.move.san, san_local: local(r.move.san), score: round2(r.score) }));
    if (!ranked.length) {  // game already over (mate/stalemate) but more moves written
      entry.status = STATUS_FAIL;
      entry.hint = "The game is already over in this position.";
      stopped = true;
      continue;
    }

    const bestScore = ranked[0].score;
    let bestMove = ranked[0].move;
    const runnerUp = ranked.length > 1 ? ranked[1].score : 0.0;
    const margin = bestScore - runnerUp;
    entry.score = round2(bestScore);

    const mirrored = bestScore < LOOSE && needsMirror(bestMove, text, alts);
    entry.mirrored = mirrored;
    // Readings (e.g. from two models) that each fit a legal move exactly.
    const exact = exactReadings(fen, text, alts);
    const rivals = [...new Set(exact.values())].sort(cmp);
    const san = () => local(bestMove.san);

    if (!text && !alts.length) {
      // Nothing written: let the following moves decide.
      const fits = lookahead(fen, plies, i + 1);
      entry.candidates = fitCandidates(fits);
      const unique = uniqueFit(fits, plies, i + 1);
      if (!unique) {
        entry.status = STATUS_FAIL;
        entry.hint = "Nothing was read here. Pick the move from the list; " +
                     "the ones that fit the following moves are first.";
        stopped = true;
        continue;
      }
      bestMove = unique.move;
      entry.status = STATUS_CHECK;
      entry.hint = `Nothing was read here, but only ${san()} fits the following moves. Please confirm.`;
    } else if (entry.confirmed) {
      if (bestScore < LOOSE) {
        entry.status = STATUS_FAIL;
        entry.hint = `${text} is not a legal move here.`;
        stopped = true;
        continue;
      }
      entry.status = STATUS_OK;
    } else if (rivals.length === 1 && rivals.includes(bestMove.san)) {
      entry.status = STATUS_OK;
      if (!exact.has(text)) {
        // The main reading doesn't fit, but another reading fits exactly.
        entry.corrected = true;
        entry.hint = `Read as '${text}' or '${[...exact.keys()].join("' or '")}'; only ${san()} fits.`;
      }
    } else if (!rivals.length && bestScore >= LOOSE && margin > 0) {
      entry.status = STATUS_OK;
    } else if (!rivals.length && !mirrored && !entry.unclear &&
               bestScore >= AUTO_FIX_SCORE && margin >= AUTO_FIX_MARGIN) {
      // A small slip (e.g. a 4 that looks like a 9) with no competitor.
      entry.status = STATUS_OK;
      entry.corrected = true;
      entry.hint = `Read as '${text}', corrected to ${san()}.`;
    } else {
      // Unsure. Let the following moves help: a misread move usually makes
      // the next few moves impossible, the right one doesn't.
      const pick = pickByFuture(plies, i, ranked, rivals);
      let insert = null;
      if (bestScore < LOOSE && missingMoveHint(fen, text, alts)) {
        insert = suggestInsert(fen, plies, i);
        if (insert && pick && insert.fits <= pick.fits) insert = null;  // a misreading explains it better
      }
      if (pick) entry.candidates = pick.candidates;
      if (insert && insert.fits >= needed(plies, i)) {
        entry.status = STATUS_FAIL;
        entry.hint = `'${text}' looks like a ${turnOf(fen) === "w" ? "black" : "white"} move. A move may be ` +
                     "missing before this one, or white and black may have been swapped.";
        entry.suggestion = insert;
        stopped = true;
        continue;
      }
      if (pick && pick.unique) {
        bestMove = pick.move;
        entry.status = STATUS_CHECK;
        if (rivals.length > 1) {
          entry.hint = `The readings differ: ${[...exact.keys()].map((r) => `'${r}'`).join(" or ")}. ` +
                       `${san()} fits the following moves best.`;
        } else if (bestScore < MIN_SCORE || pick.move.uci !== ranked[0].move.uci) {
          entry.hint = `'${text}' doesn't fit, but ${san()} fits the following moves. Please confirm.`;
        } else if (mirrored) {
          entry.hint = `'${text}' doesn't fit, but ${san()} does if a square was written mirrored ` +
                       "(like c/f or 2/7). Please confirm.";
        } else {
          entry.hint = `Read as '${text}', interpreted as ${san()}. Please confirm.`;
        }
      } else if (pick && pick.fits < needed(plies, i)) {
        // Whatever is chosen here, the following moves stop making sense:
        // stop, so there's one clear thing to fix instead of a cascade.
        entry.status = STATUS_FAIL;
        entry.hint = `No move fits both '${text}' and the moves after it. Pick the right move from ` +
                     "the list; the ones that fit the following moves are first.";
        entry.suggestion = insert || suggestEarlierFix(plies, history, i);
        stopped = true;
        continue;
      } else if (rivals.length > 1) {
        entry.status = STATUS_CHECK;
        entry.hint = "The readings differ: " +
          [...exact.entries()].map(([reading, s]) => `'${reading}' (${local(s)})`).join(" or ") +
          ". Which one is right?";
      } else if (bestScore >= MIN_SCORE) {
        entry.status = STATUS_CHECK;
        if (mirrored) {
          entry.hint = `'${text}' doesn't fit, but ${san()} does if a square was written mirrored ` +
                       "(like c/f or 2/7). Please confirm.";
        } else if (margin < MIN_MARGIN) {
          entry.hint = `Several moves fit '${text}'. Is ${san()} right?`;
        } else {
          entry.hint = `Read as '${text}', interpreted as ${san()}.`;
        }
      } else {
        entry.status = STATUS_FAIL;
        entry.hint = `No legal move matches '${text}'. Pick the right move from the list.`;
        entry.suggestion = insert || suggestEarlierFix(plies, history, i);
        stopped = true;
        continue;
      }
    }

    if (entry.status === STATUS_CHECK && text) {
      // Would a different reading of an earlier move make this one exact?
      // A clearly read earlier move is only questioned if this one doesn't
      // really fit (e.g. only after mirroring), not when it merely fits in
      // more than one way ("Sd7": which knight?).
      entry.suggestion = suggestEarlierFix(plies, history, i, LOOSE, bestScore < LOOSE);
    }

    entry.san = bestMove.san;
    entry.san_local = local(bestMove.san);
    entry.uci = bestMove.uci;
    // Clearly read: OK, not auto-corrected, and the readings agreed.
    const certain = entry.status === STATUS_OK && !entry.corrected && !entry.unclear;
    history.push([fen, bestMove.uci, certain]);
    fen = bestMove.after;
    entry.fen_after = fen;
  }

  const counts = { [STATUS_OK]: 0, [STATUS_CHECK]: 0, [STATUS_FAIL]: 0, [STATUS_PENDING]: 0 };
  for (const e of out) counts[e.status] += 1;
  const final = load(fen);
  return {
    plies: out,
    counts,
    complete: counts[STATUS_FAIL] === 0 && counts[STATUS_PENDING] === 0,
    final_fen: fen,
    checkmate: final.isCheckmate(),
    next_number: moveNumberOf(fen),
    next_color: turnOf(fen) === "w" ? "white" : "black",
  };
}

export { play };
