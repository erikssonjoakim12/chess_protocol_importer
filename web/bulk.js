// Bulk import: many scoresheets at once, into Lichess studies.
//
//   1. Photos   add up to 40 photos (15 games); kept on the device (photos.js)
//   2. Reading  each photo is read on its own, at a pace the free tier allows,
//               then grouped into games (core/grouping.js); the user can fix it
//   3. Check    each game is checked in the normal review screen (index.html)
//   4. Studies  a study is suggested per game (core/studies.js); the user
//               decides, then everything is added to Lichess
//
// The batch is kept in this browser, so it can be closed and continued later.
import { GeminiReader } from "./core/gemini.js";
import { groupPages } from "./core/grouping.js";
import { startReview } from "./core/pipeline.js";
import { mergePages, normalizeReading } from "./core/reading.js";
import { chapterName, chapterOrder, MAX_CHAPTERS, studyNameFor, suggestStudies } from "./core/studies.js";
import { deleteGame, gameRecord, getGame, newGameId, patchGame, putGame } from "./games.js";
import { getKey } from "./key.js";
import { account, addToStudy, createStudy, finishLogin, login, myStudies } from "./lichess.js";
import { deletePhotos, getPhoto, keepStorage, savePhoto, storageUse } from "./photos.js";
import { $, downscale, el, rotateQuarter } from "./ui.js";

export const MAX_GAMES = 15;
export const MAX_PHOTOS = 40;
const BATCH_KEY = "protokoll-batch-v1";
const MY_NAME = "protokoll-my-name";  // shared with the single-game page
const PACE_MS = 4000;                 // between photos, to stay within the free tier's per-minute limit
const QUOTA_WAIT_S = 60;              // after "quota reached"
const QUOTA_TRIES = 5;

// ---------- The batch ----------
function newBatch() {
  return { id: newGameId(), created: new Date().toISOString(), step: "photos",
           photos: [],      // [{id, name, takenAt, status: waiting|reading|read|failed, reading, error}]
           starts: [],      // starts[i]: photo i begins a new game (the grouping)
           games: [],       // saved-game ids, in order
           plan: null,      // {mode, singleName, studies: [{key, name, existingId, visibility, gameIds}], chapters, sides}
           created_studies: {}, sent: {} };
}

let batch = load();
function load() {
  try { return JSON.parse(localStorage.getItem(BATCH_KEY)) || newBatch(); } catch { return newBatch(); }
}
function save() {
  try { localStorage.setItem(BATCH_KEY, JSON.stringify(batch)); } catch { showError("This browser didn't allow saving the batch (storage full?)."); }
}

function showError(message) {
  $("#bulk-error").textContent = message || "";
  $("#bulk-error").hidden = !message;
}

const recall = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not saved */ } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- Steps ----------
const STEPS = ["photos", "read", "check", "studies"];
const games = () => batch.games.map(getGame).filter(Boolean);
const isReady = (g) => g.complete && g.toCheck === 0;

function stepAllowed(step) {
  if (step === "photos") return true;
  if (step === "read") return batch.photos.length > 0;
  if (step === "check") return batch.games.length > 0;
  return batch.games.length > 0 && games().every(isReady);
}

function go(step) {
  if (!stepAllowed(step)) return;
  batch.step = step;
  save();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => go(b.dataset.step)));

function render() {
  if (!stepAllowed(batch.step)) batch.step = "photos";
  for (const step of STEPS) {
    $("#step-" + step).hidden = batch.step !== step;
    const button = document.querySelector(`[data-step="${step}"]`);
    button.disabled = !stepAllowed(step);
    button.classList.toggle("current", batch.step === step);
  }
  ({ photos: renderPhotos, read: renderReading, check: renderCheck, studies: renderStudies })[batch.step]();
  storageUse().then(({ used }) => {
    $("#storage-use").textContent = used ? `(${(used / 1e6).toFixed(1)} MB stored on this device)` : "";
  });
}

// ---------- 1. Photos ----------
const urls = new Map();  // photo id -> object URL for showing it
async function photoUrl(id) {
  if (!urls.has(id)) {
    const photo = await getPhoto(id);
    urls.set(id, photo ? URL.createObjectURL(photo.blob) : "");
  }
  return urls.get(id);
}
function forgetUrl(id) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

$("#bulk-files").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("#bulk-camera").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const dropzone = $("#bulk-dropzone");
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); dropzone.classList.remove("over"); addFiles(e.dataTransfer.files); });

async function addFiles(fileList) {
  showError("");
  keepStorage();
  const files = [...fileList].filter((f) => f.type.startsWith("image/")).sort((a, b) => a.lastModified - b.lastModified);
  for (const file of files) {
    if (batch.photos.length >= MAX_PHOTOS) {
      showError(`At most ${MAX_PHOTOS} photos in one batch; the rest were not added.`);
      break;
    }
    const blob = await downscale(file);
    try {
      const id = await savePhoto({ blob, name: file.name, takenAt: file.lastModified || Date.now() });
      batch.photos.push({ id, name: file.name, takenAt: file.lastModified || Date.now(), status: "waiting" });
    } catch (e) {
      showError("Couldn't keep the photo on this device: " + e.message);
      break;
    }
  }
  batch.photos.sort((a, b) => a.takenAt - b.takenAt);
  batch.starts = [];  // photos changed: suggest the grouping again
  save();
  render();
}

async function removePhoto(i) {
  const [photo] = batch.photos.splice(i, 1);
  await deletePhotos([photo.id]).catch(() => {});
  forgetUrl(photo.id);
  batch.starts = [];
  save();
  render();
}

async function rotatePhoto(i) {
  const photo = batch.photos[i];
  const stored = await getPhoto(photo.id);
  if (!stored) return;
  await savePhoto({ ...stored, blob: await rotateQuarter(stored.blob) });
  forgetUrl(photo.id);
  Object.assign(photo, { status: "waiting", reading: null, error: null });  // read it again, the right way up
  batch.starts = [];
  save();
  render();
}

function movePhoto(i, delta) {
  const [p] = batch.photos.splice(i, 1);
  batch.photos.splice(i + delta, 0, p);
  batch.starts = [];
  save();
  render();
}

async function renderPhotos() {
  const list = $("#bulk-thumbs");
  const items = await Promise.all(batch.photos.map(async (p, i) => el("li", {},
    el("img", { src: await photoUrl(p.id), alt: p.name, onclick: async () => window.open(await photoUrl(p.id), "_blank") }),
    el("div", {}, "Photo " + (i + 1) + (p.status === "read" ? " ✓" : "")),
    el("div", { class: "thumb-actions" },
      el("button", { title: "Move earlier", disabled: i === 0, onclick: () => movePhoto(i, -1) }, "◀"),
      el("button", { title: "Remove", onclick: () => removePhoto(i) }, "✕"),
      el("button", { title: "Rotate a quarter turn", onclick: () => rotatePhoto(i) }, "↻"),
      el("button", { title: "Move later", disabled: i === batch.photos.length - 1, onclick: () => movePhoto(i, 1) }, "▶")),
  )));
  list.replaceChildren(...items);
  $("#bulk-read").disabled = batch.photos.length === 0;
  $("#bulk-read").textContent = batch.photos.some((p) => p.status === "read") ? "Continue to reading →" : "Read all";
  $("#bulk-photo-count").textContent = batch.photos.length
    ? `${batch.photos.length} photo${batch.photos.length > 1 ? "s" : ""} (max ${MAX_PHOTOS})` : "";
}

$("#bulk-read").addEventListener("click", () => {
  go("read");
  if (batch.photos.some((p) => p.status !== "read" && p.status !== "failed")) startReading();
});

// ---------- 2. Reading ----------
let reading = false;
let stopRequested = false;

$("#read-continue").addEventListener("click", startReading);
$("#read-stop").addEventListener("click", () => { stopRequested = true; $("#read-stop").disabled = true; });

async function startReading() {
  if (reading) return;
  const key = getKey();
  if (!key) {
    showError("First connect your free Gemini key on the main page (⚙ Settings), then come back.");
    return;
  }
  showError("");
  reading = true;
  stopRequested = false;
  const reader = new GeminiReader(key);
  let first = true;
  for (const photo of batch.photos) {
    if (stopRequested) break;
    if (photo.status === "read") continue;
    if (!first) await sleep(PACE_MS);
    first = false;
    photo.status = "reading";
    photo.error = null;
    renderReading();
    for (let attempt = 1; ; attempt++) {
      try {
        const stored = await getPhoto(photo.id);
        if (!stored) throw new Error("the photo is missing on this device");
        const raw = await reader.read([{ blob: stored.blob, type: stored.blob.type || "image/jpeg" }]);
        photo.reading = normalizeReading(raw);
        photo.status = "read";
        break;
      } catch (e) {
        const quota = /429|quota|exhausted|rate/i.test(e.message);
        if (quota && attempt < QUOTA_TRIES && !stopRequested) {
          for (let s = QUOTA_WAIT_S; s > 0 && !stopRequested; s--) {
            $("#read-progress").textContent = `The free Gemini quota is used up for the moment. Trying again in ${s} s…`;
            await sleep(1000);
          }
          continue;
        }
        photo.status = quota || stopRequested ? "waiting" : "failed";
        photo.error = e.message;
        if (/key/i.test(e.message) && !quota) stopRequested = true;  // a bad key: no point going on
        break;
      }
    }
    save();
    renderReading();
  }
  reading = false;
  save();
  renderReading();
}

function readingSummary() {
  const n = (s) => batch.photos.filter((p) => p.status === s).length;
  return { read: n("read"), failed: n("failed"), waiting: n("waiting") + n("reading"), total: batch.photos.length };
}

function suggestGrouping() {
  const readings = batch.photos.map((p) => p.reading || normalizeReading({}));
  const { groups } = groupPages(readings);
  batch.starts = batch.photos.map(() => false);
  for (const g of groups) batch.starts[g[0]] = true;
  // Unread photos always stand alone, so they can't silently join a game.
  batch.photos.forEach((p, i) => { if (p.status !== "read") batch.starts[i] = true; });
  batch.reasons = groupPages(readings).reasons;
}

function currentGroups() {
  const groups = [];
  batch.photos.forEach((p, i) => {
    if (i === 0 || batch.starts[i]) groups.push([]);
    groups[groups.length - 1].push(i);
  });
  return groups;
}

async function renderReading() {
  const s = readingSummary();
  const done = s.read + s.failed === s.total;
  $("#read-progress").replaceChildren(
    reading ? el("span", { class: "spinner" }) : "",
    ` Read ${s.read} of ${s.total} photos` + (s.failed ? `, ${s.failed} could not be read` : "") +
    (reading ? " (one photo every few seconds, to stay within the free tier)…" : "."));
  $("#read-continue").hidden = reading || s.waiting === 0;
  $("#read-continue").textContent = s.read ? "Continue reading" : "Start reading";
  $("#read-stop").hidden = !reading;
  $("#read-stop").disabled = false;
  $("#grouping").hidden = !done || reading;
  if (!done || reading) return;
  if (batch.starts.length !== batch.photos.length) { suggestGrouping(); save(); }
  await renderGrouping();
}

async function renderGrouping() {
  const groups = currentGroups();
  const reasons = batch.reasons || [];
  const blocks = [];
  for (const [n, group] of groups.entries()) {
    const first = batch.photos[group[0]];
    const h = (first.reading && first.reading.headers) || {};
    const pages = await Promise.all(group.map(async (i, k) => {
      const p = batch.photos[i];
      return el("div", { class: "group-page" },
        el("img", { src: await photoUrl(p.id), alt: "", onclick: async () => window.open(await photoUrl(p.id), "_blank") }),
        el("div", { class: "muted small-text" }, `Photo ${i + 1}` + (group.length > 1 ? ` · page ${k + 1}` : "")),
        p.status === "failed" ? el("div", { class: "error small-text" }, "Could not be read: " + (p.error || "").slice(0, 120)) : null,
        p.status === "failed" ? el("button", { class: "small", onclick: () => retryPhoto(i) }, "Try again") : null,
        k > 0 ? el("button", { class: "small", title: "This page is a different game", onclick: () => setStart(i, true) }, "✂ Start a new game here") : null,
        k > 0 && reasons[i] ? el("div", { class: "muted small-text" }, "Joined: " + reasons[i]) : null);
    }));
    blocks.push(el("div", { class: "group card" },
      el("div", { class: "group-head" },
        el("b", {}, `Game ${n + 1}: `, [h.white || "?", h.black || "?"].join(" – ")),
        el("span", { class: "muted" }, [h.event, h.round && "round " + h.round, h.date].filter(Boolean).join(" · ")),
        n > 0 ? el("button", { class: "small", title: "These photos are more pages of the game above", onclick: () => setStart(group[0], false) },
                   "⤴ Join with the game above") : null),
      el("div", { class: "group-pages" }, pages)));
  }
  $("#group-list").replaceChildren(...blocks);
  const tooMany = groups.length > MAX_GAMES;
  $("#make-games").disabled = tooMany;
  $("#group-count").textContent = `${groups.length} game${groups.length > 1 ? "s" : ""}` +
    (tooMany ? ` — at most ${MAX_GAMES} per batch; remove some photos (step 1).` : "");
}

function setStart(i, value) {
  batch.starts[i] = value;
  save();
  renderGrouping();
}

function retryPhoto(i) {
  Object.assign(batch.photos[i], { status: "waiting", error: null });
  save();
  startReading();
}

$("#make-games").addEventListener("click", () => {
  const already = games();
  if (already.length && !confirm("Make the games again from these photos? Corrections made in step 3 are lost.")) return;
  for (const g of already) deleteGame(g.id);
  batch.games = [];
  batch.plan = null;
  for (const group of currentGroups()) {
    const pages = group.map((i) => batch.photos[i]).filter((p) => p.status === "read");
    if (!pages.length) continue;  // unreadable photos only
    const merged = pages.length === 1 ? pages[0].reading : mergePages(pages.map((p) => p.reading));
    const data = startReview(merged);
    const id = newGameId();
    const record = gameRecord({
      id, headers: { ...data.headers, result: "" }, endMarker: data.end_marker, notes: data.notes,
      plies: data.resolution.plies.map((p) => ({ text: p.text, alternatives: p.alternatives, clock: p.clock,
        unclear: p.unclear, confirmed: false, written_number: p.written_number, page: p.page })),
      headerFlags: data.header_flags, notation: data.notation, detectedNotation: data.detected_notation,
      notationAuto: true, res: data.resolution, pgn: data.pgn, derivedResult: data.derived_result,
      lichess: null, study: null,
    });
    putGame({ ...record, batchId: batch.id, photoIds: pages.map((p) => p.id) });
    batch.games.push(id);
  }
  save();
  go("check");
});

// ---------- 3. Check ----------
function renderCheck() {
  const list = games();
  $("#check-list").replaceChildren(...list.map((g, n) => {
    const h = g.review.headers;
    const ready = isReady(g);
    return el("li", {},
      el("span", { class: "title" }, `${n + 1}. ${g.title}`,
        el("span", { class: "meta" }, "  " + [h.event, h.round && "round " + h.round].filter(Boolean).join(" · "))),
      ready ? el("span", { class: "badge done" }, "✓ ready")
            : el("span", { class: "badge" }, g.complete ? `${g.toCheck} to check` : "problem to fix"),
      el("a", { class: "button-link" + (ready ? "" : " primary"), href: `./?game=${encodeURIComponent(g.id)}&bulk=1` },
        ready ? "Open" : "Check"));
  }));
  const open = list.filter((g) => !isReady(g)).length;
  $("#to-studies").disabled = open > 0;
  $("#check-status").textContent = open ? `${open} game${open > 1 ? "s" : ""} still to check.` : "All games are ready.";
}

$("#to-studies").addEventListener("click", () => go("studies"));

// ---------- 4. Studies ----------
let existingStudies = null;

$("#bulk-login").addEventListener("click", () => login(null));
$("#study-mode").addEventListener("change", (e) => { $("#single-name").hidden = e.target.value !== "single"; });
$("#resuggest").addEventListener("click", () => {
  if (Object.keys(batch.sent).length && !confirm("Suggest again? Games already sent stay where they are.")) return;
  batch.plan = null;
  renderStudies();
});

function guessSide(h) {
  const me = recall(MY_NAME).toLowerCase();
  if (me && (h.black || "").toLowerCase() === me) return "black";
  return "white";  // you, or a game you didn't play in: White's view
}

function makePlan() {
  const list = games();
  const mode = $("#study-mode").value;
  const singleName = $("#single-name").value.trim() || "Imported games";
  const { studies } = suggestStudies(list.map((g) => ({ id: g.id, headers: g.review.headers })), existingStudies || [], mode, singleName);
  const byId = Object.fromEntries(list.map((g) => [g.id, g]));
  for (const s of studies) {
    s.visibility = "private";
    s.gameIds = chapterOrder(s.gameIds.map((id) => ({ id, headers: byId[id].review.headers }))).map((g) => g.id);
  }
  const sides = {}, chapters = {};
  for (const g of list) {
    const h = g.review.headers;
    const me = recall(MY_NAME).toLowerCase();
    const side = guessSide(h);
    const played = me && [h.white, h.black].some((n) => (n || "").toLowerCase() === me);
    sides[g.id] = side;
    chapters[g.id] = chapterName(h, played ? side : null);
  }
  batch.plan = { mode, singleName, studies, sides, chapters };
  save();
}

async function renderStudies() {
  const a = account();
  $("#studies-login").hidden = Boolean(a);
  $("#studies-form").hidden = !a;
  if (!a) return;
  if (existingStudies === null) {
    $("#send-status").textContent = "Loading your studies…";
    try { existingStudies = await myStudies(); $("#send-status").textContent = ""; }
    catch (e) { existingStudies = []; $("#send-status").textContent = e.message; }
  }
  if (!batch.plan) makePlan();
  $("#study-mode").value = batch.plan.mode;
  $("#single-name").value = batch.plan.singleName;
  $("#single-name").hidden = batch.plan.mode !== "single";
  renderStudyBlocks();
}

function moveGame(gameId, toKey) {
  const plan = batch.plan;
  const from = plan.studies.find((s) => s.gameIds.includes(gameId));
  if (toKey === "__new__") {
    const g = getGame(gameId);
    const name = prompt("Name of the new study:", studyNameFor(g.review.headers) || "New study");
    if (!name || name.trim().length < 2) { renderStudyBlocks(); return; }
    const key = "s" + Date.now().toString(36);
    plan.studies.push({ key, name: name.trim(), existingId: null, visibility: "private", gameIds: [] });
    toKey = key;
  } else if (toKey.startsWith("existing:")) {
    const id = toKey.slice(9);
    let study = plan.studies.find((s) => s.existingId === id);
    if (!study) {
      const ex = existingStudies.find((s) => s.id === id);
      study = { key: "x" + id, name: ex.name, existingId: id, visibility: "private", gameIds: [] };
      plan.studies.push(study);
    }
    toKey = study.key;
  }
  if (from) from.gameIds = from.gameIds.filter((id) => id !== gameId);
  plan.studies.find((s) => s.key === toKey).gameIds.push(gameId);
  plan.studies = plan.studies.filter((s) => s.gameIds.length || batch.created_studies[s.key]);
  save();
  renderStudyBlocks();
}

function moveChapter(study, i, delta) {
  const ids = study.gameIds;
  [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
  save();
  renderStudyBlocks();
}

function renderStudyBlocks() {
  const plan = batch.plan;
  const blocks = plan.studies.map((study) => {
    const isNew = !study.existingId;
    const nameInput = el("input", { type: "text", value: study.name, maxlength: "100", disabled: !isNew || Boolean(batch.created_studies[study.key]) });
    nameInput.addEventListener("change", () => { study.name = nameInput.value.trim() || study.name; save(); });
    const visibility = el("select", { disabled: Boolean(batch.created_studies[study.key]) },
      ["private", "unlisted", "public"].map((v) => el("option", { value: v, selected: study.visibility === v },
        { private: "Private (only you)", unlisted: "Unlisted (anyone with the link)", public: "Public" }[v])));
    visibility.addEventListener("change", () => { study.visibility = visibility.value; save(); });
    const tooMany = study.gameIds.length > MAX_CHAPTERS;
    const rows = study.gameIds.map((id, i) => {
      const g = getGame(id);
      const h = g.review.headers;
      const chapter = el("input", { type: "text", value: plan.chapters[id] || "", maxlength: "100", disabled: Boolean(batch.sent[id]) });
      chapter.addEventListener("change", () => { plan.chapters[id] = chapter.value.trim(); save(); });
      const side = el("select", { title: "The board is shown from this side", disabled: Boolean(batch.sent[id]) },
        el("option", { value: "white", selected: plan.sides[id] === "white" }, "White"),
        el("option", { value: "black", selected: plan.sides[id] === "black" }, "Black"));
      side.addEventListener("change", () => { plan.sides[id] = side.value; save(); });
      const target = el("select", { title: "Move to another study", disabled: Boolean(batch.sent[id]) },
        plan.studies.map((s) => el("option", { value: s.key, selected: s.key === study.key }, s.name)),
        (existingStudies || []).filter((ex) => !plan.studies.some((s) => s.existingId === ex.id))
          .map((ex) => el("option", { value: "existing:" + ex.id }, ex.name + " (your study)")),
        el("option", { value: "__new__" }, "＋ New study…"));
      target.addEventListener("change", () => moveGame(id, target.value));
      return el("tr", { class: batch.sent[id] ? "sent" : "" },
        el("td", { class: "order" },
          el("button", { class: "small", title: "Earlier", disabled: i === 0 || Boolean(batch.sent[id]), onclick: () => moveChapter(study, i, -1) }, "↑"),
          el("button", { class: "small", title: "Later", disabled: i === study.gameIds.length - 1 || Boolean(batch.sent[id]), onclick: () => moveChapter(study, i, 1) }, "↓")),
        el("td", {}, el("div", {}, g.title), el("div", { class: "muted small-text" },
          [h.event, h.round && "round " + h.round, g.result].filter(Boolean).join(" · "))),
        el("td", {}, chapter),
        el("td", {}, side),
        el("td", {}, batch.sent[id] ? el("a", { href: batch.sent[id], target: "_blank", rel: "noopener" }, "✓ added") : target));
    });
    return el("div", { class: "study-block card" },
      el("div", { class: "study-head" },
        isNew ? el("label", { class: "inline" }, "New study ", nameInput)
              : el("span", {}, "Your study: ", el("a", { href: "https://lichess.org/study/" + study.existingId, target: "_blank", rel: "noopener" }, study.name)),
        isNew ? el("label", { class: "inline" }, "Who can see it ", visibility) : null,
        el("span", { class: tooMany ? "error" : "muted" },
          `${study.gameIds.length} chapter${study.gameIds.length > 1 ? "s" : ""}` + (tooMany ? ` — a study holds at most ${MAX_CHAPTERS}` : ""))),
      el("table", { class: "study-table" },
        el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Game"), el("th", {}, "Chapter name"),
                                   el("th", {}, "Board from"), el("th", {}, "Study"))),
        el("tbody", {}, rows)));
  });
  $("#study-blocks").replaceChildren(...blocks);
  const remaining = batch.games.filter((id) => !batch.sent[id]).length;
  const newStudies = plan.studies.filter((s) => !s.existingId && !batch.created_studies[s.key] && s.gameIds.length).length;
  $("#send-all").disabled = remaining === 0 || plan.studies.some((s) => s.gameIds.length > MAX_CHAPTERS);
  $("#send-all").textContent = remaining ? `Add ${remaining} game${remaining > 1 ? "s" : ""} to Lichess` : "All added ✓";
  if (!$("#send-status").dataset.busy) {
    $("#send-status").textContent = remaining === 0 ? "All games are in your studies. Their photos have been deleted." :
      newStudies > 30 ? "Lichess allows 30 new studies a day; some will fail until tomorrow." :
      newStudies ? `${newStudies} new stud${newStudies > 1 ? "ies" : "y"} will be created.` : "";
  }
}

$("#send-all").addEventListener("click", async () => {
  const plan = batch.plan;
  const status = $("#send-status");
  const button = $("#send-all");
  button.disabled = true;
  status.dataset.busy = "1";
  try {
    for (const study of plan.studies) {
      let studyId = study.existingId || batch.created_studies[study.key];
      let fresh = false;
      for (const id of study.gameIds) {
        if (batch.sent[id]) continue;
        const g = getGame(id);
        status.replaceChildren(el("span", { class: "spinner" }), ` Adding ${g.title} to ${study.name}…`);
        if (!studyId) {
          studyId = await createStudy(study.name, study.visibility);
          batch.created_studies[study.key] = studyId;
          fresh = true;
          save();
        }
        const side = plan.sides[id] || "white";
        const url = await addToStudy(studyId, g.pgn, plan.chapters[id] || chapterName(g.review.headers), side, fresh);
        fresh = false;
        batch.sent[id] = url;
        patchGame(id, { study: { url }, photoIds: [] });
        await deletePhotos(g.photoIds).catch(() => {});
        save();
        renderStudyBlocks();
        await sleep(500);  // gently: Lichess rate-limits
      }
    }
    status.textContent = "Done: all games are in your studies. Their photos have been deleted.";
  } catch (e) {
    status.replaceChildren(el("span", { class: "error" }, e.message + " — press the button again to continue."));
  } finally {
    delete status.dataset.busy;
    renderStudyBlocks();
  }
});

// ---------- Clearing ----------
$("#clear-batch").addEventListener("click", async () => {
  if (!confirm("Delete this batch and all its photos? Games already made stay in Saved games on the main page.")) return;
  await deletePhotos(batch.photos.map((p) => p.id)).catch(() => {});
  for (const id of batch.games) patchGame(id, { photoIds: [] });
  for (const id of [...urls.keys()]) forgetUrl(id);
  batch = newBatch();
  save();
  render();
});

// ---------- Start ----------
finishLogin().then((result) => {
  if (result) showError(result.ok ? "" : result.message);
  render();
});
