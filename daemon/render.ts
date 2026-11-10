import { existsSync, mkdirSync, rmSync, statSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportSpan, findCli, tryFindCli } from "./tsrct";
import { FFMPEG, PCM_BYTES_PER_FRAME, PCM_RATE, encodeMovie, pickEncoder, readWav, run, sliceWav, splitSpan, writeBuffer, moveInto, makeSlate } from "./media";
import { AUDIO_CACHE, BIN_DIR, FRAME_CACHE, JOB_DIR, MOVIE_CACHE, THUMB_CACHE, VIDEO_CACHE } from "./paths";
import { SEGMENT_MS } from "./doc";
import { emit } from "./events";
import { cacheLimitBytes, onServiceChange, serviceSettings } from "./service";
import type { Cut, SourceLease } from "./cuts";
import { RENDER_SETTINGS, stampOf } from "./cuts";
import type { Revision, SegmentState } from "./types";

export const SHIM = join(BIN_DIR, "dailies-ffmpeg.exe");

export async function ensureShim(daemonDir: string) {
  const src = join(daemonDir, "shim.ts");
  const stale = !existsSync(SHIM) || (existsSync(src) && statSync(src).mtimeMs > statSync(SHIM).mtimeMs);
  if (!stale) return;
  const p = Bun.spawn([process.execPath, "build", "--compile", src, "--outfile", SHIM], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`could not build ffmpeg shim: ${err}`);
}

export const videoFile = (key: string) => join(VIDEO_CACHE, `${key}.mp4`);
export const audioFile = (key: string) => join(AUDIO_CACHE, `${key}.pcm`);

export function segmentLengths(rev: Revision) {
  const out: number[] = [];
  for (let s = 0; s < rev.vkeys.length; s++) out.push(Math.min(rev.durationMs, (s + 1) * SEGMENT_MS) - s * SEGMENT_MS);
  return out;
}

type Job = {
  id: string;
  cut: Cut;
  rev: number;
  hash: string;
  from: number;
  to: number;
  vkeys: string[];
  akeys: string[];
  audioOnly: boolean;
  priority: number;
  state: "queued" | "running" | "done" | "failed";
  progress: number;
  pid?: number;
  kill?: () => void;
  startedAt?: number;
  error?: string;
};

type CutStats = { startupMs: number; perSegmentMs: number; samples: number; large: boolean };

const CHUNK_MIN = 8;
const CHUNK_MAX = 240;
const ASSEMBLE_MIN_GAP_MS = 4000;
const PLAYHEAD_FRESH_MS = 60_000;

function chunkFor(st: CutStats, audioOnly: boolean) {
  if (audioOnly) return CHUNK_MAX;
  return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.ceil((3 * st.startupMs) / st.perSegmentMs)));
}

export type Movie = {
  cutId: string;
  rev: number;
  file: string;
  key: string;
  stale: number[];
  missing: number[];
  complete: boolean;
  builtAt: number;
};

export class Renderer {
  private queue: Job[] = [];
  private running = new Set<Job>();
  private stats = new Map<string, CutStats>();
  private playheads = new Map<string, { t: number; at: number }>();
  private movies = new Map<string, Movie>();
  private assembling = new Map<string, Promise<void>>();
  private assembleAgain = new Set<string>();
  private assembled = new Map<string, { at: number; ms: number }>();
  private assembleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cli = tryFindCli();
  private failures = new Map<string, { at: number; error: string }>();
  concurrency = serviceSettings().renderSlots;

  constructor(private cuts: () => Cut[]) {
    onServiceChange((s) => {
      const grew = s.renderSlots > this.concurrency;
      this.concurrency = s.renderSlots;
      if (grew) this.pump();
      void this.evict();
    });
  }

  setPlayhead(cutId: string, t: number) {
    this.playheads.set(cutId, { t, at: Date.now() });
    this.reprioritize();
  }

  movie(cutId: string, rev: number) {
    return this.movies.get(`${cutId}:${rev}`);
  }

  movieFile(cutId: string, rev: number, key: string) {
    return join(MOVIE_CACHE, `${cutId}-r${rev}-${key}.mp4`);
  }

  dropQueued(cut: Cut, revN: number) {
    const hash = cut.revision(revN)?.hash;
    this.queue = this.queue.filter((j) => j.cut.id !== cut.id || j.rev !== revN || j.hash === hash);
  }

  abandon(cut: Cut, revN: number) {
    this.queue = this.queue.filter((j) => j.cut.id !== cut.id || j.rev !== revN);
    for (const j of this.running) {
      if (j.cut.id === cut.id && j.rev === revN) {
        j.error = "superseded";
        j.kill?.();
      }
    }
  }

  latestMovie(cutId: string) {
    let best: Movie | undefined;
    for (const m of this.movies.values()) if (m.cutId === cutId && (!best || m.rev > best.rev || (m.rev === best.rev && m.builtAt > best.builtAt))) best = m;
    return best;
  }

  segmentStates(cut: Cut, rev: Revision): SegmentState[] {
    return rev.vkeys.map((vk, s) => {
      const ak = rev.akeys[s];
      if (existsSync(videoFile(vk)) && existsSync(audioFile(ak))) return "ready";
      const job = [...this.running, ...this.queue].find((j) => j.cut.id === cut.id && j.error !== "superseded" && j.from <= s && s < j.to && j.vkeys[s - j.from] === vk);
      if (job) return job.state === "running" ? "rendering" : "queued";
      if (this.failures.has(`${vk}:${ak}`)) return "failed";
      return "missing";
    });
  }

  progressFor(cut: Cut) {
    const rev = cut.latest;
    if (!rev) return { ready: 0, total: 0, rendering: false, failed: 0 };
    const states = this.segmentStates(cut, rev);
    return {
      ready: states.filter((s) => s === "ready").length,
      total: states.length,
      rendering: states.some((s) => s === "rendering" || s === "queued"),
      failed: states.filter((s) => s === "failed").length,
    };
  }

  jobsFor(cutId: string) {
    return [...this.running, ...this.queue]
      .filter((j) => j.cut.id === cutId)
      .map((j) => ({ id: j.id, rev: j.rev, from: j.from, to: j.to, state: j.state, progress: j.progress }));
  }

  failureFor(cut: Cut) {
    const rev = cut.latest;
    if (!rev) return undefined;
    for (let s = 0; s < rev.vkeys.length; s++) {
      const f = this.failures.get(`${rev.vkeys[s]}:${rev.akeys[s]}`);
      if (f) return f.error;
    }
    return undefined;
  }

  retry(cut: Cut) {
    const rev = cut.latest;
    if (!rev) return;
    for (let s = 0; s < rev.vkeys.length; s++) this.failures.delete(`${rev.vkeys[s]}:${rev.akeys[s]}`);
    this.plan(cut, rev.n);
  }

  plan(cut: Cut, revN?: number) {
    const rev = cut.revision(revN);
    if (!rev) return;
    if (rev.n === cut.latest?.n) this.dropSuperseded(cut, rev);
    const needed: { s: number; audioOnly: boolean }[] = [];
    for (let s = 0; s < rev.vkeys.length; s++) {
      const vk = rev.vkeys[s];
      const ak = rev.akeys[s];
      const hasVideo = existsSync(videoFile(vk));
      if (hasVideo && existsSync(audioFile(ak))) continue;
      if (this.failures.has(`${vk}:${ak}`)) continue;
      const covered = [...this.running, ...this.queue].some((j) => j.cut.id === cut.id && j.error !== "superseded" && j.vkeys.includes(vk) && j.akeys[j.vkeys.indexOf(vk)] === ak);
      if (!covered) needed.push({ s, audioOnly: hasVideo });
    }
    const runs: [number, number, boolean][] = [];
    for (const { s, audioOnly } of needed) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s && last[2] === audioOnly) last[1] = s + 1;
      else runs.push([s, s + 1, audioOnly]);
    }
    const st = this.statsFor(cut);
    for (const [a, b, audioOnly] of runs) {
      const segs = b - a;
      const estimate = segs * st.perSegmentMs;
      let parts = 1;
      if (!audioOnly && !st.large && estimate > 2 * st.startupMs) parts = Math.min(this.concurrency, Math.max(1, Math.floor(estimate / (2 * st.startupMs))));
      const size = Math.ceil(segs / parts);
      for (let from = a; from < b; from += size) {
        const to = Math.min(b, from + size);
        this.queue.push({
          id: randomUUID().slice(0, 8),
          cut,
          rev: rev.n,
          hash: rev.hash,
          from,
          to,
          vkeys: rev.vkeys.slice(from, to),
          akeys: rev.akeys.slice(from, to),
          audioOnly,
          priority: 0,
          state: "queued",
          progress: 0,
        });
      }
    }
    this.reprioritize();
    emit({ type: "cut", cutId: cut.id });
    void this.assemble(cut, rev.n);
  }

  private dropSuperseded(cut: Cut, rev: Revision) {
    const wanted = new Set(rev.vkeys.map((v, i) => `${v}:${rev.akeys[i]}`));
    const useful = (j: Job) => j.vkeys.some((v, i) => wanted.has(`${v}:${j.akeys[i]}`));
    this.queue = this.queue.filter((j) => j.cut.id !== cut.id || (j.rev === rev.n ? useful(j) : !!cut.renderSource(j.rev)));
    for (const j of this.running) {
      if (j.cut.id === cut.id && !useful(j)) {
        j.error = "superseded";
        j.kill?.();
      }
    }
  }

  private statsFor(cut: Cut): CutStats {
    const large = (cut.latest?.fileSize ?? 0) > 1_000_000_000;
    let st = this.stats.get(cut.id);
    if (!st) {
      st = { startupMs: large ? 35000 : 6000, perSegmentMs: large ? 10000 : 700, samples: 0, large };
      this.stats.set(cut.id, st);
    }
    st.large = large;
    return st;
  }

  private playheadSegment(cutId: string) {
    const ph = this.playheads.get(cutId);
    return ph && Date.now() - ph.at < PLAYHEAD_FRESH_MS ? Math.floor(ph.t / SEGMENT_MS) : undefined;
  }

  private rank() {
    for (const j of this.queue) {
      const seg = this.playheadSegment(j.cut.id);
      let p = 0;
      if (j.rev === j.cut.latest?.n) p += 1000;
      if (seg !== undefined) {
        p += 500;
        if (seg >= j.from && seg < j.to) p += 2000;
        else if (seg < j.from) p += Math.max(0, 300 - (j.from - seg) * 5);
        else p += Math.max(0, 300 - (seg - j.to + 1) * 20);
      }
      j.priority = p;
    }
    this.queue.sort((a, b) => b.priority - a.priority || a.from - b.from);
  }

  private reprioritize() {
    this.rank();
    this.pump();
  }

  private carve(job: Job): Job {
    const chunk = chunkFor(this.statsFor(job.cut), job.audioOnly);
    if (job.to - job.from <= chunk) return job;
    const seg = this.playheadSegment(job.cut.id);
    const start = seg !== undefined && seg > job.from && seg < job.to ? Math.max(job.from, Math.min(seg, job.to - chunk)) : job.from;
    const end = start + chunk;
    const piece = (from: number, to: number): Job => ({
      ...job,
      id: randomUUID().slice(0, 8),
      from,
      to,
      vkeys: job.vkeys.slice(from - job.from, to - job.from),
      akeys: job.akeys.slice(from - job.from, to - job.from),
    });
    if (start > job.from) this.queue.push(piece(job.from, start));
    if (end < job.to) this.queue.push(piece(end, job.to));
    this.rank();
    return piece(start, end);
  }

  private runnable(job: Job) {
    if (!this.statsFor(job.cut).large) return true;
    for (const r of this.running) if (r.cut.id === job.cut.id) return false;
    return true;
  }

  private pump() {
    while (this.running.size < this.concurrency) {
      const i = this.queue.findIndex((j) => this.runnable(j));
      if (i < 0) break;
      const job = this.carve(this.queue.splice(i, 1)[0]);
      this.running.add(job);
      void this.runJob(job).finally(() => {
        this.running.delete(job);
        this.pump();
      });
    }
  }

  private async runJob(job: Job) {
    const source = job.cut.leaseSource(job.rev);
    if (!source) {
      job.state = "failed";
      job.error = "the archive for this revision is no longer available";
      console.error(`[dailies] skipped ${job.cut.name} r${job.rev} ${job.from}-${job.to}: ${job.error}`);
      return;
    }
    try {
      await this.renderFrom(job, source);
    } finally {
      source.release();
    }
  }

  private async renderFrom(job: Job, source: SourceLease) {
    const { cut } = job;
    job.state = "running";
    job.startedAt = Date.now();
    const dir = join(JOB_DIR, job.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const rev = cut.revision(job.rev)!;
    const lengths = segmentLengths(rev).slice(job.from, job.to);
    const startMs = job.from * SEGMENT_MS;
    const durationMs = lengths.reduce((a, b) => a + b, 0);
    emit({ type: "render", cutId: cut.id, rev: job.rev, span: [job.from, job.to], progress: 0, state: "rendering" });
    let firstRenderAt: number | undefined;
    try {
      if (!source.fresh) throw new Error("the cut changed while rendering");
      const encoder = await pickEncoder();
      const fps = job.audioOnly ? 1 : RENDER_SETTINGS.fps;
      const ex = exportSpan({
        cli: this.cli ?? findCli(),
        project: source.path,
        output: join(dir, "span.mp4"),
        resolution: job.audioOnly ? "720p" : RENDER_SETTINGS.resolution,
        fps,
        startMs,
        durationMs,
        shim: SHIM,
        env: { DAILIES_JOB: dir, DAILIES_ENCODER: encoder, DAILIES_GOP: String(Math.max(1, Math.round((fps * RENDER_SETTINGS.keyframeMs) / 1000))), DAILIES_FFMPEG: FFMPEG },
        onProgress: (p) => {
          if (p.phase === "render" && firstRenderAt === undefined) firstRenderAt = Date.now();
          if (p.total) {
            job.progress = Math.min(0.99, (p.completed ?? 0) / p.total);
            emit({ type: "render", cutId: cut.id, rev: job.rev, span: [job.from, job.to], progress: job.progress, state: "rendering" });
          }
        },
      });
      job.pid = ex.pid;
      job.kill = () => void taskkillTree(ex.pid);
      await ex.done;
      if (job.error === "superseded") throw new Error("superseded");
      if (stampOf(source.path) !== source.stamp) throw new Error("the cut changed while rendering");
      const pcm = spanAudio(dir, job.to - job.from, lengths);
      if (!job.audioOnly) {
        const segs = await splitSpan({ spanFile: join(dir, "span.mp4"), workDir: dir, firstSegment: job.from, segmentCount: job.to - job.from, lastSegmentMs: lengths[lengths.length - 1] });
        segs.forEach((f, i) => moveInto(f, videoFile(job.vkeys[i])));
      }
      pcm.forEach((b, i) => {
        const target = audioFile(job.akeys[i]);
        if (!existsSync(target)) writeBuffer(target, b);
      });
      const total = Date.now() - job.startedAt!;
      if (!job.audioOnly) {
        const st = this.statsFor(cut);
        const startup = firstRenderAt ? firstRenderAt - job.startedAt! : total * 0.6;
        const perSeg = Math.max(50, (total - startup) / (job.to - job.from));
        st.startupMs = st.samples ? st.startupMs * 0.6 + startup * 0.4 : startup;
        st.perSegmentMs = st.samples ? st.perSegmentMs * 0.6 + perSeg * 0.4 : perSeg;
        st.samples++;
      }
      console.log(`[dailies] rendered ${cut.name} r${job.rev} ${job.from}-${job.to}${job.audioOnly ? " (audio only)" : ""} in ${total} ms`);
      job.state = "done";
      job.progress = 1;
      emit({ type: "render", cutId: cut.id, rev: job.rev, span: [job.from, job.to], progress: 1, state: "done" });
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      job.state = "failed";
      const msg = job.error === "superseded" ? "superseded" : e instanceof Error ? e.message : String(e);
      job.error = msg;
      if (msg === "superseded") rmSync(dir, { recursive: true, force: true });
      else {
        for (let i = 0; i < job.vkeys.length; i++) this.failures.set(`${job.vkeys[i]}:${job.akeys[i]}`, { at: Date.now(), error: msg });
        console.error(`[dailies] render ${cut.name} r${job.rev} ${job.from}-${job.to} failed: ${msg}`);
        if (firstRenderAt === undefined && !msg.includes("changed while rendering")) {
          const siblings = this.queue.filter((j) => j.cut.id === cut.id && j.hash === job.hash);
          for (const j of siblings) for (let i = 0; i < j.vkeys.length; i++) this.failures.set(`${j.vkeys[i]}:${j.akeys[i]}`, { at: Date.now(), error: msg });
          if (siblings.length) this.queue = this.queue.filter((j) => !siblings.includes(j));
        }
        if (msg.includes("changed while rendering")) {
          for (let i = 0; i < job.vkeys.length; i++) this.failures.delete(`${job.vkeys[i]}:${job.akeys[i]}`);
          void cut.ingestQuietly().then(() => {
            if (cut.latest && cut.liveMatches(cut.latest.n) && cut.revision(job.rev)) this.plan(cut, job.rev);
          });
        }
      }
      emit({ type: "render", cutId: cut.id, rev: job.rev, span: [job.from, job.to], progress: job.progress, state: "failed", error: msg });
    }
    const vkeys = new Set(job.vkeys);
    const akeys = new Set(job.akeys);
    for (const c of this.cuts()) {
      const latest = c.latest;
      if (latest && latest.vkeys.some((k, i) => vkeys.has(k) || akeys.has(latest.akeys[i]))) void this.assemble(c, latest.n);
    }
    if (job.rev !== cut.latest?.n) void this.assemble(cut, job.rev);
  }

  private busy(cutId: string) {
    return [...this.running, ...this.queue].some((j) => j.cut.id === cutId && (j.state === "queued" || j.state === "running"));
  }

  async assemble(cut: Cut, revN: number) {
    const key = `${cut.id}:${revN}`;
    const last = this.assembled.get(key);
    if (last && this.busy(cut.id)) {
      const wait = last.at + Math.max(ASSEMBLE_MIN_GAP_MS, last.ms * 2) - Date.now();
      if (wait > 0) {
        if (!this.assembleTimers.has(key)) {
          this.assembleTimers.set(
            key,
            setTimeout(() => {
              this.assembleTimers.delete(key);
              void this.assemble(cut, revN);
            }, wait),
          );
        }
        return;
      }
    }
    if (this.assembling.has(key)) {
      this.assembleAgain.add(key);
      return this.assembling.get(key);
    }
    const p = (async () => {
      do {
        this.assembleAgain.delete(key);
        await this.assembleOnce(cut, revN);
      } while (this.assembleAgain.has(key));
    })().finally(() => this.assembling.delete(key));
    this.assembling.set(key, p);
    return p;
  }

  private async assembleOnce(cut: Cut, revN: number) {
    const rev = cut.revision(revN);
    if (!rev) return;
    const lengths = segmentLengths(rev);
    const prevMovie = this.movie(cut.id, revN);
    const older = cut.revisions.filter((r) => r.n !== revN && r.width === rev.width && r.height === rev.height).sort((a, b) => Math.abs(a.n - revN) - Math.abs(b.n - revN) || b.n - a.n);
    const fallback = (s: number, kind: "v" | "a") => {
      for (const r of older) {
        if (s >= r.vkeys.length || Math.min(r.durationMs, (s + 1) * SEGMENT_MS) - s * SEGMENT_MS !== lengths[s]) continue;
        const f = kind === "v" ? videoFile(r.vkeys[s]) : audioFile(r.akeys[s]);
        if (existsSync(f)) return f;
      }
      return undefined;
    };
    const video: string[] = [];
    const audio: (string | undefined)[] = [];
    const stale: number[] = [];
    const missing: number[] = [];
    for (let s = 0; s < rev.vkeys.length; s++) {
      const v = videoFile(rev.vkeys[s]);
      const a = audioFile(rev.akeys[s]);
      const haveV = existsSync(v);
      const haveA = existsSync(a);
      const oldV = haveV ? v : fallback(s, "v");
      const oldA = haveA ? a : fallback(s, "a");
      if (haveV && haveA) {
        video.push(v);
        audio.push(a);
      } else if (oldV && oldA) {
        video.push(oldV);
        audio.push(oldA);
        stale.push(s);
      } else {
        video.push(await makeSlate(rev.width, rev.height, lengths[s], RENDER_SETTINGS.fps));
        audio.push(oldA);
        missing.push(s);
      }
    }
    const movieKey = Bun.hash(video.join("|") + "#" + audio.join("|")).toString(16);
    if (prevMovie && prevMovie.key === movieKey && existsSync(prevMovie.file)) return;
    if (missing.length === rev.vkeys.length) {
      emit({ type: "cut", cutId: cut.id });
      return;
    }
    const file = this.movieFile(cut.id, revN, movieKey);
    if (!existsSync(file)) {
      const started = Date.now();
      await encodeMovie(video, audio, lengths, file);
      this.assembled.set(`${cut.id}:${revN}`, { at: Date.now(), ms: Date.now() - started });
    }
    for (const f of [...video, ...audio]) if (f) this.touch(f);
    const movie: Movie = { cutId: cut.id, rev: revN, file, key: movieKey, stale, missing, complete: !stale.length && !missing.length, builtAt: Date.now() };
    this.movies.set(`${cut.id}:${revN}`, movie);
    emit({ type: "cut", cutId: cut.id });
    emit({ type: "mix", cutId: cut.id, rev: revN });
    this.gcMovies(cut.id);
  }

  private gcMovies(cutId: string) {
    const keep = new Set([...this.movies.values()].filter((m) => m.cutId === cutId).map((m) => m.file));
    try {
      for (const f of readdirSync(MOVIE_CACHE)) {
        if (!f.startsWith(`${cutId}-`)) continue;
        const p = join(MOVIE_CACHE, f);
        if (keep.has(p)) continue;
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > 10 * 60_000) rmSync(p, { force: true });
      }
    } catch {}
  }

  touch(file: string) {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {}
  }

  evict(limitBytes = cacheLimitBytes()) {
    const pinned = new Set<string>();
    for (const c of this.cuts()) {
      for (const r of [c.latest, c.revision(c.approvedRev)]) {
        if (!r) continue;
        r.vkeys.forEach((k) => pinned.add(videoFile(k)));
        r.akeys.forEach((k) => pinned.add(audioFile(k)));
      }
    }
    for (const m of this.movies.values()) pinned.add(m.file);
    const files: { path: string; size: number; at: number }[] = [];
    for (const dir of [VIDEO_CACHE, AUDIO_CACHE, FRAME_CACHE, THUMB_CACHE, MOVIE_CACHE]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const p = join(dir, n);
        try {
          const s = statSync(p);
          if (s.isFile()) files.push({ path: p, size: s.size, at: s.mtimeMs });
        } catch {}
      }
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    const before = total;
    let removed = 0;
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= limitBytes) break;
      if (pinned.has(f.path) || Date.now() - f.at < 10 * 60_000) continue;
      try {
        rmSync(f.path, { force: true });
        total -= f.size;
        removed++;
      } catch {}
    }
    if (removed) console.log(`[dailies] cache trimmed from ${(before / 1e9).toFixed(2)} GB to ${(total / 1e9).toFixed(2)} GB (${removed} files)`);
    return { before, after: total, removed };
  }
}

function spanAudio(dir: string, segmentCount: number, lengths: number[]): Buffer[] {
  const wav = join(dir, "audio.wav");
  if (existsSync(wav)) return sliceWav(readWav(wav), segmentCount, lengths);
  let calls: string;
  try {
    calls = readFileSync(join(dir, "shim.log"), "utf8");
  } catch {
    throw new Error(`tsrct never ran Dailies' ffmpeg shim, so the span's audio is unknown (no ${join(dir, "shim.log")})`);
  }
  if (/\.wav"/i.test(calls) || /^error /m.test(calls)) throw new Error(`the span's audio was mixed but never reached Dailies (see ${join(dir, "shim.log")})`);
  return lengths.map((ms) => Buffer.alloc(SEGMENT_PCM_BYTES(ms)));
}

export async function taskkillTree(pid: number) {
  await run(["taskkill", "/T", "/F", "/PID", String(pid)]);
}

export const SEGMENT_PCM_BYTES = (ms: number) => Math.round((ms * PCM_RATE) / 1000) * PCM_BYTES_PER_FRAME;
