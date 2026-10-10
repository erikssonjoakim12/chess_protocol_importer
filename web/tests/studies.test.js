// Bulk import: suggested studies, chapter names and order.
import assert from "node:assert/strict";
import { test } from "node:test";

import { chapterName, chapterOrder, nameSimilarity, studyNameFor, suggestStudies } from "../core/studies.js";

const game = (id, event, date, round, white = "W", black = "B") => ({ id, headers: { event, date, round, white, black } });

test("study names come from year and event", () => {
  assert.equal(studyNameFor({ event: "MAS Öppna KM", date: "2026.10.08" }), "2026 MAS Öppna KM");
  assert.equal(studyNameFor({ event: "LASK Open 2026", date: "2026.10.06" }), "2026 LASK Open");  // no year twice
  assert.equal(studyNameFor({ event: "Skol-SM", date: "????.??.??" }), "Skol-SM");
  assert.equal(studyNameFor({ event: "", date: "2026.10.06" }), null);
});

test("event names read slightly differently still match", () => {
  assert.ok(nameSimilarity("2026 MAS Öppna KM", "2026 MAS öppen KM") >= 0.8);
  assert.ok(nameSimilarity("2026 MAS Öppna KM", "2026 LASK Open") < 0.8);
});

test("one study per event, read differently or not", () => {
  const { studies, studyOf } = suggestStudies([
    game("g1", "MAS Öppna KM", "2026.10.01", "1"),
    game("g2", "MAS öppen KM", "2026.10.08", "2"),
    game("g3", "LASK Open 2026", "2026.10.06", "3"),
    game("g4", "MAS Öppna KM", "2025.10.02", "1"),   // the same event a year earlier: its own study
  ]);
  assert.deepEqual(studies.map((s) => [s.name, s.gameIds]), [
    ["2026 MAS Öppna KM", ["g1", "g2"]], ["2026 LASK Open", ["g3"]], ["2025 MAS Öppna KM", ["g4"]],
  ]);
  assert.equal(studyOf.g2, studyOf.g1);
});

test("an existing study with a matching name is used", () => {
  const { studies } = suggestStudies([game("g1", "MAS öppen KM", "2026.10.08", "3")],
                                     [{ id: "ABCDEFGH", name: "2026 MAS Öppna KM" }, { id: "XYZ12345", name: "Openings" }]);
  assert.deepEqual(studies[0], { key: "s0", name: "2026 MAS Öppna KM", existingId: "ABCDEFGH", gameIds: ["g1"] });
});

test("everything in one study", () => {
  const { studies } = suggestStudies([game("g1", "A", "2026.01.01"), game("g2", "B", "2025.01.01")], [], "single", "My old games");
  assert.deepEqual(studies.map((s) => [s.name, s.gameIds]), [["My old games", ["g1", "g2"]]]);
});

test("games without event", () => {
  const { studies } = suggestStudies([game("g1", "", "2006.07.02"), game("g2", "", "")]);
  assert.deepEqual(studies.map((s) => s.name), ["Games 2006", "Games without event"]);
});

test("chapters are named for the side you played", () => {
  const h = { round: "3", white: "Lars", black: "Joakim" };
  assert.equal(chapterName(h, "black"), "Rond 3 vs. Lars");
  assert.equal(chapterName(h, "white"), "Rond 3 vs. Joakim");
  assert.equal(chapterName(h), "Rond 3: Lars – Joakim");
  assert.equal(chapterName({ white: "A", black: "B" }), "A – B");
});

test("chapters are ordered by round, then date", () => {
  const order = chapterOrder([game("r3", "E", "2026.10.08", "3"), game("r1", "E", "2026.10.01", "1"),
                              game("none", "E", "2026.10.02", ""), game("r2b", "E", "2026.10.05", "2"),
                              game("r2a", "E", "2026.10.04", "2")]);
  assert.deepEqual(order.map((g) => g.id), ["r1", "r2a", "r2b", "r3", "none"]);
});
