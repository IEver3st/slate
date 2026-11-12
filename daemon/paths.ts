import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, rmdirSync } from "node:fs";
import { dirname, join, basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { appHome, legacyHome, CUT_DIR, LEGACY_CUT_DIR } from "../src/home";

export const APP_DIR = appHome();
export const LEGACY_LAYOUT = APP_DIR.toLowerCase() === legacyHome().toLowerCase();
export const CACHE_DIR = join(APP_DIR, "cache");
export const VIDEO_CACHE = join(CACHE_DIR, "v");
export const AUDIO_CACHE = join(CACHE_DIR, "a");
export const MOVIE_CACHE = join(CACHE_DIR, "movies");
export const BLANK_CACHE = join(CACHE_DIR, "blanks");
export const FRAME_CACHE = join(CACHE_DIR, "frames");
export const THUMB_CACHE = join(CACHE_DIR, "thumbs");
export const POSTER_CACHE = join(CACHE_DIR, "posters");
export const JOB_DIR = join(APP_DIR, "jobs");
export const BIN_DIR = join(APP_DIR, "bin");
export const DAEMON_FILE = join(APP_DIR, "daemon.json");
export const REGISTRY_FILE = join(APP_DIR, "registry.json");
export const DEFAULT_PORT = 47800;
export const HOME_ID = createHash("sha1").update(APP_DIR.toLowerCase()).digest("hex").slice(0, 12);

for (const d of [APP_DIR, VIDEO_CACHE, AUDIO_CACHE, MOVIE_CACHE, BLANK_CACHE, FRAME_CACHE, THUMB_CACHE, POSTER_CACHE, JOB_DIR, BIN_DIR]) mkdirSync(d, { recursive: true });

export function normPath(p: string) {
  return resolve(p).replace(/\//g, "\\");
}

export function cutIdFor(path: string) {
  return createHash("sha1").update(normPath(path).toLowerCase()).digest("hex").slice(0, 12);
}

export function legacyCutDataDir(path: string) {
  return join(dirname(path), LEGACY_CUT_DIR, basename(path, extname(path)));
}

export function cutDataDir(path: string) {
  const dir = join(dirname(path), CUT_DIR, basename(path, extname(path)));
  const legacy = legacyCutDataDir(path);
  if (LEGACY_LAYOUT) return legacy;
  if (existsSync(dir) || !existsSync(legacy)) return dir;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(legacy, dir);
  } catch (e) {
    console.error(`[slate] could not move ${legacy} to ${dir}, so it stays where it is: ${e instanceof Error ? e.message : e}`);
    return legacy;
  }
  try {
    rmdirSync(dirname(legacy));
  } catch {}
  console.log(`[slate] moved ${legacy} to ${dir}`);
  return dir;
}

export function relocated(file: string | undefined, from: string, to: string) {
  if (!file || from.toLowerCase() === to.toLowerCase() || !file.toLowerCase().startsWith(from.toLowerCase() + "\\")) return file;
  return join(to, file.slice(from.length + 1));
}

export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
