// Rewrite the expected answers in the answer keys from the app's current
// behaviour:   npm run golden
//
// The answer keys (web/tests/golden/public.json, and tests/private/golden.json
// where it exists) hold scoresheet readings and what the app must make of
// them. `npm test` checks the app against them. When the app's behaviour is
// changed on purpose, run this and review the differences (git diff) before
// committing: every changed line is a game that now comes out differently.
//
// The inputs were first produced by the original Python version (public-
// domain games with simulated handwriting slips, and real scoresheets).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { deriveResult, timeControlToPgn } from "../web/core/pgn.js";
import { processGame } from "../web/core/pipeline.js";
import { combineReadings, flatten, mergePages, normalizeReading, parseWrittenDate } from "../web/core/reading.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [join(root, "web", "tests", "golden", "public.json"), join(root, "tests", "private", "golden.json")];

export function summarize(resolution) {
  return {
    counts: resolution.counts,
    complete: resolution.complete,
    checkmate: resolution.checkmate,
    plies: resolution.plies.map((p) => ({
      status: p.status, san: p.san, uci: p.uci, corrected: p.corrected, mirrored: p.mirrored,
      hint: p.hint,
      suggestion: p.suggestion && { action: p.suggestion.action, index: p.suggestion.index,
                                    san: p.suggestion.san, message: p.suggestion.message },
      candidates: p.candidates.map((c) => c.san),
      number: p.number, color: p.color,
    })),
  };
}

/** What the app makes of one answer-key case. */
export function runCase(c) {
  if (c.kind === "process") {
    const out = processGame({ ...c.input.headers }, c.input.plies, c.input.end_marker);
    return { resolution: summarize(out.resolution), pgn: out.pgn, result: out.result,
             derived_result: out.derived_result, result_warning: out.result_warning };
  }
  const perPage = c.input.pages_by_model.map((models) => combineReadings(models));
  const merged = perPage.length === 1 ? perPage[0] : mergePages(perPage);
  const reading = normalizeReading(merged);
  const out = processGame({ ...reading.headers }, flatten(reading), reading.end_marker);
  return { reading, resolution: summarize(out.resolution), pgn: out.pgn, result: out.result,
           result_warning: out.result_warning };
}

export function runFunctions(functions) {
  return {
    time_control: functions.time_control.map(([text]) => [text, timeControlToPgn(text)]),
    written_date: functions.written_date.map(([text]) => [text, parseWrittenDate(text)]),
    derive_result: functions.derive_result.map(([h, e, m]) => [h, e, m, deriveResult(h, e, m)]),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const file of FILES) {
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, "utf8"));
    let changed = 0;
    for (const c of data.cases) {
      const expected = runCase(c);
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), c.expected)) {
        c.expected = expected;  // only real changes, so the diff shows just those
        changed++;
      }
    }
    if (data.functions) data.functions = runFunctions(data.functions);
    writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
    console.log(`${file.slice(root.length + 1)}: ${data.cases.length} cases, ${changed} changed`);
  }
}
