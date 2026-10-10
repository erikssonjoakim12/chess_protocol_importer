// Bulk import: grouping photos (pages) into games.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { groupPages } from "../core/grouping.js";
import { normalizeReading } from "../core/reading.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A single-page reading: rows from..to, with or without names. */
function page({ from, to, white = "", black = "", end = null }) {
  const rows = [];
  for (let n = from; n <= to; n++) rows.push({ number: n, white: { move: "e4" }, black: { move: "e5" } });
  return normalizeReading({
    headers: { white, black }, pages: [{ rows }],
    end_marker: end ? { text: end, column: "black", move_number: to } : null,
  });
}

const groups = (pages) => groupPages(pages).groups;

test("a page without names whose moves continue joins the game", () => {
  assert.deepEqual(groups([page({ from: 1, to: 40, white: "A", black: "B" }), page({ from: 41, to: 68 })]), [[0, 1]]);
});

test("a second page that restarts at 1 joins a full first page", () => {
  assert.deepEqual(groups([page({ from: 1, to: 60, white: "A", black: "B" }), page({ from: 1, to: 12 })]), [[0, 1]]);
});

test("three pages chain into one game", () => {
  assert.deepEqual(groups([
    page({ from: 1, to: 40, white: "A", black: "B" }), page({ from: 41, to: 80 }), page({ from: 81, to: 95 }),
  ]), [[0, 1, 2]]);
});

test("a page with other players starts a new game", () => {
  assert.deepEqual(groups([
    page({ from: 1, to: 30, white: "A", black: "B" }), page({ from: 1, to: 25, white: "C", black: "D" }),
  ]), [[0], [1]]);
});

test("a page repeating the same names, moves continuing, is a later page", () => {
  assert.deepEqual(groups([
    page({ from: 1, to: 40, white: "A", black: "B" }), page({ from: 41, to: 50, white: "a", black: "b " }),
  ]), [[0, 1]]);
});

test("after a game that ended, the next photo is a new game", () => {
  assert.deepEqual(groups([page({ from: 1, to: 40, white: "A", black: "B", end: "uppg." }), page({ from: 41, to: 45 })]), [[0], [1]]);
});

test("a short game followed by an unnamed page that restarts at 1: not joined", () => {
  // The first page isn't full, so a page starting at 1 is a different game.
  assert.deepEqual(groups([page({ from: 1, to: 15, white: "A", black: "B" }), page({ from: 1, to: 30 })]), [[0], [1]]);
});

test("a mix of games", () => {
  assert.deepEqual(groups([
    page({ from: 1, to: 40, white: "A", black: "B" }), page({ from: 41, to: 52 }),  // game 1, two pages
    page({ from: 1, to: 33, white: "C", black: "D", end: "remi" }),               // game 2
    page({ from: 1, to: 60, white: "E", black: "F" }), page({ from: 1, to: 8 }),  // game 3, numbering restarts
  ]), [[0, 1], [2], [3, 4]]);
});

// A real two-page game, read page by page (private test data, where it exists).
const real = join(here, "..", "..", "tests", "private", "game1_reading.json");
test("a real two-page scoresheet", { skip: !existsSync(real) && "private test data not available" }, () => {
  const reading = JSON.parse(readFileSync(real, "utf8"));
  const pages = reading.pages.map((p, i) => normalizeReading({ ...reading, headers: i ? {} : reading.headers, pages: [p],
                                                              end_marker: i === reading.pages.length - 1 ? reading.end_marker : null }));
  assert.deepEqual(groups(pages), [[0, 1]]);
});
