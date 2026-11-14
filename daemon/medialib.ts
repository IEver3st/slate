import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, cpSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { APP_DIR, CACHE_DIR, readJson, writeJsonAtomic } from "./paths";
import { FFMPEG, run } from "./media";
import { emit } from "./events";
import { serviceSettings } from "./service";

export type MediaKind = "image" | "video" | "audio";

export type MediaItem = {
  id: string;
  lib: string;
  path: string;
  file: string;
  name: string;
  ext: string;
  folder: string;
  kind: MediaKind;
  size: number;
  mtimeMs: number;
  sig: string;
  width?: number;
  height?: number;
  durationMs?: number;
  animated?: boolean;
  alpha?: boolean;
};

export type MediaFolder = { path: string; name: string; count: number };
export type MediaListing = { lib: string; root: string; folders: MediaFolder[]; items: MediaItem[] };
export type MediaRef = { lib: "global" | "project"; path: string; file: string; sig?: string; name: string; kind: MediaKind; folder: string; width?: number; height?: number; durationMs?: number; placement?: { x: number; y: number; w: number; h: number } };

const KINDS: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".bmp": "image", ".avif": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video", ".m4v": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio", ".flac": "audio", ".aac": "audio", ".opus": "audio",
};
const TYPE_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/flac": ".flac", "audio/aac": ".aac", "audio/opus": ".opus",
};
export const MIME_OF: Record<string, string> = { ...Object.fromEntries(Object.entries(TYPE_EXT).map(([t, e]) => [e, t])), ".jpeg": "image/jpeg", ".m4v": "video/mp4" };

export const kindOf = (file: string): MediaKind | undefined => KINDS[extname(file).toLowerCase()];

export const MEDIA_THUMBS = join(CACHE_DIR, "media");
const THUMBS = MEDIA_THUMBS;
const META_FILE = join(CACHE_DIR, "media-meta.json");
const MAX_DEPTH = 8;
export const MAX_BYTES = 1024 * 1024 * 1024;
const DIRECT_IMAGE_BYTES = 900 * 1024;
const DIRECT_IMAGE_PIXELS = 1600 * 1600;
const THUMB_SIDE = 360;
const PEAK_BINS = 72;
mkdirSync(THUMBS, { recursive: true });

type Meta = { width?: number; height?: number; durationMs?: number; animated?: boolean; alpha?: boolean; peaks?: number[]; failed?: boolean };
let meta = readJson<Record<string, Meta>>(META_FILE, {});
let metaDirty: ReturnType<typeof setTimeout> | undefined;
function saveMeta() {
  clearTimeout(metaDirty);
  metaDirty = setTimeout(() => writeJsonAtomic(META_FILE, meta), 800);
}

export const defaultGlobalRoot = () => join(APP_DIR, "media");
export function globalRoot() {
  const dir = serviceSettings().mediaDir || defaultGlobalRoot();
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const projectRoot = (dataDir: string) => join(dataDir, "media");

export class MediaError extends Error {}

export function cleanName(raw: string) {
  const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120);
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new MediaError(`"${raw}" can't be used as a name`);
  return name;
}

export function inside(root: string, rel: string) {
  const abs = resolve(root, rel || ".");
  if (abs !== resolve(root) && !abs.toLowerCase().startsWith(resolve(root).toLowerCase() + sep)) throw new MediaError("that path is outside the media library");
  return abs;
}

const toRel = (root: string, abs: string) => relative(root, abs).split(sep).join("/");
const sigOf = (size: number, mtimeMs: number) => `${Math.round(mtimeMs)}-${size}`;
const metaKey = (file: string, sig: string) => `${file.toLowerCase()}|${sig}`;

type Scan = { at: number; folders: string[]; files: { rel: string; abs: string; size: number; mtimeMs: number }[] };
const scans = new Map<string, Scan>();
const watchers = new Map<string, FSWatcher>();
const libOfRoot = new Map<string, string>();

function hidden(name: string) {
  return name.startsWith(".") || name.startsWith("~$") || /^(desktop\.ini|thumbs\.db)$/i.test(name);
}

function scan(root: string): Scan {
  const key = root.toLowerCase();
  const hit = scans.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  const out: Scan = { at: Date.now(), folders: [], files: [] };
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (hidden(n)) continue;
      const abs = join(dir, n);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        out.folders.push(toRel(root, abs));
        walk(abs, depth + 1);
      } else if (s.isFile() && kindOf(n) && !n.endsWith(".part")) out.files.push({ rel: toRel(root, abs), abs, size: s.size, mtimeMs: s.mtimeMs });
    }
  };
  if (existsSync(root)) walk(root, 0);
  scans.set(key, out);
  return out;
}

function touched(root: string) {
  scans.delete(root.toLowerCase());
  const lib = libOfRoot.get(root.toLowerCase());
  if (lib) emit({ type: "media", lib });
}

function watchRoot(root: string, lib: string) {
  const key = root.toLowerCase();
  libOfRoot.set(key, lib);
  if (watchers.has(key) || !existsSync(root)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const w = watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => touched(root), 300);
    });
    w.on("error", () => {
      w.close();
      watchers.delete(key);
    });
    watchers.set(key, w);
  } catch {}
}

export function rewatch(lib: string, root: string) {
  const key = root.toLowerCase();
  for (const [k, l] of libOfRoot) {
    if (l !== lib || k === key) continue;
    libOfRoot.delete(k);
    watchers.get(k)?.close();
    watchers.delete(k);
    scans.delete(k);
  }
  watchRoot(root, lib);
}

export function unwatchAll() {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}

let slots = 2;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (slots === 0) await new Promise<void>((r) => queue.push(r));
  slots--;
  try {
    return await fn();
  } finally {
    slots++;
    queue.shift()?.();
  }
}

const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
const ALPHA = /^(rgba|bgra|argb|abgr|ya|yuva|gbrap|pal8|rgba64|ya16)/;

async function probe(file: string): Promise<Meta> {
  const r = await run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,width,height,pix_fmt,nb_frames,duration:format=duration", "-of", "json", file]);
  if (r.code !== 0) return { failed: true };
  const j = JSON.parse(new TextDecoder().decode(r.stdout));
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
  const seconds = Number(j.format?.duration ?? v?.duration);
  const ext = extname(file).toLowerCase();
  const frames = Number(v?.nb_frames);
  const isStill = KINDS[ext] === "image";
  return {
    width: v?.width || undefined,
    height: v?.height || undefined,
    durationMs: !isStill || (ext === ".gif" && frames > 1) || (ext === ".webp" && seconds > 0) ? (Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined) : undefined,
    animated: ext === ".gif" ? frames > 1 || seconds > 0.05 : undefined,
    alpha: v?.pix_fmt && ext !== ".gif" && ext !== ".jpg" && ext !== ".jpeg" ? ALPHA.test(v.pix_fmt) : undefined,
  };
}

const probing = new Map<string, Promise<void>>();
let announce: ReturnType<typeof setTimeout> | undefined;
const announceLibs = new Set<string>();

function ensureMeta(lib: string, file: string, sig: string) {
  const key = metaKey(file, sig);
  if (meta[key] || probing.has(key)) return;
  const p = limited(() => probe(file))
    .catch(() => ({ failed: true }) as Meta)
    .then((m) => {
      meta[key] = m;
      saveMeta();
      announceLibs.add(lib);
      clearTimeout(announce);
      announce = setTimeout(() => {
        for (const l of announceLibs) emit({ type: "media", lib: l });
        announceLibs.clear();
      }, 400);
    })
    .finally(() => probing.delete(key));
  probing.set(key, p);
}

export async function settledListing(lib: string, root: string, ms = 8000): Promise<MediaListing> {
  listing(lib, root);
  if (probing.size) await Promise.race([Promise.all([...probing.values()]), Bun.sleep(ms)]);
  return listing(lib, root);
}

export function listing(lib: string, root: string): MediaListing {
  watchRoot(root, lib);
  const s = scan(root);
  const items: MediaItem[] = s.files.map((f) => {
    const sig = sigOf(f.size, f.mtimeMs);
    const m = meta[metaKey(f.abs, sig)];
    if (!m) ensureMeta(lib, f.abs, sig);
    const ext = extname(f.rel);
    const folder = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    return {
      id: `${lib}:${f.rel}`,
      lib,
      path: f.rel,
      file: f.abs,
      name: basename(f.rel, ext),
      ext: ext.slice(1).toLowerCase(),
      folder,
      kind: kindOf(f.rel)!,
      size: f.size,
      mtimeMs: f.mtimeMs,
      sig,
      width: m?.width,
      height: m?.height,
      durationMs: m?.durationMs,
      animated: m?.animated,
      alpha: m?.alpha,
    };
  });
  const folders = s.folders.map((path) => ({
    path,
    name: path.split("/").pop()!,
    count: items.filter((i) => i.folder === path || i.folder.startsWith(path + "/")).length,
  }));
  return { lib, root, folders, items };
}

export function itemAt(lib: string, root: string, rel: string): MediaItem {
  const abs = inside(root, rel);
  const it = listing(lib, root).items.find((i) => i.file.toLowerCase() === abs.toLowerCase());
  if (!it) throw new MediaError(`no media at ${rel}`);
  return it;
}

function uniquePath(dir: string, name: string, ext: string) {
  let out = join(dir, `${name}${ext}`);
  for (let i = 2; existsSync(out); i++) out = join(dir, `${name} (${i})${ext}`);
  return out;
}

function splitName(file: string) {
  const ext = extname(file);
  return { stem: cleanName(basename(file, ext) || "media"), ext: ext.toLowerCase() };
}

export function addFiles(root: string, folder: string, sources: string[]) {
  const dest = inside(root, folder);
  mkdirSync(dest, { recursive: true });
  const added: string[] = [];
  const skipped: string[] = [];
  const copyInto = (src: string, into: string, depth: number) => {
    const s = statSync(src);
    if (s.isDirectory()) {
      if (depth > MAX_DEPTH) return;
      if (into.toLowerCase().startsWith(resolve(src).toLowerCase() + sep) || into.toLowerCase() === resolve(src).toLowerCase()) throw new MediaError("can't copy a folder into itself");
      let target = join(into, cleanName(basename(src)));
      for (let i = 2; existsSync(target) && !statSync(target).isDirectory(); i++) target = join(into, `${cleanName(basename(src))} (${i})`);
      mkdirSync(target, { recursive: true });
      for (const n of readdirSync(src)) if (!hidden(n)) copyInto(join(src, n), target, depth + 1);
      return;
    }
    if (!kindOf(src)) return void skipped.push(basename(src));
    if (s.size > MAX_BYTES) return void skipped.push(basename(src));
    const { stem, ext } = splitName(src);
    const out = uniquePath(into, stem, ext);
    copyFileSync(src, out);
    added.push(toRel(root, out));
  };
  for (const src of sources) {
    const abs = resolve(src);
    if (!existsSync(abs)) throw new MediaError(`${src} does not exist`);
    copyInto(abs, dest, 0);
  }
  touched(root);
  return { added, skipped };
}

export function addBytes(root: string, folder: string, name: string, type: string, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BYTES) throw new MediaError("that file is over 1 GB");
  const dest = inside(root, folder);
  mkdirSync(dest, { recursive: true });
  const given = extname(name).toLowerCase();
  const ext = KINDS[given] ? given : TYPE_EXT[type.split(";")[0].trim().toLowerCase()] ?? sniff(bytes);
  if (!ext) throw new MediaError("that isn't an image, video or sound Slate can use");
  const stem = cleanName(KINDS[given] ? basename(name, extname(name)) : name || "Pasted");
  const out = uniquePath(dest, stem, ext);
  writeFileSync(`${out}.part`, bytes);
  renameSync(`${out}.part`, out);
  touched(root);
  return toRel(root, out);
}

function sniff(b: Uint8Array): string | undefined {
  const head = Buffer.from(b.subarray(0, 16));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (head[0] === 0xff && head[1] === 0xd8) return ".jpg";
  if (head.toString("ascii", 0, 4) === "GIF8") return ".gif";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") return ".wav";
  if (head.toString("ascii", 4, 8) === "ftyp") return ".mp4";
  if (head.toString("ascii", 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return ".mp3";
  if (head.toString("ascii", 0, 4) === "OggS") return ".ogg";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ".webm";
  return undefined;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function metaContent(html: string, keys: string[]) {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k.replace(/[:]/g, "\\:")}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const content = tag && /content=["']([^"']+)["']/i.exec(tag)?.[1];
    if (content) return content.replace(/&amp;/g, "&");
  }
  return undefined;
}

async function download(url: string, depth = 0): Promise<{ bytes: Uint8Array; type: string; name: string }> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new MediaError("that isn't a link");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new MediaError("only http and https links can be added");
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "image/*,video/*,audio/*,text/html;q=0.8,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(45_000) });
  if (!r.ok) throw new MediaError(`the link answered ${r.status}`);
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const size = Number(r.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) throw new MediaError("that file is over 1 GB");
  const fromPath = decodeURIComponent(basename(u.pathname)) || u.hostname;
  if (type === "text/html" || type === "application/xhtml+xml") {
    if (depth > 0) throw new MediaError("no image, video or sound was found at that link");
    const html = (await r.text()).slice(0, 600_000);
    const media = metaContent(html, ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream", "og:image:secure_url", "og:image", "twitter:image"]);
    if (!media) throw new MediaError("no image, video or sound was found at that page");
    const title = metaContent(html, ["og:title", "twitter:title"]);
    const got = await download(new URL(media, u).toString(), depth + 1);
    return { ...got, name: title ? title.slice(0, 80) : got.name };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = r.body?.getReader();
  for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > MAX_BYTES) {
      await reader!.cancel();
      throw new MediaError("that file is over 1 GB");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, type, name: fromPath };
}

export async function addUrl(root: string, folder: string, url: string, name?: string) {
  const got = await download(url);
  const ext = extname(got.name).toLowerCase();
  const fallback = KINDS[ext] ? got.name : got.name.replace(/\.[a-z0-9]{1,5}$/i, "");
  return addBytes(root, folder, name ? `${name}${KINDS[ext] ? ext : ""}` : fallback || "Download", got.type, got.bytes);
}

export function makeFolder(root: string, parent: string, name: string) {
  const dir = join(inside(root, parent), cleanName(name));
  if (existsSync(dir)) throw new MediaError(`"${cleanName(name)}" already exists there`);
  mkdirSync(dir, { recursive: true });
  touched(root);
  return toRel(root, dir);
}

export function renameEntry(root: string, rel: string, name: string) {
  const abs = inside(root, rel);
  if (abs === resolve(root)) throw new MediaError("the library itself can't be renamed");
  if (!existsSync(abs)) throw new MediaError(`${rel} no longer exists`);
  const isDir = statSync(abs).isDirectory();
  const ext = isDir ? "" : extname(abs);
  const typed = extname(name).toLowerCase();
  const stem = !isDir && typed === ext.toLowerCase() ? basename(name, extname(name)) : name;
  const out = join(dirname(abs), `${cleanName(stem)}${ext}`);
  if (out.toLowerCase() !== abs.toLowerCase() && existsSync(out)) throw new MediaError(`"${basename(out)}" already exists there`);
  renameSync(abs, out);
  touched(root);
  return toRel(root, out);
}

function moveOne(src: string, dest: string) {
  try {
    renameSync(src, dest);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true, errorOnExist: true });
    rmSync(src, { recursive: true, force: true });
  }
}

export function transfer(from: { root: string; rel: string }[], to: { root: string; folder: string }, copy: boolean) {
  const dest = inside(to.root, to.folder);
  mkdirSync(dest, { recursive: true });
  const out: string[] = [];
  const roots = new Set<string>([to.root]);
  for (const f of from) {
    const abs = inside(f.root, f.rel);
    if (abs === resolve(f.root)) throw new MediaError("the library itself can't be moved");
    if (!existsSync(abs)) continue;
    const isDir = statSync(abs).isDirectory();
    if (isDir && (dest.toLowerCase() === abs.toLowerCase() || dest.toLowerCase().startsWith(abs.toLowerCase() + sep))) throw new MediaError(`can't put "${basename(abs)}" inside itself`);
    if (!copy && dirname(abs).toLowerCase() === dest.toLowerCase()) continue;
    const ext = isDir ? "" : extname(abs);
    let target = join(dest, basename(abs));
    for (let i = 2; existsSync(target); i++) target = join(dest, `${basename(abs, ext)} (${i})${ext}`);
    if (copy) cpSync(abs, target, { recursive: true, errorOnExist: true });
    else moveOne(abs, target);
    out.push(toRel(to.root, target));
    roots.add(f.root);
  }
  for (const r of roots) touched(r);
  return out;
}

export async function recycle(root: string, rels: string[]) {
  const paths = rels.map((r) => inside(root, r)).filter((p) => p !== resolve(root) && existsSync(p));
  if (!paths.length) return 0;
  const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in @(${quoted})) { if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') } }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], undefined, 20_000);
  touched(root);
  if (r.timedOut) throw new MediaError("could not move to the Recycle Bin: a file is open in another program. Close it and try again");
  if (r.code !== 0) throw new MediaError(`could not move to the Recycle Bin: ${r.stderr.trim().split("\n")[0]}`);
  return paths.length;
}

const building = new Map<string, Promise<string | undefined>>();

export function thumbFor(it: MediaItem): Promise<string | undefined> {
  if (it.kind === "audio") return Promise.resolve(undefined);
  if (it.kind === "image" && it.ext !== "gif" && it.size <= DIRECT_IMAGE_BYTES && (it.width ?? 0) * (it.height ?? 0) <= DIRECT_IMAGE_PIXELS) return Promise.resolve(it.file);
  const still = it.kind === "image";
  const out = join(THUMBS, `${createHash("sha1").update(it.file.toLowerCase()).digest("hex").slice(0, 16)}-${it.sig}.${still ? "png" : "jpg"}`);
  if (existsSync(out)) return Promise.resolve(out);
  let p = building.get(out);
  if (p) return p;
  p = limited(async () => {
    const tmp = `${out}.part.${still ? "png" : "jpg"}`;
    const scale = `scale=w='if(gt(iw\\,ih)\\,-2\\,min(iw\\,${THUMB_SIDE}))':h='if(gt(iw\\,ih)\\,min(ih\\,${THUMB_SIDE})\\,-2)':flags=bicubic`;
    const at = !still && it.durationMs ? Math.min(1000, it.durationMs * 0.3) / 1000 : 0;
    const args = (seek: number) => [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...(seek ? ["-ss", seek.toFixed(3)] : []), "-i", it.file, "-vf", scale, "-frames:v", "1", ...(still ? [] : ["-q:v", "3"]), "-update", "1", tmp];
    try {
      let r = await run(args(at));
      if ((r.code !== 0 || !existsSync(tmp)) && at) r = await run(args(0));
      if (r.code !== 0 || !existsSync(tmp)) return undefined;
      renameSync(tmp, out);
      return out;
    } finally {
      rmSync(tmp, { force: true });
    }
  }).finally(() => building.delete(out));
  building.set(out, p);
  return p;
}

export async function peaksFor(it: MediaItem): Promise<number[]> {
  const key = metaKey(it.file, it.sig);
  const known = meta[key]?.peaks;
  if (known) return known;
  const r = await limited(() => run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-t", "180", "-i", it.file, "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"]));
  if (r.code !== 0) return [];
  const samples = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.byteLength / 2));
  const per = Math.max(1, Math.floor(samples.length / PEAK_BINS));
  const peaks: number[] = [];
  for (let b = 0; b < PEAK_BINS; b++) {
    let max = 0;
    for (let i = b * per; i < Math.min(samples.length, (b + 1) * per); i++) max = Math.max(max, Math.abs(samples[i]));
    peaks.push(Math.round(Math.sqrt(max / 32768) * 100) / 100);
  }
  meta[key] = { ...meta[key], peaks };
  saveMeta();
  return peaks;
}

export function refOf(it: MediaItem, lib: "global" | "project", placement?: unknown): MediaRef {
  const p = placement as MediaRef["placement"];
  const ok = p && [p.x, p.y, p.w, p.h].every((n) => typeof n === "number" && Number.isFinite(n));
  return {
    lib,
    path: it.path,
    file: it.file,
    sig: it.sig,
    name: it.name,
    kind: it.kind,
    folder: it.folder,
    width: it.width,
    height: it.height,
    durationMs: it.durationMs,
    placement: ok ? { x: +p.x.toFixed(4), y: +p.y.toFixed(4), w: +p.w.toFixed(4), h: +p.h.toFixed(4) } : undefined,
  };
}

export function relocate(ref: MediaRef, cut: { id: string; dataDir: string }): MediaRef & { missing?: true } {
  if (existsSync(ref.file)) return ref;
  const libs = { project: { lib: cut.id, root: projectRoot(cut.dataDir) }, global: { lib: "global", root: globalRoot() } };
  const ext = extname(ref.file).toLowerCase();
  for (const scope of ref.lib === "global" ? (["global", "project"] as const) : (["project", "global"] as const)) {
    const it = ref.sig ? listing(libs[scope].lib, libs[scope].root).items.find((i) => i.sig === ref.sig && extname(i.file).toLowerCase() === ext) : undefined;
    if (it) return { ...ref, lib: scope, path: it.path, file: it.file, name: it.name, folder: it.folder };
  }
  return { ...ref, missing: true };
}

export const MEDIA_GUIDE =
  "Media files are the reviewer's own library: package them straight from these paths and leave them where they are, since the reviewer organizes them in Slate. Images (PNG, JPEG, WebP) and sounds: `tsrct project import-asset --kind image|audio`. MP4 and MOV footage: `tsrct project import-video`. Convert animated GIF and WebM to MP4 first, or to ProRes 4444 MOV when it needs transparency (`ffmpeg -i in.gif -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le out.mov`). placement is where the reviewer dropped it on the frame, as fractions of the frame (x, y of the top-left corner, w, h); markedFrame shows it in place.";
