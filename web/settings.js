// The user's own Gemini key: asked for once, kept in this browser only.
import { checkKey } from "./core/gemini.js";

const KEY_STORE = "protokoll-gemini-key";
const $ = (sel) => document.querySelector(sel);

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";  // storage blocked (e.g. some private-browsing modes)
  }
}

function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
    return true;
  } catch {
    return false;
  }
}

const panel = $("#settings");
const input = $("#key-input");
const status = $("#key-status");

function render() {
  const key = getKey();
  $("#key-connected").hidden = !key;
  $("#key-setup").hidden = Boolean(key);
  if (key) $("#key-masked").textContent = key.slice(0, 4) + "…" + key.slice(-4);
  // First visit: show the setup straight away.
  if (!key) panel.hidden = false;
}

$("#settings-btn").addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("#key-save").addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key) { status.textContent = "Paste the key first."; return; }
  status.textContent = "Checking the key with Google…";
  const result = await checkKey(key);
  if (!result.ok) { status.textContent = result.message; return; }
  if (!setKey(key)) {
    status.textContent = "This browser doesn't allow saving it (private mode?). The key works, but you'll have to paste it again next time.";
    return;
  }
  input.value = "";
  status.textContent = "Saved. You're ready to read scoresheets.";
  render();
});

$("#key-show").addEventListener("click", () => {
  input.type = input.type === "password" ? "text" : "password";
});

$("#key-change").addEventListener("click", () => {
  $("#key-setup").hidden = false;
  input.focus();
});

$("#key-remove").addEventListener("click", () => {
  if (!confirm("Remove your Gemini key from this browser?")) return;
  setKey("");
  status.textContent = "Removed.";
  render();
});

// The address to lock the key to: wherever this copy of the app runs.
const address = location.origin + location.pathname.replace(/[^/]*$/, "") + "*";
document.querySelectorAll(".app-address").forEach((c) => { c.textContent = address; });
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(location.origin);
document.querySelectorAll(".local-address-note").forEach((n) => { n.hidden = local; });

render();
