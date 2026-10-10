// Scoresheets in other notations. Swedish is covered move for move by the
// answer keys (golden.test.js); these check English and the detection.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { handwrittenKey, sanToLocal } from "../core/notation.js";
import { NOTATIONS } from "../core/notations.js";
import { detectNotation, processGame, startReview } from "../core/pipeline.js";
import { resolve } from "../core/resolver.js";

const here = dirname(fileURLToPath(import.meta.url));
const EN = NOTATIONS.english;
// Morphy's Opera Game (1858) as standard SAN.
const OPERA = ("e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 " +
               "Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#").split(" ");
const swedish = (san) => sanToLocal(san, NOTATIONS.swedish);
const plies = (texts) => texts.map((text) => ({ text }));

test("English keys and display", () => {
  assert.equal(handwrittenKey("Nxd4+", EN), "Nd4");
  assert.equal(handwrittenKey("Sbd2", EN), "Nbd2");      // a Swedish letter on an English sheet
  assert.equal(handwrittenKey("e8=Q", EN), "e8Q");
  assert.equal(handwrittenKey("nf3", EN), "Nf3");         // sloppy lower-case piece letter
  assert.equal(handwrittenKey("bxc3", EN), "bc3");        // ...but b is a file
  assert.equal(sanToLocal("Qxd8+", EN), "Qxd8+");
  assert.equal(sanToLocal("Qxd8+"), "Dxd8+");             // Swedish by default
});

test("an English game is read in English", () => {
  const r = resolve(plies(OPERA), "english");
  assert.ok(r.complete);
  assert.equal(r.counts.ok, OPERA.length);
  assert.deepEqual(r.plies.map((p) => p.san), OPERA);
  assert.equal(r.plies[13].san_local, "Qe7");
});

test("English handwriting slips are caught", () => {
  const texts = [...OPERA];
  texts[13] = "Qe8";   // 7...Qe7
  texts[30] = "Q88+";  // 16.Qb8+ (b written like an 8)
  const r = resolve(plies(texts), "english");
  assert.ok(r.complete);
  assert.deepEqual(r.plies.map((p) => p.san), OPERA);
});

test("the notation is detected from the moves", () => {
  assert.equal(detectNotation(plies(OPERA)), "english");
  assert.equal(detectNotation(plies(OPERA.map(swedish))), "swedish");
  assert.equal(detectNotation(plies(["e4", "e5", "d4", "exd4"])), "swedish");  // no piece moves: default
});

test("a reading of an English sheet comes out in English", () => {
  const demo = JSON.parse(readFileSync(join(here, "..", "demo.json"), "utf8"));
  const english = structuredClone(demo);
  let i = 0;
  for (const row of english.pages[0].rows) {
    for (const color of ["white", "black"]) {
      if (row[color]) row[color].move = OPERA[i];
      i++;
    }
  }
  const out = startReview(english);
  assert.equal(out.detected_notation, "english");
  assert.equal(out.notation, "english");
  assert.ok(out.resolution.complete);
  const swedishOut = startReview(demo);
  assert.equal(swedishOut.detected_notation, "swedish");
});

test("the same game gives the same PGN in either notation", () => {
  const en = processGame({}, plies(OPERA), null, "english");
  const sv = processGame({}, plies(OPERA.map(swedish)), null, "swedish");
  assert.equal(en.pgn, sv.pgn);
});
