import { existsSync, readdirSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { APP_DIR, CACHE_DIR, AUDIO_CACHE, FRAME_CACHE, MOVIE_CACHE, POSTER_CACHE, BLANK_CACHE, THUMB_CACHE, VIDEO_CACHE, readJson, writeJsonAtomic } from "./paths";
import { emit } from "./events";

export type PreviewQuality = "1080p60" | "720p60" | "720p30";
export type PreviewPreset = { id: PreviewQuality; resolution: string; fps: number; label: string; shortLabel: string; detail: string };

export const PREVIEW_QUALITIES: Record<PreviewQuality, PreviewPreset> = {
  "1080p60": { id: "1080p60", resolution: "1080p", fps: 60, label: "Sharp (1080p60)", shortLabel: "1080p60", detail: "Full HD at 60 fps" },
  "720p60": { id: "720p60", resolution: "720p", fps: 60, label: "Fast (720p60)", shortLabel: "720p60", detail: "~2x faster renders, smooth 60 fps" },
  "720p30": { id: "720p30", resolution: "720p", fps: 30, label: "Turbo (720p30)", shortLabel: "720p30", detail: "~3.5x faster renders, rapid iteration" },
};
export const PREVIEW_CHOICES: PreviewQuality[] = ["1080p60", "720p60", "720p30"];

export type ServiceSettings = { cacheGb: number; renderSlots: number; previewQuality: PreviewQuality; mediaDir?: string };

export const CACHE_CHOICES = [5, 10, 20, 50, 100, 200];
export const SLOT_CHOICES = [1, 2, 3, 4, 6, 8, 10, 12];
const AUTO_SLOTS = (() => {
  const n = Math.min(6, Math.max(3, Math.floor(cpus().length / 4)));
  return SLOT_CHOICES.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), 4);
})();

export const SERVICE_DEFAULTS: ServiceSettings = {
  cacheGb: CACHE_CHOICES.includes(Number(process.env.SLATE_CACHE_GB)) ? Number(process.env.SLATE_CACHE_GB) : 20,
  renderSlots: AUTO_SLOTS,
  previewQuality: "1080p60",
};

const FILE = join(APP_DIR, "service.json");

function clean(raw: Partial<Record<keyof ServiceSettings, unknown>>, base: ServiceSettings): ServiceSettings {
  const out = { ...base };
  if (CACHE_CHOICES.includes(raw.cacheGb as number)) out.cacheGb = raw.cacheGb as number;
  if (SLOT_CHOICES.includes(raw.renderSlots as number)) out.renderSlots = raw.renderSlots as number;
  if (PREVIEW_CHOICES.includes(raw.previewQuality as PreviewQuality)) out.previewQuality = raw.previewQuality as PreviewQuality;
  if (raw.mediaDir === null || raw.mediaDir === "") delete out.mediaDir;
  else if (typeof raw.mediaDir === "string") {
    const dir = resolve(raw.mediaDir.trim());
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    out.mediaDir = dir;
  }
  return out;
}

let current = clean(readJson(FILE, {}), SERVICE_DEFAULTS);
const listeners = new Set<(s: ServiceSettings) => void>();

export const serviceSettings = () => current;
export const cacheLimitBytes = () => current.cacheGb * 1e9;

export function updateService(patch: Partial<Record<keyof ServiceSettings, unknown>>) {
  const next = clean(patch, current);
  if (next.cacheGb === current.cacheGb && next.renderSlots === current.renderSlots && next.previewQuality === current.previewQuality && next.mediaDir === current.mediaDir) return current;
  current = next;
  writeJsonAtomic(FILE, current);
  for (const l of listeners) l(current);
  emit({ type: "service" });
  return current;
}

export function onServiceChange(fn: (s: ServiceSettings) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type CacheUsage = { total: number; kinds: { id: string; label: string; bytes: number; files: number }[] };

const KINDS = [
  { id: "video", label: "Video segments", dirs: [VIDEO_CACHE] },
  { id: "movies", label: "Assembled cuts", dirs: [MOVIE_CACHE] },
  { id: "audio", label: "Audio", dirs: [AUDIO_CACHE] },
  { id: "stills", label: "Frames and thumbnails", dirs: [FRAME_CACHE, THUMB_CACHE, POSTER_CACHE, BLANK_CACHE, join(CACHE_DIR, "media")] },
];

function sizeOf(dir: string) {
  let bytes = 0;
  let files = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { bytes, files };
  }
  for (const n of names) {
    try {
      const s = statSync(join(dir, n));
      if (s.isFile()) {
        bytes += s.size;
        files++;
      }
    } catch {}
  }
  return { bytes, files };
}

export function cacheUsage(): CacheUsage {
  const kinds = KINDS.map((k) => {
    const parts = k.dirs.map(sizeOf);
    return { id: k.id, label: k.label, bytes: parts.reduce((a, p) => a + p.bytes, 0), files: parts.reduce((a, p) => a + p.files, 0) };
  });
  return { total: kinds.reduce((a, k) => a + k.bytes, 0), kinds };
}
