// The page: photos in, review, PGN out. Everything runs in the browser; the
// only outside services are Gemini (with the user's own key) and Lichess.
import { GeminiReader } from "./core/gemini.js";
import { processGame, startReview } from "./core/pipeline.js";
import { getKey } from "./settings.js";

// ---------- State ----------
const state = {
  photos: [],        // [{blob, url, name}] in page order
  plies: [],         // the moves as read and corrected: {text, alternatives, clock, unclear, confirmed, written_number, page}
  headers: {},
  endMarker: null,
  res: null,         // the latest resolution of the plies
  selected: 0,
  flipped: false,
  requestSeq: 0,
  gameId: null,      // the saved-games entry this review belongs to
  lichess: null,     // {url, pgn}: the Lichess game made from this PGN
};

const MAX_SIDE = 2400;     // downscale photos to this many pixels on the long side
const JPEG_QUALITY = 0.88;

const TAG_FIELDS = [
  ["event", "Event"], ["site", "Site"], ["date", "Date (YYYY.MM.DD)"],
  ["round", "Round"], ["board", "Board"], ["group", "Group / section"],
  ["white", "White"], ["white_elo", "White rating"], ["white_team", "White club"],
  ["black", "Black"], ["black_elo", "Black rating"], ["black_team", "Black club"],
  ["time_control", "Time control"],
];
const RESULTS = ["1-0", "0-1", "1/2-1/2", "*"];

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

// ---------- Step 1: photos ----------
const fileInput = $("#file-input");
const dropzone = $("#dropzone");

fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
const cameraInput = $("#camera-input");
cameraInput.addEventListener("change", () => { addFiles(cameraInput.files); cameraInput.value = ""; });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of images) {
    const blob = await downscale(file);
    state.photos.push({ blob, url: URL.createObjectURL(blob), name: file.name });
  }
  renderThumbs();
}

async function downscale(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", JPEG_QUALITY));
  } catch (e) {
    console.warn("Could not downscale, sending original", e);
    return file;
  }
}

function renderThumbs() {
  const list = $("#thumbs");
  list.replaceChildren(...state.photos.map((p, i) => el("li", {},
    el("img", { src: p.url, alt: p.name }),
    el("div", {}, "Page " + (i + 1)),
    el("div", { class: "thumb-actions" },
      el("button", { title: "Move earlier", disabled: i === 0, onclick: () => movePhoto(i, -1) }, "◀"),
      el("button", { title: "Remove", onclick: () => removePhoto(i) }, "✕"),
      el("button", { title: "Move later", disabled: i === state.photos.length - 1, onclick: () => movePhoto(i, 1) }, "▶"),
    ),
  )));
  $("#read-btn").disabled = $("#read-careful-btn").disabled = state.photos.length === 0;
}

function movePhoto(i, delta) {
  const [p] = state.photos.splice(i, 1);
  state.photos.splice(i + delta, 0, p);
  renderThumbs();
}

function removePhoto(i) {
  URL.revokeObjectURL(state.photos[i].url);
  state.photos.splice(i, 1);
  renderThumbs();
}

$("#read-btn").addEventListener("click", () => readScoresheet(false));
$("#read-careful-btn").addEventListener("click", () => readScoresheet(true));

async function readScoresheet(careful) {
  const buttons = [$("#read-btn"), $("#read-careful-btn")];
  const status = $("#read-status");
  const errorBox = $("#read-error");
  if (!getKey()) {
    // First time: show the key setup right here instead of an error.
    $("#read-error").textContent = "First connect your free Gemini key (see above), then read the scoresheet.";
    $("#read-error").hidden = false;
    $("#settings").hidden = false;
    $("#settings").scrollIntoView({ behavior: "smooth" });
    $("#key-input").focus({ preventScroll: true });
    return;
  }
  if (!navigator.onLine) {
    $("#read-error").textContent = "You're offline. Reading a scoresheet needs internet; saved games work offline.";
    $("#read-error").hidden = false;
    return;
  }
  if (state.res && !confirm("Read the photos again? The current game and your corrections stay in Saved games.")) return;
  buttons.forEach((b) => { b.disabled = true; });
  errorBox.hidden = true;
  status.replaceChildren(el("span", { class: "spinner" }), " Reading the handwriting… " +
    (careful ? "reading carefully takes 1–2 minutes." : "this usually takes 10–20 seconds."));
  try {
    const reader = new GeminiReader(getKey(), { careful });
    const raw = await reader.read(state.photos.map((p) => ({ blob: p.blob, type: p.blob.type || "image/jpeg" })));
    beginReview(startReview(raw));
    status.textContent = "Read with " + [...reader.usedModels].sort().join(", ") + ".";
  } catch (e) {
    errorBox.textContent = e.message;
    errorBox.hidden = false;
    status.textContent = "";
  } finally {
    buttons.forEach((b) => { b.disabled = state.photos.length === 0; });
  }
}

/** Show a freshly read game (from photos or the example) for review. */
function beginReview(data) {
  state.headers = { ...data.headers, result: "" };  // "" = work out the result automatically
  state.endMarker = data.end_marker;
  state.plies = data.resolution.plies.map((p) => ({
    text: p.text, alternatives: p.alternatives, clock: p.clock, unclear: p.unclear,
    confirmed: false, written_number: p.written_number, page: p.page,
  }));
  state.notes = data.notes;
  state.headerFlags = new Set(data.header_flags || []);
  state.gameId = newGameId();
  state.lichess = null;
  applyResponse(data);
  state.selected = firstIssue() ?? 0;
  showReview();
  saveSoon();
  $("#review").scrollIntoView({ behavior: "smooth" });
}

// The example game (Morphy's Opera Game, 1858, written with a few slips), so
// the app can be tried without photos or a Gemini key.
$("#demo-btn").addEventListener("click", async () => {
  if (state.res && !confirm("Open the example game? The current game stays in Saved games.")) return;
  const raw = await (await fetch("demo.json")).json();
  beginReview(startReview(raw));
  $("#read-status").textContent = "Showing the example game.";
});

// ---------- Working out the moves ----------
function applyResponse(data) {
  state.res = data.resolution;
  state.pgn = data.pgn;
  state.derivedResult = data.derived_result;
  state.resultWarning = data.result_warning;
}

let reprocessTimer = null;
function reprocessSoon() {
  clearTimeout(reprocessTimer);
  reprocessTimer = setTimeout(reprocess, 350);
}

async function reprocess(then) {
  const seq = ++state.requestSeq;
  // Let the page show the click first; replaying a long messy game can take a moment.
  await new Promise((ok) => setTimeout(ok, 0));
  if (seq !== state.requestSeq) return;  // a newer edit is on its way
  const before = openIssues();
  applyResponse(processGame(state.headers, state.plies, state.endMarker));
  if (before > 0 && openIssues() === 0 && state.res.complete) state.justFinished = true;
  if (then) then();
  renderAll();
  saveSoon();
}

function showReview() {
  $("#review").hidden = false;
  renderTags();
  renderAll();
  renderPhotos();
  renderLichessResult();
}

// ---------- Rendering ----------
function renderAll() {
  if (state.selected >= state.plies.length) state.selected = Math.max(0, state.plies.length - 1);
  renderSummary();
  renderMoves();
  renderBoard();
  renderEditor();
  renderResult();
  renderPgn();
}

const plyNumber = (i) => Math.floor(i / 2) + 1;
const plyColor = (i) => (i % 2 === 0 ? "white" : "black");
const plyLabel = (i) => plyNumber(i) + (i % 2 === 0 ? "." : "…");
const statusClass = (p) => (p.status === "ok" && p.corrected ? "corrected" : p.status);
const isIssue = (p) => p.status === "check" || p.status === "fail";

function firstIssue(from = -1) {
  const plies = state.res ? state.res.plies : [];
  for (let i = from + 1; i < plies.length; i++) if (isIssue(plies[i])) return i;
  for (let i = 0; i <= from && i < plies.length; i++) if (isIssue(plies[i])) return i;
  return null;
}

const openIssues = () => (state.res ? state.res.counts.check + state.res.counts.fail : 0);
const isReady = () => state.res && state.res.complete && openIssues() === 0;

function renderSummary() {
  const c = state.res.counts;
  const box = $("#summary");
  const ready = isReady();
  box.classList.toggle("ready", ready);
  const next = $("#next-issue-btn");
  next.disabled = openIssues() === 0;
  next.textContent = openIssues() ? "Next to check (" + openIssues() + ")" : "Nothing to check";
  if (ready) {
    // Nothing left to do: say so clearly, with the next step right here.
    box.replaceChildren(
      el("span", { class: "ready-text" }, "✓ Ready: all " + state.plies.length + " half-moves are checked."),
      el("span", { class: "muted" }, "Nothing more to confirm."),
      el("span", { class: "ready-actions" },
        el("button", { class: "primary small", onclick: () => $("#copy-btn").click() }, "Copy PGN"),
        el("button", { class: "small", onclick: () => $("#lichess-btn").click() }, "Open in Lichess"),
        el("button", { class: "small", onclick: () => $("#download-btn").click() }, "Download")));
    return;
  }
  const parts = [el("span", { class: "big" }, state.plies.length + " half-moves read")];
  parts.push(el("span", {}, c.ok + " ok"));
  if (c.check) parts.push(el("span", {}, el("span", { class: "dot check legend" }), c.check + " to check"));
  if (c.fail) parts.push(el("span", { class: "error" }, "1 problem stops the game at move " + plyLabel(firstFail())));
  if (state.res.complete && !c.check) parts.push(el("span", { class: "big", style: "color: var(--ok)" }, "✓ All moves fit"));
  box.replaceChildren(...parts);
}

const firstFail = () => state.res.plies.findIndex((p) => p.status === "fail");

function renderMoves() {
  const table = $("#moves");
  const rows = [];
  const plies = state.res.plies;
  for (let i = 0; i < plies.length; i += 2) {
    const pageBreak = i > 0 && state.plies[i] && state.plies[i - 1] && state.plies[i].page !== state.plies[i - 1].page;
    rows.push(el("tr", { class: pageBreak ? "page-break" : "" },
      el("td", { class: "num" }, plyNumber(i)),
      moveCell(i), moveCell(i + 1)));
  }
  table.replaceChildren(...rows);
  scrollMoveIntoView();
}

// Like Lichess: the move list scrolls by itself, keeping the current move in
// view, while the board stays put.
function scrollMoveIntoView() {
  const box = $("#moves-scroll");
  const sel = box.querySelector(".selected");
  if (!sel) return;
  const row = sel.parentElement;
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < box.scrollTop + row.offsetHeight) {
    box.scrollTop = Math.max(0, top - row.offsetHeight * 2);
  } else if (bottom > box.scrollTop + box.clientHeight - row.offsetHeight) {
    box.scrollTop = bottom - box.clientHeight + row.offsetHeight * 2;
  }
}

function moveCell(i) {
  const p = state.res.plies[i];
  if (!p) return el("td");
  const shown = p.san_sv || p.text || "…";
  const showRaw = p.text && p.san_sv && p.text !== p.san && normalise(p.text) !== normalise(p.san_sv);
  return el("td", {
    class: "ply " + statusClass(p) + (i === state.selected ? " selected" : ""),
    title: p.hint || "",
    onclick: () => select(i),
  },
    el("span", { class: "san" }, shown),
    showRaw ? el("span", { class: "raw" }, "(" + p.text + ")") : null,
    p.clock ? el("span", { class: "clk" }, p.clock + "′") : null,
  );
}

const normalise = (s) => s.replace(/[+#x!?\s]/g, "").replace(/0/g, "O");

function renderBoard() {
  const p = state.res.plies[state.selected];
  const fen = p ? (p.fen_after || p.fen_before) : state.res.final_fen;
  const [placementField, turn] = (fen || "8/8/8/8/8/8/8/8 w").split(" ");
  const placement = placementField.split("/");
  // Last move highlight, and the king in check glowing red, as on Lichess.
  const last = new Set();
  if (p && p.uci && p.fen_after) { last.add(p.uci.slice(0, 2)); last.add(p.uci.slice(2, 4)); }
  const inCheck = p && p.fen_after && /[+#]$/.test(p.san || "") ? (turn === "w" ? "K" : "k") : null;
  const squares = [];
  for (let r = 0; r < 8; r++) {
    const rank = state.flipped ? r : 7 - r;
    const row = expandRank(placement[7 - rank]);
    for (let f = 0; f < 8; f++) {
      const file = state.flipped ? 7 - f : f;
      const name = "abcdefgh"[file] + (rank + 1);
      const piece = row[file];
      const classes = ["sq", (rank + file) % 2 ? "light" : "dark"];
      if (last.has(name)) classes.push("last");
      if (piece === inCheck) classes.push("check");
      const sq = el("div", { class: classes.join(" ") });
      if (piece !== ".") {
        const code = (piece === piece.toUpperCase() ? "w" : "b") + piece.toUpperCase();
        sq.append(el("div", { class: "pc", style: "background-image:url(pieces/" + code + ".svg)" }));
      }
      if (r === 7) sq.append(el("span", { class: "coord file" }, "abcdefgh"[file]));
      if (f === 0) sq.append(el("span", { class: "coord rank" }, rank + 1));
      squares.push(sq);
    }
  }
  $("#board").replaceChildren(...squares);
}

// Swipe on the board (phones) to step through the moves.
(() => {
  let start = null;
  const board = $("#board");
  board.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) start = [e.touches[0].clientX, e.touches[0].clientY];
  }, { passive: true });
  board.addEventListener("touchend", (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start[0], dy = t.clientY - start[1];
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) select(state.selected + (dx < 0 ? 1 : -1));
  });
})();

function expandRank(s) {
  return s.replace(/\d/g, (d) => ".".repeat(+d)).split("");
}

function renderEditor() {
  const box = $("#editor");
  const i = state.selected;
  const p = state.res.plies[i];
  if (!p) {
    box.replaceChildren(el("p", { class: "muted" }, "No moves."),
      el("button", { onclick: () => insertPly(0) }, "Add a move"));
    return;
  }
  if (state.justFinished && isReady()) {
    box.replaceChildren(el("div", { class: "done" },
      el("h3", {}, "✓ All done"),
      el("p", {}, "Every move is checked. The game is ready to copy, download or open in Lichess."),
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: () => $("#copy-btn").click() }, "Copy PGN"),
        el("button", { onclick: () => $("#lichess-btn").click() }, "Open in Lichess"))));
    return;
  }
  const parts = [];
  parts.push(el("h3", {}, "Move " + plyLabel(i) + " (" + (plyColor(i) === "white" ? "White" : "Black") + ")"));
  const changed = p.san_sv && normalise(p.text) !== normalise(p.san_sv);
  parts.push(el("div", { class: "muted" }, "Written: ",
    el("span", { class: "read-as" }, p.text || "(nothing)"),
    p.alternatives.length ? "  or maybe " + p.alternatives.join(", ") : "",
    changed ? el("span", {}, "  →  ", el("b", {}, p.san_sv)) : "",
    p.san && p.san !== p.san_sv ? el("span", {}, "  (English: " + p.san + ")") : ""));

  if (p.hint) parts.push(el("div", { class: "hint" + (p.status === "fail" ? " fail" : "") }, p.hint));
  if (p.suggestion) {
    const s = p.suggestion;
    parts.push(el("div", { class: "suggestion" }, "💡 " + s.message + " ",
      el("button", { class: "small primary", onclick: () => applySuggestion(s) },
        (s.action === "insert" ? "Insert " : "Use ") + s.san_sv),
      s.action === "insert" ? null :
        el("button", { class: "small", onclick: () => select(s.index) }, "Show that move")));
  }

  // A move the app is sure of (or you confirmed): nothing to do, so the tools
  // to change it are folded away.
  const fine = p.status === "ok";
  const tools = fine ? el("details", { class: "change" }, el("summary", {}, "Change this move")) : null;
  const add = (node) => (tools ? tools.append(node) : parts.push(node));
  if (fine) {
    parts.push(el("div", { class: "fine" }, "✓ This move is fine" +
      (p.confirmed ? " (you confirmed it)." : ".") +
      (openIssues() ? " " + openIssues() + " other move" + (openIssues() > 1 ? "s" : "") + " to check." : "")));
  }

  if (p.status === "pending") {
    parts.push(el("p", { class: "muted" }, "Fix the problem at move " + plyLabel(firstFail()) + " first; this move is checked after that."));
  } else if (p.legal.length) {
    const best = p.san;
    add(el("div", { class: "cands" },
      p.candidates.map((c) => el("button", {
        class: c.san === best ? "best" : "",
        title: c.score === null ? "the next " + c.fits + " moves fit after this"
                                : "match " + Math.round(c.score * 100) + "%",
        onclick: () => chooseMove(i, c.san),
      }, c.san_sv))));
    const select = el("select", { onchange: (e) => e.target.value && chooseMove(i, e.target.value) },
      el("option", { value: "" }, "All legal moves…"),
      p.legal.map((san) => el("option", { value: san }, san)));
    add(el("div", { class: "row" }, select,
      p.status === "check" && p.san ? el("button", { class: "primary small", onclick: () => chooseMove(i, p.san) }, "✓ " + p.san_sv + " is right") : null));
  }

  const textInput = el("input", { type: "text", value: p.text, size: 8, title: "Edit what's written (Swedish or English notation)" });
  textInput.addEventListener("change", () => setText(i, textInput.value));
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") textInput.blur(); });
  const clockInput = el("input", { type: "text", class: "clock", value: p.clock, inputmode: "numeric", title: "Minutes left on the clock" });
  clockInput.addEventListener("change", () => { state.plies[i].clock = clockInput.value.replace(/\D/g, ""); reprocess(); });
  add(el("div", { class: "row" },
    el("label", {}, "Written ", textInput),
    el("label", {}, "Minutes left ", clockInput)));

  add(el("div", { class: "row" },
    el("button", { class: "small", onclick: () => insertPly(i), title: "Use when a move was not written down" }, "＋ Insert move before"),
    el("button", { class: "small", onclick: () => insertPly(i + 1) }, "＋ Insert after"),
    el("button", { class: "small", onclick: () => deletePly(i), title: "Use when something that isn't a move was read" }, "✕ Delete this move")));
  if (tools) parts.push(tools);
  box.replaceChildren(...parts);
}

function renderResult() {
  const warn = $("#result-warning");
  warn.hidden = !state.resultWarning;
  warn.textContent = state.resultWarning || "";
  const sel = $("#tag-result");
  if (sel) sel.options[0].textContent = "Automatic (" + state.derivedResult + ")";
}

function renderPgn() {
  $("#pgn").value = state.pgn;
  const warn = $("#pgn-warning");
  const c = state.res.counts;
  if (c.fail) {
    warn.textContent = "The PGN stops before move " + plyLabel(firstFail()) + ". Fix that move to include the rest.";
  } else if (c.check) {
    warn.textContent = c.check + " move(s) are best guesses. The PGN is valid, but please check the highlighted moves.";
  }
  warn.hidden = !(c.fail || c.check);
}

function renderTags() {
  const form = $("#tags");
  const fields = TAG_FIELDS.map(([key, label]) => {
    const flagged = state.headerFlags && state.headerFlags.has(key);
    const input = el("input", {
      type: "text", name: key, value: state.headers[key] || "",
      class: flagged ? "flag" : "",
      title: flagged ? "Please check: this was hard to read, or the readings differed." : "",
    });
    input.addEventListener("input", () => {
      state.headers[key] = input.value;
      input.classList.remove("flag");
      input.title = "";
      reprocessSoon();
    });
    return el("label", {}, label, input);
  });
  const result = el("select", { id: "tag-result" },
    el("option", { value: "" }, "Automatic"),
    RESULTS.map((r) => el("option", { value: r, selected: state.headers.result === r }, r)));
  result.addEventListener("change", () => { state.headers.result = result.value; reprocess(); });
  fields.push(el("label", {}, "Result", result));
  form.replaceChildren(...fields);
  const notes = $("#notes");
  notes.hidden = !state.notes;
  notes.textContent = state.notes ? "Reader's note: " + state.notes : "";
}

function renderPhotos() {
  if (!state.photos.length) {
    $("#photos").replaceChildren(el("p", { class: "no-photos" },
      "Photos are not saved with the game. Add them again at the top if you need to look."));
    return;
  }
  $("#photos").replaceChildren(...state.photos.map((p) =>
    el("img", { src: p.url, alt: p.name, onclick: () => openLightbox(p.url) })));
}

// ---------- Photo viewer: zoom (wheel, buttons, double-click, pinch) and pan (drag) ----------
const viewer = { scale: 1, x: 0, y: 0, fit: 1, pointers: new Map(), moved: false, pinch: null,
                 downOnBackground: false };
const lbImg = $("#lightbox img");

function openLightbox(url) {
  $("#lightbox").hidden = false;
  lbImg.onload = () => fitLightbox();
  lbImg.src = url;
  if (lbImg.complete && lbImg.naturalWidth) fitLightbox();
}

function closeLightbox() { $("#lightbox").hidden = true; }

function fitLightbox() {
  const box = $("#lightbox");
  const w = lbImg.naturalWidth, h = lbImg.naturalHeight;
  if (!w || !h) return;
  // Whole page visible, header included, with a margin for the buttons.
  viewer.fit = Math.min((box.clientWidth - 20) / w, (box.clientHeight - 70) / h);
  viewer.scale = viewer.fit;
  viewer.x = (box.clientWidth - w * viewer.scale) / 2;
  viewer.y = Math.max(56, (box.clientHeight - h * viewer.scale) / 2);
  applyView();
}

function applyView() {
  lbImg.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
}

function zoomAt(factor, px, py) {
  const scale = Math.min(Math.max(viewer.scale * factor, viewer.fit * 0.5), viewer.fit * 12);
  // Keep the point under the cursor (or fingers) where it is.
  viewer.x = px - (px - viewer.x) * (scale / viewer.scale);
  viewer.y = py - (py - viewer.y) * (scale / viewer.scale);
  viewer.scale = scale;
  applyView();
}

const lb = $("#lightbox");
const centre = () => [lb.clientWidth / 2, lb.clientHeight / 2];
lb.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", (e) => {
  e.stopPropagation();
  const action = b.dataset.zoom;
  if (action === "close") closeLightbox();
  else if (action === "fit") fitLightbox();
  else zoomAt(action === "in" ? 1.5 : 1 / 1.5, ...centre());
}));
lb.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
}, { passive: false });
lb.addEventListener("dblclick", (e) => {
  if (e.target.closest(".lb-tools")) return;
  if (viewer.scale > viewer.fit * 1.5) fitLightbox();
  else zoomAt(3, e.clientX, e.clientY);
});
lb.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".lb-tools")) return;
  viewer.downOnBackground = e.target === lb;  // after capture, every event targets lb
  lb.setPointerCapture(e.pointerId);
  viewer.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  viewer.moved = false;
  viewer.pinch = null;
  lb.classList.add("dragging");
});
lb.addEventListener("pointermove", (e) => {
  const prev = viewer.pointers.get(e.pointerId);
  if (!prev) return;
  viewer.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (viewer.pointers.size === 2) {
    // Pinch: zoom by the change in distance between the two fingers.
    const [[ax, ay], [bx, by]] = [...viewer.pointers.values()];
    const dist = Math.hypot(ax - bx, ay - by);
    if (viewer.pinch) zoomAt(dist / viewer.pinch, (ax + bx) / 2, (ay + by) / 2);
    viewer.pinch = dist;
    viewer.moved = true;
    return;
  }
  const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
  if (Math.abs(dx) + Math.abs(dy) > 2) viewer.moved = true;
  viewer.x += dx;
  viewer.y += dy;
  applyView();
});
const endPointer = (e) => {
  viewer.pointers.delete(e.pointerId);
  if (viewer.pointers.size < 2) viewer.pinch = null;
  if (!viewer.pointers.size) lb.classList.remove("dragging");
};
lb.addEventListener("pointerup", (e) => {
  const clickOnBackground = !viewer.moved && viewer.downOnBackground && viewer.pointers.size === 1;
  endPointer(e);
  if (clickOnBackground) closeLightbox();
});
lb.addEventListener("pointercancel", endPointer);
window.addEventListener("resize", () => { if (!lb.hidden) fitLightbox(); });
document.addEventListener("keydown", (e) => {
  if (lb.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "+" || e.key === "=") zoomAt(1.5, ...centre());
  if (e.key === "-") zoomAt(1 / 1.5, ...centre());
  if (e.key === "0") fitLightbox();
});

// ---------- Editing ----------
function select(i) {
  state.justFinished = false;
  state.selected = Math.max(0, Math.min(i, state.plies.length - 1));
  renderMoves();
  renderBoard();
  renderEditor();
}

function chooseMove(i, san) {
  state.plies[i].text = san;
  state.plies[i].alternatives = [];
  state.plies[i].confirmed = true;
  reprocess(() => {
    const next = firstIssue(i);
    state.selected = next ?? i;
  });
}

function setText(i, text) {
  state.plies[i].text = text.trim();
  state.plies[i].alternatives = [];
  state.plies[i].confirmed = false;
  reprocess();
}

function applySuggestion(s) {
  if (s.action === "insert") {
    const page = (state.plies[s.index] || {}).page || 1;
    state.plies.splice(s.index, 0, { text: s.san, alternatives: [], clock: "", unclear: false,
                                     confirmed: true, written_number: null, page });
    reprocess(() => { state.selected = firstIssue(s.index) ?? s.index; });
  } else {
    chooseMove(s.index, s.san);
  }
}

function insertPly(i) {
  const page = (state.plies[i] || state.plies[i - 1] || {}).page || 1;
  state.plies.splice(i, 0, { text: "", alternatives: [], clock: "", unclear: true, confirmed: false, written_number: null, page });
  state.selected = i;
  reprocess();
}

function deletePly(i) {
  state.plies.splice(i, 1);
  state.selected = Math.min(i, state.plies.length - 1);
  reprocess();
}

// ---------- Navigation ----------
document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => {
  const n = state.plies.length - 1;
  select({ start: 0, prev: state.selected - 1, next: state.selected + 1, end: n }[b.dataset.nav]);
}));
$("#flip-btn").addEventListener("click", () => { state.flipped = !state.flipped; renderBoard(); });
$("#next-issue-btn").addEventListener("click", () => {
  const i = firstIssue(state.selected);
  if (i !== null) select(i);
});
document.addEventListener("keydown", (e) => {
  if ($("#review").hidden || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.key === "ArrowLeft") { select(state.selected - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { select(state.selected + 1); e.preventDefault(); }
});

// ---------- Output ----------
$("#copy-btn").addEventListener("click", async () => {
  const text = $("#pgn").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $("#pgn").select();
    document.execCommand("copy");
  }
  $("#copy-status").textContent = "Copied. In your Lichess study: Add chapter → PGN, then paste.";
});

$("#download-btn").addEventListener("click", () => {
  const h = state.headers;
  const name = [h.white, h.black, h.date].filter(Boolean).join("_").replace(/[^\p{L}\p{N}._-]+/gu, "-") || "game";
  downloadText(name + ".pgn", state.pgn);
});

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-chess-pgn" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#restart-btn").addEventListener("click", () => {
  if (!confirm("Start over with new photos? This game stays in Saved games.")) return;
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  Object.assign(state, { photos: [], plies: [], headers: {}, res: null, selected: 0, gameId: null, lichess: null });
  renderSaved();
  renderThumbs();
  $("#review").hidden = true;
  $("#read-status").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});


// ---------- Open in Lichess ----------
// Lichess turns a PGN into a normal game page (board, moves, analysis, clocks)
// that can be shared. No login needed. The game is public to anyone with the link.
$("#lichess-btn").addEventListener("click", openInLichess);

async function openInLichess() {
  const pgn = state.pgn;
  if (!navigator.onLine) {
    const box = $("#lichess-result");
    box.replaceChildren(el("span", { class: "error" }, "You're offline. Opening in Lichess needs internet."));
    box.hidden = false;
    return;
  }
  if (state.lichess && state.lichess.pgn === pgn) {
    window.open(state.lichess.url, "_blank", "noopener");
    renderLichessResult();
    return;
  }
  // Open the tab right away (inside the click), or browsers block it as a pop-up.
  const tab = window.open("", "_blank");
  const btn = $("#lichess-btn");
  btn.disabled = true;
  btn.textContent = "Sending to Lichess…";
  try {
    const resp = await fetch("https://lichess.org/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ pgn }),
    });
    if (resp.status === 429) throw new Error("Lichess is limiting imports right now. Try again in a minute.");
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error("Lichess did not accept the game: " + (data.error || resp.status));
    const url = data.url || ("https://lichess.org/" + data.id);
    state.lichess = { url, pgn };
    if (tab) tab.location.href = url;
    renderLichessResult();
    saveSoon();
  } catch (e) {
    if (tab) tab.close();
    const box = $("#lichess-result");
    box.replaceChildren(el("span", { class: "error" }, e.message));
    box.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Open in Lichess";
  }
}

function renderLichessResult() {
  const box = $("#lichess-result");
  const l = state.lichess;
  if (!l) { box.hidden = true; return; }
  const stale = l.pgn !== state.pgn;
  const parts = [
    el("span", {}, stale ? "On Lichess (made before your latest changes; open again to update): " : "On Lichess: "),
    el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.url),
    el("button", { class: "small", onclick: () => copyText(l.url, "Link copied.") }, "Copy link"),
  ];
  if (navigator.share) {
    parts.push(el("button", {
      class: "small",
      onclick: () => navigator.share({ title: gameTitle(), url: l.url }).catch(() => {}),
    }, "Share"));
  }
  box.replaceChildren(...parts);
  box.hidden = false;
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el("textarea", {}, text);
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  $("#copy-status").textContent = message;
}

// ---------- Saved games (this device only) ----------
// Every game read is kept in the browser, with the corrections made to it, so
// it never has to be read again. Photos are not kept.
const STORE_KEY = "protokoll-games-v1";
const MAX_SAVED = 500;

function newGameId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadGames() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function storeGames(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;  // private browsing, storage full or blocked
  }
}

function gameTitle(h = state.headers) {
  const players = (h.white || "?") + " – " + (h.black || "?");
  const date = h.date && !h.date.startsWith("?") ? h.date.replace(/\./g, "-") : "";
  return [date, players].filter(Boolean).join(" · ");
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentGame, 400);
}

function saveCurrentGame() {
  if (!state.gameId || !state.res) return;
  const list = loadGames();
  const old = list.find((g) => g.id === state.gameId);
  const record = {
    id: state.gameId,
    created: old ? old.created : new Date().toISOString(),
    updated: new Date().toISOString(),
    title: gameTitle(),
    result: state.headers.result || state.derivedResult || "*",
    pgn: state.pgn,
    toCheck: state.res.counts.check + state.res.counts.fail,
    lichess: state.lichess,
    // Enough to reopen the review exactly where it was left.
    review: {
      headers: state.headers, plies: state.plies, endMarker: state.endMarker,
      notes: state.notes || "", headerFlags: [...(state.headerFlags || [])],
    },
  };
  storeGames([record, ...list.filter((g) => g.id !== state.gameId)]);
  renderSaved();
}

function renderSaved() {
  const list = loadGames();
  $("#saved").hidden = list.length === 0;
  $("#saved-list").replaceChildren(...list.map((g) => el("li", {},
    el("span", { class: "title" }, g.title || "Game", el("span", { class: "meta" }, "  " + g.result)),
    g.toCheck ? el("span", { class: "badge" }, g.toCheck + " to check")
              : el("span", { class: "badge done" }, "✓ done"),
    el("button", { class: "small", onclick: () => openSaved(g.id) }, "Open"),
    el("button", { class: "small", onclick: () => copyText(g.pgn, "PGN copied.") }, "Copy PGN"),
    g.lichess ? el("a", { href: g.lichess.url, target: "_blank", rel: "noopener" }, "Lichess") : null,
    el("button", { class: "small link", onclick: () => deleteSaved(g.id) }, "Delete"),
  )));
}

function openSaved(id) {
  const g = loadGames().find((x) => x.id === id);
  if (!g) return;
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  Object.assign(state, {
    photos: [], gameId: g.id, lichess: g.lichess || null,
    headers: { ...g.review.headers }, plies: g.review.plies.map((p) => ({ ...p })),
    endMarker: g.review.endMarker, notes: g.review.notes,
    headerFlags: new Set(g.review.headerFlags || []), selected: 0,
  });
  renderThumbs();
  reprocess(() => {
    state.selected = firstIssue() ?? 0;
    showReview();
    $("#review").scrollIntoView({ behavior: "smooth" });
  });
}

function deleteSaved(id) {
  const g = loadGames().find((x) => x.id === id);
  if (!g || !confirm("Delete the saved game " + (g.title || "") + "?")) return;
  storeGames(loadGames().filter((x) => x.id !== id));
  if (state.gameId === id) state.gameId = null;
  renderSaved();
}

$("#export-all-btn").addEventListener("click", () => {
  const all = loadGames().map((g) => g.pgn.trim()).join("\n\n") + "\n";
  downloadText("saved-games-" + new Date().toISOString().slice(0, 10) + ".pgn", all);
});

renderSaved();

// ---------- Installable app, works offline ----------
// The offline script keeps the app's own files on the device. Browsers only
// allow it on https and on this computer (localhost).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline support unavailable:", e));
}
