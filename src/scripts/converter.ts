// Reformat — 100% client-side image converter.
// Every file is decoded, re-encoded (canvas), resized and zipped in the
// browser. Nothing is uploaded; nothing touches a server.

type Status = "ready" | "converting" | "done" | "error";

interface Output {
  mime: string;
  ext: string;
}

interface Item {
  id: number;
  file: File;
  name: string;
  ext: string;
  target: string; // output format key, e.g. "WEBP"
  status: Status;
  progress: number;
  grad: string;
  objectURL: string;
  outBlob?: Blob;
  outName?: string;
  outSize?: number;
  error?: string;
  el?: HTMLElement;
}

const OUTPUTS: Record<string, Output> = {
  WEBP: { mime: "image/webp", ext: "webp" },
  PNG: { mime: "image/png", ext: "png" },
  JPG: { mime: "image/jpeg", ext: "jpg" },
  AVIF: { mime: "image/avif", ext: "avif" },
};

const MAX_SIZE_MB = 25;
const MAX_FILES = 50;
const GRADS = [
  "linear-gradient(135deg,#F6B26B,#E8638B)",
  "linear-gradient(135deg,#6CB6F7,#3B5BDB)",
  "linear-gradient(135deg,#8FE3B0,#2F855A)",
  "linear-gradient(135deg,#D2BCFA,#6B46C1)",
  "linear-gradient(135deg,#F6C56B,#D98A2B)",
];

const state = {
  files: [] as Item[],
  seq: 0,
  converting: false,
  cancelRequested: false,
  settings: {
    outputFormat: "WEBP",
    quality: 82,
    resizeMode: "none",
    width: 1600,
    height: 900,
    pct: 50,
    preset: "1920x1080",
    keepAspect: true,
    stripMeta: true,
  },
};

let avifSupported = false;

// ---------------------------------------------------------------- helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const canvas = $("#canvas") as HTMLCanvasElement;

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "IMG";
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 2400);
}

// ---------------------------------------------------------------- decoding
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode this image"));
    };
    img.src = url;
  });
}

function targetDims(natW: number, natH: number): { w: number; h: number } {
  const s = state.settings;
  const fit = (bw: number, bh: number) => {
    if (!s.keepAspect) return { w: Math.max(1, bw), h: Math.max(1, bh) };
    const r = Math.min(bw / natW, bh / natH);
    return { w: Math.max(1, Math.round(natW * r)), h: Math.max(1, Math.round(natH * r)) };
  };
  switch (s.resizeMode) {
    case "pct": {
      const p = Math.max(1, Math.min(100, s.pct)) / 100;
      return { w: Math.max(1, Math.round(natW * p)), h: Math.max(1, Math.round(natH * p)) };
    }
    case "preset": {
      const [pw, ph] = s.preset.split("x").map(Number);
      return fit(pw, ph);
    }
    case "px":
      return fit(s.width, s.height);
    default:
      return { w: natW, h: natH };
  }
}

async function convertOne(item: Item): Promise<void> {
  const out = OUTPUTS[item.target] || OUTPUTS.WEBP;
  const source = await decode(item.file);
  const natW = (source as ImageBitmap).width || (source as HTMLImageElement).naturalWidth;
  const natH = (source as ImageBitmap).height || (source as HTMLImageElement).naturalHeight;
  if (!natW || !natH) throw new Error("Image has no dimensions");

  const { w, h } = targetDims(natW, natH);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (out.mime === "image/jpeg") {
    // JPEG has no alpha — flatten transparency onto white.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  if ("close" in source) (source as ImageBitmap).close();

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, out.mime, state.settings.quality / 100),
  );
  if (!blob) throw new Error("Browser can't encode " + item.target);
  if (blob.type !== out.mime) {
    throw new Error(item.target + " output isn't supported in this browser");
  }

  item.outBlob = blob;
  item.outSize = blob.size;
  item.outName = baseName(item.name) + "." + out.ext;
}

// ---------------------------------------------------------------- add files
function addFiles(fileList: FileList | File[]) {
  const incoming = Array.from(fileList);
  for (const file of incoming) {
    if (state.files.length >= MAX_FILES) {
      toast(`Limit is ${MAX_FILES} files`);
      break;
    }
    const id = ++state.seq;
    const tooBig = file.size > MAX_SIZE_MB * 1024 * 1024;
    const notImage = !file.type.startsWith("image/");
    const item: Item = {
      id,
      file,
      name: file.name,
      ext: extOf(file.name),
      target: state.settings.outputFormat,
      status: tooBig || notImage ? "error" : "ready",
      progress: 0,
      grad: GRADS[id % GRADS.length],
      objectURL: URL.createObjectURL(file),
    };
    if (notImage) item.error = "Unsupported format — not an image file";
    else if (tooBig) item.error = `File exceeds the ${MAX_SIZE_MB} MB size limit`;
    state.files.push(item);
    appendRow(item);
  }
  syncView();
}

async function addFromUrl(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const name = url.split("/").pop()?.split("?")[0] || "image";
    addFiles([new File([blob], name, { type: blob.type })]);
  } catch {
    toast("Couldn't fetch that URL (it may block cross-origin requests)");
  }
}

// ---------------------------------------------------------------- rendering
function formatOptionsHtml(selected: string): string {
  return Object.keys(OUTPUTS)
    .map((k) => {
      const disabled = k === "AVIF" && !avifSupported ? " disabled" : "";
      const sel = k === selected ? " selected" : "";
      return `<option value="${k}"${sel}${disabled}>${k}</option>`;
    })
    .join("");
}

function appendRow(item: Item) {
  const tpl = $("#rowTemplate") as HTMLTemplateElement;
  const el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  el.dataset.id = String(item.id);
  item.el = el;

  const img = el.querySelector(".thumb-img") as HTMLImageElement;
  img.src = item.objectURL;
  img.onerror = () => {
    img.style.display = "none";
    (el.querySelector(".thumb") as HTMLElement).style.background = item.grad;
  };
  (el.querySelector(".thumb-ext") as HTMLElement).textContent = item.ext;
  (el.querySelector(".row-name") as HTMLElement).textContent = item.name;

  const select = el.querySelector(".row-format") as HTMLSelectElement;
  select.innerHTML = formatOptionsHtml(item.target);
  select.addEventListener("change", () => {
    item.target = select.value;
  });

  el.querySelector(".row-download")!.addEventListener("click", () => downloadItem(item));
  el.querySelector(".row-remove")!.addEventListener("click", () => removeItem(item));

  $("#fileList").appendChild(el);
  updateRow(item);
}

function updateRow(item: Item) {
  const el = item.el;
  if (!el) return;
  el.classList.toggle("converting", item.status === "converting");
  el.classList.toggle("done", item.status === "done");
  el.classList.toggle("error", item.status === "error");

  const sub = el.querySelector(".row-sub") as HTMLElement;
  if (item.status === "ready") {
    sub.textContent = `${item.ext} · ${humanSize(item.file.size)}`;
  } else if (item.status === "done" && item.outSize != null) {
    const pct = Math.round((1 - item.outSize / item.file.size) * 100);
    const label = pct >= 0 ? `−${pct}%` : `+${-pct}%`;
    sub.innerHTML =
      `${humanSize(item.file.size)} → ${humanSize(item.outSize)} · ` +
      `<span class="save">${label}</span>`;
  } else if (item.status === "error") {
    sub.textContent = item.error || "Conversion failed";
  }

  if (item.status === "converting") {
    (el.querySelector(".bar-fill") as HTMLElement).style.width = item.progress + "%";
    (el.querySelector(".bar-pct") as HTMLElement).textContent = Math.round(item.progress) + "%";
  }
}

function removeItem(item: Item) {
  URL.revokeObjectURL(item.objectURL);
  item.el?.remove();
  state.files = state.files.filter((f) => f !== item);
  syncView();
}

function removeAll() {
  state.files.forEach((f) => URL.revokeObjectURL(f.objectURL));
  state.files = [];
  $("#fileList").innerHTML = "";
  syncView();
}

// ---------------------------------------------------------------- toolbar / view
function syncView() {
  const has = state.files.length > 0;
  $("#emptyState").classList.toggle("hidden", has);
  $("#workspace").classList.toggle("hidden", !has);
  updateToolbar();
}

function counts() {
  let ready = 0,
    done = 0,
    error = 0,
    converting = 0;
  for (const f of state.files) {
    if (f.status === "ready") ready++;
    else if (f.status === "done") done++;
    else if (f.status === "error") error++;
    else if (f.status === "converting") converting++;
  }
  return { ready, done, error, converting, total: state.files.length };
}

function updateToolbar() {
  const c = counts();
  $("#fileCount").textContent = `${c.total} file${c.total === 1 ? "" : "s"}`;

  const show = (sel: string, on: boolean) => $(sel).classList.toggle("hidden", !on);

  show("#overallWrap", state.converting);
  show("#cancelBtn", state.converting);
  show("#convertAllBtn", !state.converting && c.ready > 0);
  show("#downloadAllBtn", !state.converting && c.done > 0);
  show("#removeAllBtn", !state.converting);

  const removeBtn = $("#removeAllBtn");
  removeBtn.textContent = c.done > 0 && c.ready === 0 && c.error === 0 ? "Clear" : "Remove all";

  const allDone = !state.converting && c.total > 0 && c.done === c.total;
  show("#statusDone", allDone);
  show("#statusErr", !state.converting && c.error > 0);
  if (c.error > 0) {
    $("#statusErrText").textContent = `${c.error} file${c.error === 1 ? "" : "s"} need attention`;
  }
}

function updateOverall() {
  const c = counts();
  const convertible = c.ready + c.converting + c.done;
  if (!convertible) return;
  const inFlight = state.files
    .filter((f) => f.status === "converting")
    .reduce((sum, f) => sum + f.progress / 100, 0);
  const pct = Math.round(((c.done + inFlight) / convertible) * 100);
  ($("#overallBar") as HTMLElement).style.width = pct + "%";
  $("#overallPct").textContent = pct + "% overall";
}

// ---------------------------------------------------------------- convert flow
function animateBar(item: Item): { stop: () => void } {
  const timer = window.setInterval(() => {
    if (item.progress < 90) {
      item.progress = Math.min(90, item.progress + 6 + Math.random() * 8);
      updateRow(item);
      updateOverall();
    }
  }, 40);
  return { stop: () => clearInterval(timer) };
}

async function convertAll() {
  const queue = state.files.filter((f) => f.status === "ready");
  if (!queue.length) return;
  state.converting = true;
  state.cancelRequested = false;
  updateToolbar();

  for (const item of queue) {
    if (state.cancelRequested) {
      item.status = "ready";
      item.progress = 0;
      updateRow(item);
      continue;
    }
    item.status = "converting";
    item.progress = 0;
    updateRow(item);
    const anim = animateBar(item);
    try {
      await convertOne(item);
      item.status = "done";
      item.progress = 100;
    } catch (err) {
      item.status = "error";
      item.error = err instanceof Error ? err.message : "Conversion failed";
    }
    anim.stop();
    updateRow(item);
    updateOverall();
  }

  state.converting = false;
  const c = counts();
  updateToolbar();
  updateOverall();
  if (c.done > 0) toast(c.done === 1 ? "File converted" : "All files converted");
}

// ---------------------------------------------------------------- download / zip
function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadItem(item: Item) {
  if (item.outBlob && item.outName) triggerDownload(item.outBlob, item.outName);
}

// Minimal store-only (uncompressed) ZIP — no dependencies.
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

async function buildZip(entries: { name: string; bytes: Uint8Array }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    parts.push(lh.buffer, nameBytes, e.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce(
    (n, p) => n + (p instanceof ArrayBuffer ? p.byteLength : (p as Uint8Array).length),
    0,
  );
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd.buffer], { type: "application/zip" });
}

async function downloadAll() {
  const done = state.files.filter((f) => f.status === "done" && f.outBlob);
  if (!done.length) return;
  const used = new Map<string, number>();
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const item of done) {
    let name = item.outName!;
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    if (n > 0) {
      const dot = name.lastIndexOf(".");
      name = name.slice(0, dot) + "-" + n + name.slice(dot);
    }
    entries.push({ name, bytes: new Uint8Array(await item.outBlob!.arrayBuffer()) });
  }
  triggerDownload(await buildZip(entries), "reformat-images.zip");
}

// ---------------------------------------------------------------- settings wiring
function wireSettings() {
  const s = state.settings;

  const fmt = $("#outputFormat") as HTMLSelectElement;
  fmt.value = s.outputFormat;
  fmt.addEventListener("change", () => {
    s.outputFormat = fmt.value;
    // Re-target any files still waiting to convert.
    for (const f of state.files) {
      if (f.status === "ready") {
        f.target = fmt.value;
        const sel = f.el?.querySelector(".row-format") as HTMLSelectElement | null;
        if (sel) sel.value = fmt.value;
      }
    }
  });

  const quality = $("#quality") as HTMLInputElement;
  quality.addEventListener("input", () => {
    s.quality = Number(quality.value);
    $("#qualityVal").textContent = quality.value;
  });

  const resize = $("#resizeMode") as HTMLSelectElement;
  const panels: Record<string, string> = {
    px: "#resizePx",
    pct: "#resizePct",
    preset: "#resizePreset",
  };
  resize.addEventListener("change", () => {
    s.resizeMode = resize.value;
    for (const [mode, sel] of Object.entries(panels)) {
      $(sel).classList.toggle("hidden", mode !== resize.value);
    }
  });

  ($("#width") as HTMLInputElement).addEventListener("input", (e) => {
    s.width = Number((e.target as HTMLInputElement).value) || 1;
  });
  ($("#height") as HTMLInputElement).addEventListener("input", (e) => {
    s.height = Number((e.target as HTMLInputElement).value) || 1;
  });
  ($("#pct") as HTMLInputElement).addEventListener("input", (e) => {
    s.pct = Number((e.target as HTMLInputElement).value) || 1;
  });
  ($("#preset") as HTMLSelectElement).addEventListener("change", (e) => {
    s.preset = (e.target as HTMLSelectElement).value;
  });

  const toggle = (sel: string, key: "keepAspect" | "stripMeta") => {
    const btn = $(sel);
    btn.addEventListener("click", () => {
      s[key] = !s[key];
      btn.classList.toggle("on", s[key]);
      btn.setAttribute("aria-checked", String(s[key]));
    });
  };
  toggle("#aspectToggle", "keepAspect");
  toggle("#metaToggle", "stripMeta");
}

// ---------------------------------------------------------------- dropzone wiring
function wireDropzone() {
  const dz = $("#dropzone");
  const input = $("#fileInput") as HTMLInputElement;

  const open = () => input.click();
  $("#chooseBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    open();
  });
  dz.addEventListener("click", open);
  dz.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      open();
    }
  });

  input.addEventListener("change", () => {
    if (input.files) addFiles(input.files);
    input.value = "";
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) addFiles(dt.files);
  });

  // Drop anywhere on the page once files exist.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if ($("#dropzone").contains(e.target as Node)) return;
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) addFiles(dt.files);
  });

  const urlInput = $("#urlInput") as HTMLInputElement;
  const addUrl = () => {
    const v = urlInput.value.trim();
    if (v) {
      addFromUrl(v);
      urlInput.value = "";
    }
  };
  $("#urlAddBtn").addEventListener("click", addUrl);
  urlInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") addUrl();
  });
}

function wireToolbar() {
  $("#convertAllBtn").addEventListener("click", convertAll);
  $("#downloadAllBtn").addEventListener("click", downloadAll);
  $("#removeAllBtn").addEventListener("click", removeAll);
  $("#cancelBtn").addEventListener("click", () => {
    state.cancelRequested = true;
    toast("Cancelling…");
  });

  const list = $("#fileList");
  const listBtn = $("#listBtn");
  const gridBtn = $("#gridBtn");
  listBtn.addEventListener("click", () => {
    list.classList.add("list");
    list.classList.remove("grid");
    listBtn.classList.add("active");
    gridBtn.classList.remove("active");
  });
  gridBtn.addEventListener("click", () => {
    list.classList.add("grid");
    list.classList.remove("list");
    gridBtn.classList.add("active");
    listBtn.classList.remove("active");
  });
}

// ---------------------------------------------------------------- init
async function detectAvif() {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    const b: Blob | null = await new Promise((r) => c.toBlob(r, "image/avif"));
    avifSupported = !!b && b.type === "image/avif";
  } catch {
    avifSupported = false;
  }
  if (!avifSupported) {
    const opt = $("#outputFormat").querySelector<HTMLOptionElement>('option[value="AVIF"]');
    if (opt) {
      opt.disabled = true;
      opt.textContent = "AVIF (unsupported)";
    }
  }
}

function init() {
  wireSettings();
  wireDropzone();
  wireToolbar();
  detectAvif();
  syncView();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
