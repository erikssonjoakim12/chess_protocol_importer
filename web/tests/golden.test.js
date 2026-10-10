// The JavaScript version must give exactly the same answers as the Python
// version (the reference) on the same scoresheets: moves, flags, hints,
// suggestions and the PGN text.  Regenerate the answers with
//   .venv/Scripts/python scripts/make_golden.py
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveResult, timeControlToPgn } from "../core/pgn.js";
import { processGame } from "../core/pipeline.js";
import { combineReadings, flatten, mergePages, normalizeReading, parseWrittenDate } from "../core/reading.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "golden", "public.json");
// Real scoresheets: kept out of git, only checked where the file exists.
const PRIVATE = join(here, "..", "..", "tests", "private", "golden.json");

function summarize(resolution) {
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

function run(c) {
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

function checkCases(file) {
  const { cases, functions } = JSON.parse(readFileSync(file, "utf8"));
  for (const c of cases) {
    test(c.name, () => {
      const got = run(c);
      // Ply by ply first, so a difference points at the exact move.
      const want = c.expected.resolution.plies;
      got.resolution.plies.forEach((p, i) => assert.deepEqual(p, want[i], `ply ${i}`));
      assert.deepEqual(got, c.expected);
    });
  }
  if (functions) {
    test("time control", () => {
      for (const [text, pgn] of functions.time_control) assert.equal(timeControlToPgn(text), pgn, text);
    });
    test("written date", () => {
      for (const [text, date] of functions.written_date) assert.equal(parseWrittenDate(text), date, text);
    });
    test("result", () => {
      for (const [h, e, m, want] of functions.derive_result) assert.deepEqual(deriveResult(h, e, m), want);
    });
  }
}

checkCases(PUBLIC);
if (existsSync(PRIVATE)) checkCases(PRIVATE);
