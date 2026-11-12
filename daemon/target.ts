import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FFMPEG, run } from "./media";
import { findCli } from "./tsrct";
import { FRAME_CACHE } from "./paths";
import { absoluteWindow, findLayer } from "./doc";
import type { Cut } from "./cuts";
import type { NoteTarget } from "./types";

type Box = NonNullable<NoteTarget["box"]>;

const SOLO_FPS = 30;
const MASK_SHORT = 360;
const ALPHA_MIN = 16;

let chain: Promise<unknown> = Promise.resolve();
let latest = 0;

export async function measureTarget(cut: Cut, revN: number, t: number, layerId: number): Promise<Box | null> {
  const rev = cut.revision(revN) ?? cut.latest;
  const doc = rev ? cut.docFor(rev.n)?.doc : undefined;
  if (!rev || !doc || !findLayer(doc, layerId)) return null;
  const w = absoluteWindow(doc, layerId);
  if (!w || !(t >= w.start && t < w.end)) return null;
  const frame = Math.max(0, Math.floor(((t - w.start) * SOLO_FPS) / 1000));
  const cache = join(FRAME_CACHE, `target-${rev.hash}-${layerId}-${frame}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")).box;
  const ticket = ++latest;
  const job = chain.then(async () => {
    if (ticket !== latest) return undefined;
    return solo(cut, rev.n, doc.composition.id ?? "main", layerId, frame, rev.width, rev.height);
  });
  chain = job.catch(() => {});
  const box = await job;
  if (box === undefined) return null;
  writeFileSync(cache, JSON.stringify({ box }));
  return box;
}

async function solo(cut: Cut, n: number, comp: string, layerId: number, frame: number, width: number, height: number): Promise<Box | null> {
  const lease = cut.leaseSource(n);
  if (!lease) throw new Error("revision archive not available");
  const mov = join(FRAME_CACHE, `solo-${randomUUID().slice(0, 8)}.mov`);
  try {
    const p = Bun.spawn([findCli(), "export", "--project", lease.path, "--output", mov, "--format", "prores", "--resolution", "720p", "--fps", String(SOLO_FPS), "--fx-solo", `${comp}:${layerId}`, "--start-frame", String(frame), "--frame-count", "1"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(err.trim().split("\n").slice(-2).join(" | "));
    const portrait = height > width;
    const W = portrait ? MASK_SHORT : Math.round((MASK_SHORT * width) / height);
    const H = portrait ? Math.round((MASK_SHORT * height) / width) : MASK_SHORT;
    const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", mov, "-frames:v", "1", "-vf", `alphaextract,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]);
    if (r.code !== 0) throw new Error(r.stderr);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (r.stdout[y * W + x] < ALPHA_MIN) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    return { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
  } finally {
    lease.release();
    rmSync(mov, { force: true });
  }
}
