// Open the app on this computer:   node scripts/serve.js        (or double-click start.bat)
//                                  node scripts/serve.js --lan  (also from your phone on the same Wi-Fi)
// The app is just the files in web/ and runs in the browser; this only serves
// them locally (browsers don't run apps straight from a folder).
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const args = process.argv.slice(2);
const lan = args.includes("--lan");
const port = Number((args.find((a) => a.startsWith("--port=")) || "--port=8000").split("=")[1]);
const noBrowser = args.includes("--no-browser");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webmanifest": "application/manifest+json", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(WEB, path));
  if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }  // nothing outside web/
  try {
    const body = await readFile(file);
    // Always the latest files while developing.
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE" || e.code === "EACCES") {
    console.log(`\n  Port ${port} is already in use, probably by the app itself in another window` +
                `\n  (or an old copy still running). Just open http://127.0.0.1:${port}, or close` +
                `\n  the other window and start again.\n`);
  } else {
    console.log("\n  Could not start: " + e.message + "\n");
  }
  process.exit(1);
});

server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Open ${url}`);
  if (lan) {
    const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (ip) console.log(`  From your phone (same Wi-Fi): http://${ip.address}:${port}`);
    console.log("  (Installing the app on a phone needs the published https version.)");
  }
  console.log("  Close this window or press Ctrl+C to stop.\n");
  if (!noBrowser) exec(process.platform === "win32" ? `start "" "${url}"` : `open "${url}" || xdg-open "${url}"`);
});
