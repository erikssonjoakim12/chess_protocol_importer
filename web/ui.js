// Small helpers shared by the pages: building elements, photos.

export const $ = (sel) => document.querySelector(sel);

/** el("button", {class: "small", onclick: fn}, "text", child, ...) */
export const el = (tag, attrs = {}, ...children) => {
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

export const MAX_SIDE = 2400;     // downscale photos to this many pixels on the long side
export const JPEG_QUALITY = 0.88;

/** A phone photo, smaller (enough to read) and the right way up. */
export async function downscale(file) {
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

/** The photo turned a quarter turn clockwise. */
export async function rotateQuarter(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((ok) => canvas.toBlob(ok, "image/jpeg", JPEG_QUALITY));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el("textarea", {}, text);
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}
