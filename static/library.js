"use strict";
// Saved games and "Open in Lichess". Loaded after app.js and uses its helpers.

// ---------- Open in Lichess ----------
// Lichess turns a PGN into a normal game page (board, moves, analysis, clocks)
// that can be shared. No login needed. The game is public to anyone with the link.
$("#lichess-btn").addEventListener("click", openInLichess);

async function openInLichess() {
  const pgn = state.pgn;
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
