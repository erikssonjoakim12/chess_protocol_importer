// The user's own Gemini key, kept in this browser only (see settings.js for
// the screen where it is entered).
const KEY_STORE = "protokoll-gemini-key";

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";  // storage blocked (e.g. some private-browsing modes)
  }
}

export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
    return true;
  } catch {
    return false;
  }
}
