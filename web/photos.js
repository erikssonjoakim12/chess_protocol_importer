// Photos of games in progress, kept on the device (IndexedDB) so they survive
// closing the browser. Deleted once a game is in a Lichess study, or with
// "Delete all photos". Nothing here ever leaves the device except to Gemini.

const DB_NAME = "protokoll";
const DB_VERSION = 1;
const PHOTOS = "photos";  // {id, blob, name, takenAt}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((ok, fail) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(PHOTOS)) req.result.createObjectStore(PHOTOS, { keyPath: "id" });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, work) {
  const database = await db();
  return new Promise((ok, fail) => {
    const tx = database.transaction(PHOTOS, mode);
    const result = work(tx.objectStore(PHOTOS));
    tx.oncomplete = () => ok(result && "result" in result ? result.result : undefined);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error("Saving the photo was cancelled (storage full?)"));
  });
}

export const newPhotoId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Keep a photo. Returns its id. */
export async function savePhoto({ id = newPhotoId(), blob, name = "", takenAt = Date.now() }) {
  await run("readwrite", (s) => s.put({ id, blob, name, takenAt }));
  return id;
}

export async function getPhoto(id) {
  return (await run("readonly", (s) => s.get(id))) || null;
}

export async function getPhotos(ids) {
  const found = await Promise.all((ids || []).map((id) => getPhoto(id).catch(() => null)));
  return found.filter(Boolean);
}

export async function deletePhotos(ids) {
  if (!ids || !ids.length) return;
  await run("readwrite", (s) => { for (const id of ids) s.delete(id); });
}

export async function deleteAllPhotos() {
  await run("readwrite", (s) => s.clear());
}

export async function allPhotoIds() {
  return (await run("readonly", (s) => s.getAllKeys())) || [];
}

/** Ask the browser not to clear this storage when the device runs low on
 *  space (it may still ask the user, or decide by itself). */
export async function keepStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* not supported */ }
}

/** {used, quota} in bytes, as far as the browser tells. */
export async function storageUse() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { used: usage, quota };
  } catch {
    return { used: 0, quota: 0 };
  }
}
