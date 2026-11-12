import { existsSync, readFileSync } from "node:fs";
import { FFMPEG, run } from "./media";
import { audioFile, videoFile } from "./render";
import { absoluteWindow, diffDocs } from "./doc";
import { emit } from "./events";
import type { Cut } from "./cuts";
import type { LayerChange } from "./doc";

export type SecondDiff = { s: number; picture: Verdict; sound: Verdict };
type Verdict = "same" | "changed" | "maybe" | "only";
export type PairChange = LayerChange & { startMs?: number; endMs?: number };
export type PairDiff = { old: number; new: number; a: number; b: number; seconds: SecondDiff[]; changes: PairChange[]; pending: number };

const PROBE_W = 128;
const PROBE_H = 228;
const PROBE_FPS = 10;
const PIXEL_DELTA = 20;
const PIXEL_SHARE = 0.0015;
const SOUND_RMS = 33;

const verdicts = new Map<string, boolean>();
const inflight = new Set<string>();
const queue: (() => Promise<void>)[] = [];
let running = 0;

const pairKey = (kind: string, x: string, y: string) => `${kind}:${x < y ? `${x}:${y}` : `${y}:${x}`}`;

function schedule(job: () => Promise<void>) {
  queue.push(job);
  pump();
}

function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

async function probeFrames(file: string) {
  const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-vf", `fps=${PROBE_FPS},scale=${PROBE_W}:${PROBE_H},format=gray`, "-f", "rawvideo", "-"]);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

async function pictureDiffers(x: string, y: string) {
  const [a, b] = await Promise.all([probeFrames(videoFile(x)), probeFrames(videoFile(y))]);
  const size = PROBE_W * PROBE_H;
  const frames = Math.min(a.length, b.length) / size;
  if (Math.abs(a.length - b.length) >= size) return true;
  for (let f = 0; f < frames; f++) {
    let hits = 0;
    for (let i = f * size; i < (f + 1) * size; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) hits++;
    if (hits / size > PIXEL_SHARE) return true;
  }
  return false;
}

function soundDiffers(x: string, y: string) {
  const a = readFileSync(audioFile(x));
  const b = readFileSync(audioFile(y));
  if (a.equals(b)) return false;
  const n = Math.min(a.length, b.length) >> 1;
  if (Math.abs(a.length - b.length) > 4 * 480) return true;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a.readInt16LE(i * 2) - b.readInt16LE(i * 2);
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, n)) > SOUND_RMS;
}

function verdict(kind: "v" | "a", x: string | undefined, y: string | undefined, onDone: () => void): Verdict {
  if (!x || !y) return "only";
  if (x === y) return "same";
  const key = pairKey(kind, x, y);
  const known = verdicts.get(key);
  if (known !== undefined) return known ? "changed" : "same";
  const ready = kind === "v" ? existsSync(videoFile(x)) && existsSync(videoFile(y)) : existsSync(audioFile(x)) && existsSync(audioFile(y));
  if (ready && !inflight.has(key)) {
    inflight.add(key);
    schedule(async () => {
      try {
        verdicts.set(key, kind === "v" ? await pictureDiffers(x, y) : soundDiffers(x, y));
      } catch {
        verdicts.set(key, true);
      } finally {
        inflight.delete(key);
        onDone();
      }
    });
  }
  return "maybe";
}

const notifyLater = new Map<string, ReturnType<typeof setTimeout>>();

export function diffPair(cut: Cut, a: number, b: number): PairDiff | undefined {
  const ra = cut.revision(a);
  const rb = cut.revision(b);
  if (!ra || !rb) return undefined;
  const [older, newer] = ra.n <= rb.n ? [ra, rb] : [rb, ra];
  const notify = () => {
    clearTimeout(notifyLater.get(cut.id));
    notifyLater.set(cut.id, setTimeout(() => emit({ type: "diff", cutId: cut.id }), 250));
  };
  const count = Math.max(older.vkeys.length, newer.vkeys.length);
  const seconds: SecondDiff[] = [];
  for (let s = 0; s < count; s++) {
    seconds.push({ s, picture: verdict("v", older.vkeys[s], newer.vkeys[s], notify), sound: verdict("a", older.akeys[s], newer.akeys[s], notify) });
  }
  const docOld = cut.docFor(older.n)?.doc;
  const docNew = cut.docFor(newer.n)?.doc;
  const changes: PairChange[] = [];
  if (docNew) {
    for (const c of diffDocs(docOld, docNew)) {
      const w = c.id < 0 ? undefined : absoluteWindow(c.kind === "removed" && docOld ? docOld : docNew, c.id);
      changes.push({ ...c, startMs: w && Number.isFinite(w.start) ? Math.round(w.start) : undefined, endMs: w && Number.isFinite(w.end) ? Math.round(w.end) : undefined });
    }
    const differs = seconds.some((x) => x.picture !== "same" || x.sound !== "same");
    if (differs && !changes.some((c) => c.id >= 0)) changes.push({ id: -3, name: "Project settings", type: "Project", kind: "changed", fields: ["render settings"] });
  }
  const pending = seconds.filter((x) => x.picture === "maybe" || x.sound === "maybe").length;
  return { old: older.n, new: newer.n, a, b, seconds, changes, pending };
}
