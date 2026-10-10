// Lichess login (OAuth 2 with PKCE, done entirely in the browser; Lichess
// needs no app registration) and adding games to studies.
// API: https://lichess.org/api   Scopes: study:read (list private studies),
// study:write (create studies, add chapters).

const LICHESS = "https://lichess.org";
const CLIENT_ID = "chess-protocol-importer";
const SCOPES = "study:read study:write";
const STORE = "protokoll-lichess";        // {token, username, expires}
const PENDING = "protokoll-lichess-login"; // {verifier, state, gameId} while away at lichess.org

const redirectUri = () => location.origin + location.pathname;

function read(key, storage = localStorage) {
  try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
}
function write(key, value, storage = localStorage) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked */ }
}

/** {username, token} when logged in (and the login hasn't expired), else null. */
export function account() {
  const a = read(STORE);
  if (!a || !a.token || (a.expires && Date.now() > a.expires)) return null;
  return a;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Go to lichess.org to log in. `gameId` is reopened when we come back. */
export async function login(gameId = null) {
  const verifier = randomString();
  const state = randomString();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  write(PENDING, { verifier, state, gameId }, sessionStorage);
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri(),
    code_challenge_method: "S256", code_challenge: challenge, scope: SCOPES, state,
  });
  location.assign(LICHESS + "/oauth?" + params);
}

/** Call once on page load: finishes a login if we just came back from
 *  lichess.org. Returns null, or {ok, message, gameId}. */
export async function finishLogin() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code"), error = url.searchParams.get("error");
  if (!code && !error) return null;
  const pending = read(PENDING, sessionStorage);
  write(PENDING, null, sessionStorage);
  history.replaceState(null, "", redirectUri());  // tidy the address bar
  if (error) return { ok: false, message: error === "access_denied" ? "Lichess login was cancelled." : "Lichess login failed: " + error, gameId: pending && pending.gameId };
  if (!pending || pending.state !== url.searchParams.get("state")) {
    return { ok: false, message: "Lichess login could not be completed (it was started in another tab?). Please try again." };
  }
  try {
    const resp = await fetch(LICHESS + "/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pending.verifier,
                                  redirect_uri: redirectUri(), client_id: CLIENT_ID }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) throw new Error(data.error_description || data.error || resp.status);
    const me = await api("/api/account", { token: data.access_token });
    write(STORE, { token: data.access_token, username: me.username,
                   expires: data.expires_in ? Date.now() + data.expires_in * 1000 : null });
    return { ok: true, message: "Logged in to Lichess as " + me.username + ".", gameId: pending.gameId };
  } catch (e) {
    return { ok: false, message: "Lichess login failed: " + e.message, gameId: pending.gameId };
  }
}

export async function logout() {
  const a = account();
  write(STORE, null);
  if (a) await fetch(LICHESS + "/api/token", { method: "DELETE", headers: { Authorization: "Bearer " + a.token } }).catch(() => {});
}

class LichessError extends Error {}

async function api(path, { token = (account() || {}).token, method = "GET", form = null, ndjson = false } = {}) {
  let resp;
  try {
    resp = await fetch(LICHESS + path, {
      method,
      headers: { Authorization: "Bearer " + token, Accept: ndjson ? "application/x-ndjson" : "application/json",
                 ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form) : null,
    });
  } catch {
    throw new LichessError("Could not reach Lichess. Check your internet connection.");
  }
  if (resp.status === 401) {
    write(STORE, null);
    throw new LichessError("Your Lichess login has expired. Please log in again.");
  }
  if (resp.status === 429) throw new LichessError("Lichess is limiting requests right now. Try again in a minute.");
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error || text; } catch { /* keep text */ }
    throw new LichessError("Lichess said: " + (detail || resp.status));
  }
  if (ndjson) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
}

/** The logged-in user's studies, most recently changed first: [{id, name, updatedAt}]. */
export async function myStudies() {
  const a = account();
  const studies = await api("/api/study/by/" + encodeURIComponent(a.username), { ndjson: true });
  return studies.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
}

/** A new study. Lichess adds an empty first chapter, which we remove once the
 *  game is in (see addToStudy). Returns the study id. */
export async function createStudy(name, visibility) {
  const data = await api("/api/study", {
    method: "POST",
    form: { name, visibility, computer: "everyone", explorer: "everyone", cloneable: "owner",
            shareable: "owner", chat: "member", sticky: "false" },
  });
  return data.id;
}

async function chapterIds(studyId) {
  const pgn = await api("/api/study/" + studyId + ".pgn");
  return [...String(pgn).matchAll(/\[ChapterURL "[^"]*\/([A-Za-z0-9]{8})"\]/g)].map((m) => m[1]);
}

/** Add the game as a new chapter. `fresh`: the study was just created, so its
 *  empty first chapter is removed. Returns the chapter's URL. */
export async function addToStudy(studyId, pgn, chapterName, orientation, fresh = false) {
  const emptyChapters = fresh ? await chapterIds(studyId).catch(() => []) : [];
  const data = await api("/api/study/" + studyId + "/import-pgn", {
    method: "POST", form: { pgn, name: chapterName.slice(0, 100), orientation },
  });
  if (data && data.error) throw new LichessError("Lichess could not add the game: " + data.error);
  const chapter = data && data.chapters && data.chapters[0];
  if (!chapter) throw new LichessError("Lichess did not add a chapter (a study can hold at most 64).");
  for (const id of emptyChapters) {
    if (id !== chapter.id) await api(`/api/study/${studyId}/${id}`, { method: "DELETE" }).catch(() => {});
  }
  return `${LICHESS}/study/${studyId}/${chapter.id}`;
}
