// Copies third-party code the app needs into web/vendor/, so the published app
// loads nothing from other websites.   npm run vendor
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web", "vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["node_modules/chess.js/dist/esm/chess.js", "chess.js"],
  ["node_modules/chess.js/LICENSE", "chess.js.LICENSE.txt"],
];
for (const [from, to] of files) {
  copyFileSync(join(root, from), join(out, to));
  console.log("copied", from, "->", "web/vendor/" + to);
}
