// Answer keys: scoresheet readings and exactly what the app must make of them
// (moves, flags, hints, suggestions, PGN text). After a deliberate change in
// behaviour, update them with `npm run golden` and review the diff.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveResult, timeControlToPgn } from "../core/pgn.js";
import { parseWrittenDate } from "../core/reading.js";
import { runCase as run } from "../../scripts/make_golden.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "golden", "public.json");
// Real scoresheets: kept out of git, only checked where the file exists.
const PRIVATE = join(here, "..", "..", "tests", "private", "golden.json");

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
