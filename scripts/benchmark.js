// Read real scoresheets with the real Gemini and count misreadings:
//   npm run benchmark            fast reading (the default)
//   npm run benchmark -- --careful --runs=3
//
// Use it after changing the AI instructions (web/core/gemini.js) or models.
// Needs GEMINI_API_KEY in .env and a private list of scoresheets with their
// correct games in tests/private/benchmark.json (never committed):
//   {"games": [{"name": "...", "photos": ["path.jpg", ...], "expected": "path.pgn"}]}
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GeminiReader } from "../web/core/gemini.js";
import { startReview } from "../web/core/pipeline.js";
import { Chess } from "../web/vendor/chess.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const careful = args.includes("--careful");
const runs = Number((args.find((a) => a.startsWith("--runs=")) || "--runs=1").split("=")[1]);

const envFile = join(root, ".env");
const env = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {};
const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
const listFile = join(root, "tests", "private", "benchmark.json");
if (!key || !existsSync(listFile)) {
  console.log("Needs GEMINI_API_KEY (in .env) and tests/private/benchmark.json.");
  process.exit(1);
}

const expectedMoves = (file) => {
  const c = new Chess();
  c.loadPgn(readFileSync(join(root, file), "utf8"));
  return c.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
};

for (const game of JSON.parse(readFileSync(listFile, "utf8")).games) {
  const ref = expectedMoves(game.expected);
  for (let run = 1; run <= runs; run++) {
    const reader = new GeminiReader(key, { careful });
    const started = performance.now();
    try {
      const raw = await reader.read(game.photos.map((p) => ({ blob: new Blob([readFileSync(join(root, p))]), type: "image/jpeg" })));
      const out = startReview(raw);
      const plies = out.resolution.plies;
      const got = plies.map((p) => p.uci);
      const wrong = ref.filter((u, i) => got[i] !== u).length + Math.abs(ref.length - got.length);
      // A misreading nobody is told about: wrong, marked OK, and the move before was right.
      const silent = ref.filter((u, i) => got[i] && got[i] !== u && plies[i].status === "ok" &&
                                          (i === 0 || got[i - 1] === ref[i - 1])).length;
      const c = out.resolution.counts;
      console.log(`${game.name} #${run}: ${((performance.now() - started) / 1000).toFixed(0)} s, ` +
        `${[...reader.usedModels].join("+")}, ${out.notation}, wrong ${wrong}/${ref.length}, silent ${silent}, ` +
        `flagged ${c.check + c.fail}, header fields ${Object.values(out.headers).filter(Boolean).length}`);
    } catch (e) {
      console.log(`${game.name} #${run}: FAILED ${e.message.slice(0, 160)}`);
    }
  }
}
