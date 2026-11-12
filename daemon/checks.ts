import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./media";
import { audioFile } from "./render";
import { SEGMENT_MS } from "./doc";
import { emit } from "./events";
import type { Cut } from "./cuts";

export type Finding = { level: "error" | "warning" | "allowed"; rule: string; message: string; atMs?: number; source: "cutlint" | "sound" };
export type Checks = { lint: "ready" | "running" | "missing" | "failed"; sound: "ready" | "waiting"; findings: Finding[] };

const CLIP_LEVEL = 32700;
const CLIP_RUN = 3;
const CLIP_MERGE_MS = 1000;

let tool: Promise<{ python: string; script: string } | undefined> | undefined;

export function cutlintTool() {
  tool ??= (async () => {
    const script = process.env.SLATE_CUTLINT || join(homedir(), ".agent-infra", "repo", "skills", "video", "kit", "tools", "cutlint.py");
    if (!existsSync(script)) return undefined;
    for (const python of ["python", "py"]) {
      const r = await run([python, "--version"]).catch(() => undefined);
      if (r?.code === 0) return { python, script };
    }
    return undefined;
  })();
  return tool;
}

const lintCache = new Map<string, { state: "ready" | "failed"; findings: Finding[] }>();
const lintRunning = new Set<string>();
const soundCache = new Map<string, Finding[]>();

const waivers = (summary?: string) =>
  [...(summary ?? "").matchAll(/lint-ok:\s*([^\n.;]+)/gi)].flatMap((m) => m[1].toLowerCase().match(/[a-z]+(?:-[a-z]+)+/g) ?? []);

async function lint(cut: Cut, n: number, key: string) {
  const t = await cutlintTool();
  const rev = cut.revision(n);
  const lease = rev ? cut.leaseSource(n) : undefined;
  const file = lease?.path ?? cut.rawDocFile(n);
  if (!t || !rev || !existsSync(file)) {
    lease?.release();
    lintCache.set(key, { state: "failed", findings: [] });
    return;
  }
  const allow = waivers(rev.summary);
  const r = await run([t.python, "-X", "utf8", t.script, file, "--json", "--no-audio", "--product", basename(cut.path, ".tsrct"), ...(allow.length ? ["--allow", ...allow] : [])]).catch(() => undefined).finally(() => lease?.release());
  try {
    const report = JSON.parse(new TextDecoder().decode(r?.stdout ?? new Uint8Array()));
    const findings: Finding[] = (report.findings ?? []).map((f: any) => ({ level: f.level, rule: f.rule, message: f.message, atMs: typeof f.atMs === "number" ? f.atMs : undefined, source: "cutlint" }));
    lintCache.set(key, { state: "ready", findings });
  } catch {
    lintCache.set(key, { state: "failed", findings: [] });
  }
}

function clipping(cut: Cut, n: number): Finding[] | undefined {
  const rev = cut.revision(n);
  if (!rev) return undefined;
  const key = rev.akeys.join(",");
  const hit = soundCache.get(key);
  if (hit) return hit;
  if (!rev.akeys.every((k) => existsSync(audioFile(k)))) return undefined;
  const found: Finding[] = [];
  let last = -Infinity;
  rev.akeys.forEach((k, s) => {
    const file = audioFile(k);
    const buf = Buffer.alloc(statSync(file).size);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const frames = buf.length >> 2;
    const runs = [0, 0];
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = Math.abs(buf.readInt16LE(i * 4 + ch * 2));
        runs[ch] = v >= CLIP_LEVEL ? runs[ch] + 1 : 0;
        if (runs[ch] === CLIP_RUN) {
          const at = s * SEGMENT_MS + Math.round((i / frames) * SEGMENT_MS);
          if (at - last > CLIP_MERGE_MS) found.push({ level: "warning", rule: "clipping", message: "The mix clips here. Lower the loudest layer or the master.", atMs: at, source: "sound" });
          last = at;
        }
      }
    }
  });
  soundCache.set(key, found);
  return found;
}

export async function checksFor(cut: Cut, n: number): Promise<Checks | undefined> {
  const rev = cut.revision(n);
  if (!rev) return undefined;
  const key = `${cut.id}:${rev.hash}:${rev.summary ?? ""}`;
  const t = await cutlintTool();
  let lintState: Checks["lint"] = "missing";
  const findings: Finding[] = [];
  if (t) {
    const done = lintCache.get(key);
    if (done) {
      lintState = done.state;
      findings.push(...done.findings);
    } else {
      lintState = "running";
      if (!lintRunning.has(key)) {
        lintRunning.add(key);
        void lint(cut, n, key).finally(() => {
          lintRunning.delete(key);
          emit({ type: "checks", cutId: cut.id });
        });
      }
    }
  }
  const sound = clipping(cut, n);
  if (sound) findings.push(...sound);
  findings.sort((x, y) => (x.atMs ?? -1) - (y.atMs ?? -1));
  return { lint: lintState, sound: sound ? "ready" : "waiting", findings };
}

const PEAK_MS = 50;
const peakCache = new Map<string, number[]>();

function peaksOf(key: string) {
  const hit = peakCache.get(key);
  if (hit) return hit;
  const file = audioFile(key);
  if (!existsSync(file)) return undefined;
  const buf = Buffer.alloc(statSync(file).size);
  const fd = openSync(file, "r");
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const frames = buf.length >> 2;
  const bins = Math.max(1, Math.round(SEGMENT_MS / PEAK_MS));
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    const from = Math.floor((b / bins) * frames);
    const to = Math.floor(((b + 1) / bins) * frames);
    for (let i = from; i < to; i++) {
      const l = buf.readInt16LE(i * 4);
      const r = buf.readInt16LE(i * 4 + 2);
      sum += (l * l + r * r) / 2;
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from)) / 32768;
    const db = rms > 0 ? 20 * Math.log10(rms) : -96;
    out.push(Math.round(Math.max(0, Math.min(1, (db + 42) / 42)) * 255));
  }
  if (peakCache.size > 4000) peakCache.delete(peakCache.keys().next().value!);
  peakCache.set(key, out);
  return out;
}

export function peaksFor(cut: Cut, n: number) {
  const rev = cut.revision(n);
  if (!rev) return undefined;
  return { binMs: PEAK_MS, seconds: rev.akeys.map((k) => peaksOf(k) ?? null) };
}
