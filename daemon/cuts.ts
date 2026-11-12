import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, watch, linkSync, rmSync, readdirSync, appendFileSync, renameSync, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { copyFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { listZip, readZipEntry } from "./zip";
import { analyze, diffDocs, hash, type Analysis, type AssetTable, type Doc, canonical, editedValue, findLayer } from "./doc";
import { cutDataDir, cutIdFor, legacyCutDataDir, normPath, readJson, relocated, writeJsonAtomic, REGISTRY_FILE } from "./paths";
import { emit } from "./events";
import { owner } from "./settings";
import type { Activity, Author, CutSummary, Note, Revision } from "./types";

export const RENDER_SETTINGS = { resolution: "1080p", fps: 60, segmentMs: 1000, keyframeMs: 500, version: 2, cli: "", encoder: "" };

export function configureRender(cli: string, encoder: string) {
  RENDER_SETTINGS.cli = cli;
  RENDER_SETTINGS.encoder = encoder;
}

export const keySignature = () => hash(RENDER_SETTINGS);

export const ATTRIBUTION_MS = 5 * 60_000;
const FOLD_MS = 30_000;
const FOLD_SPAN_MS = 3 * 60_000;
const SNAPSHOT_KEEP = 6;
const SNAPSHOT_MIN = 2;
const SNAPSHOT_BUDGET = 3_000_000_000;
export const COPY_LIMIT = 1_500_000_000;
const STABLE_WAIT_MS = 120_000;
const ACTIVITY_KEEP = 400;
const ACTIVITY_COMPACT_BYTES = 2_000_000;

const activeLeases = new Set<string>();

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type Storage = { mode: "linked" | "copied" | "none"; reason?: string };
export type SourceLease = { path: string; live: boolean; leased: boolean; fresh: boolean; stamp: string; release: () => void };

export function stampOf(path: string) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    return "gone";
  }
}

const sameFile = (a: string, b: string) => {
  try {
    return statSync(a, { bigint: true }).ino === statSync(b, { bigint: true }).ino;
  } catch {
    return false;
  }
};

const fileId = (path: string) => {
  try {
    return statSync(path, { bigint: true }).ino.toString();
  } catch {
    return undefined;
  }
};

const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

type Loaded = { doc: Doc; assets: AssetTable; raw: Buffer; hash: string };

function loadArchive(path: string): Loaded {
  const entries = listZip(path);
  const projectEntry = entries.get("project.json");
  if (!projectEntry) throw new Error("archive has no project.json");
  const raw = readZipEntry(path, projectEntry);
  const metaEntry = entries.get("metadata.json");
  const meta = metaEntry ? JSON.parse(readZipEntry(path, metaEntry).toString("utf8")) : {};
  const assets: AssetTable = meta.assets ?? {};
  const doc = JSON.parse(raw.toString("utf8")) as Doc;
  const assetSig = Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, a.sha256 ?? a.byteLength ?? null]));
  return { doc, assets, raw, hash: hash(canonical(doc), assetSig) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function nowIso() {
  return new Date().toISOString();
}

export const sendable = (n: Note) => n.status === "draft" && (n.kind !== "note" || !!(n.text.trim() || n.tag || n.target || n.annotations.length));

const UNSEEN_WINDOW_MS = 7 * 24 * 3600_000;

export class Cut {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly dataDir: string;
  revisions: Revision[] = [];
  notes: Note[] = [];
  activity: Activity[] = [];
  agent?: { name: string; state: string; text: string; at: string };
  approvedRev?: number;
  seenRev?: number;
  collaborators: { thread: string; agent: string; at: string; link?: string }[] = [];
  pendingSelf?: { until: number; summary: string; size: number; mtimeMs: number };
  lastAgentTouch?: { name: string; at: number; summary?: string; addresses?: string[]; publishing?: boolean };
  readonly pinned = new Set<number>();
  private docs = new Map<number, { doc: Doc; assets: AssetTable }>();
  private analyses = new Map<number, Analysis>();
  private watcher?: FSWatcher;
  private ingestTimer?: ReturnType<typeof setTimeout>;
  private inflight?: Promise<Revision | undefined>;
  private ingestAgain = false;
  private inPlaceWriter = false;
  storage?: Storage;
  onRevision?: (cut: Cut, rev: Revision) => void;
  onSourceLost?: (cut: Cut, n: number) => void;
  onFold?: (cut: Cut, n: number) => void;

  constructor(path: string) {
    this.path = normPath(path);
    this.id = cutIdFor(this.path);
    this.name = basename(this.path, extname(this.path));
    this.folder = basename(dirname(this.path));
    this.dataDir = cutDataDir(this.path);
    mkdirSync(join(this.dataDir, "docs"), { recursive: true });
    mkdirSync(join(this.dataDir, "frames"), { recursive: true });
    const state = readJson<{ revisions: Revision[]; approvedRev?: number; seenRev?: number; agent?: Cut["agent"]; collaborators?: Cut["collaborators"]; storage?: Storage; inPlaceWriter?: boolean }>(join(this.dataDir, "revisions.json"), { revisions: [] });
    this.revisions = state.revisions ?? [];
    this.storage = state.storage;
    this.inPlaceWriter = !!state.inPlaceWriter;
    this.approvedRev = state.approvedRev;
    this.agent = state.agent;
    this.collaborators = state.collaborators ?? [];
    this.notes = readJson<{ notes: Note[] }>(join(this.dataDir, "notes.json"), { notes: [] }).notes ?? [];
    this.seenRev = state.seenRev ?? this.seenFromHistory();
    this.relocateFrom(legacyCutDataDir(this.path));
    this.activity = this.loadActivity();
    this.rekey();
    this.sweepSnapshotDir();
  }

  private relocateFrom(old: string) {
    let revisions = false;
    let notes = false;
    for (const r of this.revisions) {
      const snapshot = relocated(r.snapshot, old, this.dataDir);
      if (snapshot !== r.snapshot) (r.snapshot = snapshot), (revisions = true);
    }
    for (const n of this.notes) {
      const frame = relocated(n.frame, old, this.dataDir);
      const annotatedFrame = relocated(n.annotatedFrame, old, this.dataDir);
      if (frame !== n.frame || annotatedFrame !== n.annotatedFrame) (n.frame = frame), (n.annotatedFrame = annotatedFrame), (notes = true);
    }
    if (revisions) this.saveState();
    if (notes) this.saveNotes();
  }

  private snapshotFiles() {
    return new Set(this.revisions.map((r) => r.snapshot?.toLowerCase()).filter((x): x is string => !!x));
  }

  private loadActivity(): Activity[] {
    const file = join(this.dataDir, "activity.jsonl");
    if (!existsSync(file)) return [];
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const byId = new Map<string, Activity>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const a = JSON.parse(line) as Activity;
        if (a.author?.kind === "unknown" && a.author.name === "Dailies") a.author.name = "Slate";
        byId.set(a.id, a);
      } catch {}
    }
    const entries = [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const kept = entries.slice(-ACTIVITY_KEEP);
    if (text.length > ACTIVITY_COMPACT_BYTES || entries.length > ACTIVITY_KEEP * 3) {
      try {
        writeFileSync(`${file}.tmp`, kept.map((a) => JSON.stringify(a) + "\n").join(""));
        renameSync(`${file}.tmp`, file);
      } catch {}
    }
    return kept;
  }

  private rekey() {
    const sig = keySignature();
    let changed = false;
    for (const r of this.revisions) {
      if (r.keySig === sig || !this.renderSource(r.n)) continue;
      const a = this.analysisFor(r.n);
      if (!a) continue;
      r.vkeys = a.vkeys;
      r.akeys = a.akeys;
      r.keySig = sig;
      changed = true;
    }
    if (changed) this.saveState();
  }

  private seenFromHistory() {
    const latest = this.latest;
    if (!latest) return undefined;
    if (Date.now() - Date.parse(latest.at) > UNSEEN_WINDOW_MS) return latest.n;
    const yours = [this.approvedRev ?? 0, ...this.notes.filter((n) => n.author.kind === "you").map((n) => n.rev), ...this.revisions.filter((r) => r.author.kind === "you").map((r) => r.n)];
    return Math.max(...yours) || undefined;
  }

  markSeen(n: number) {
    if (!this.revision(n) || (this.seenRev ?? 0) >= n) return false;
    this.seenRev = n;
    this.saveState();
    return true;
  }

  get latest(): Revision | undefined {
    return this.revisions[this.revisions.length - 1];
  }

  revision(n?: number): Revision | undefined {
    if (n === undefined) return this.latest;
    return this.revisions.find((r) => r.n === n);
  }

  saveState() {
    writeJsonAtomic(join(this.dataDir, "revisions.json"), { cut: this.path, revisions: this.revisions, approvedRev: this.approvedRev, seenRev: this.seenRev, agent: this.agent, collaborators: this.collaborators, storage: this.storage, inPlaceWriter: this.inPlaceWriter || undefined });
  }

  saveNotes() {
    writeJsonAtomic(join(this.dataDir, "notes.json"), { cut: this.path, notes: this.notes });
  }

  addCollaborator(thread: string, agent: string, link?: string) {
    const prev = this.collaborators.find((c) => c.thread === thread);
    this.collaborators = [...this.collaborators.filter((c) => c.thread !== thread), { thread, agent, at: nowIso(), link: link ?? prev?.link }].slice(-4);
    this.saveState();
  }

  log(entry: Omit<Activity, "id" | "at"> & { at?: string }) {
    const a: Activity = { id: randomUUID().slice(0, 8), at: entry.at ?? nowIso(), ...entry } as Activity;
    this.activity.push(a);
    if (this.activity.length > 600) this.activity.splice(0, this.activity.length - 400);
    appendFileSync(join(this.dataDir, "activity.jsonl"), JSON.stringify(a) + "\n");
    emit({ type: "activity", cutId: this.id });
    return a;
  }

  docFor(n: number): { doc: Doc; assets: AssetTable } | undefined {
    const hit = this.docs.get(n);
    if (hit) return hit;
    const file = join(this.dataDir, "docs", `r${n}.json.gz`);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    const value = { doc: parsed.doc as Doc, assets: parsed.assets as AssetTable };
    this.docs.set(n, value);
    if (this.docs.size > 6) this.docs.delete(this.docs.keys().next().value!);
    return value;
  }

  rawDocFile(n: number) {
    return join(this.dataDir, "docs", `r${n}.project.json`);
  }

  analysisFor(n: number): Analysis | undefined {
    const hit = this.analyses.get(n);
    if (hit) return hit;
    const d = this.docFor(n);
    if (!d) return undefined;
    const a = analyze(d.doc, d.assets, RENDER_SETTINGS);
    this.analyses.set(n, a);
    if (this.analyses.size > 4) this.analyses.delete(this.analyses.keys().next().value!);
    return a;
  }

  startWatching() {
    if (this.watcher) return;
    const dir = dirname(this.path);
    const file = basename(this.path).toLowerCase();
    try {
      const watcher = watch(dir, { persistent: true }, (_evt, name) => {
        if (!name || String(name).toLowerCase() !== file) return;
        this.scheduleIngest(400);
      });
      watcher.on("error", (e) => {
        console.error(`[slate] stopped watching ${dir}: ${e}; polling instead`);
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch (e) {
      console.error(`[slate] cannot watch ${dir}: ${e}`);
    }
  }

  stopWatching() {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private polledStamp?: string;
  private retry?: { stamp: string; attempts: number; nextAt: number };

  pollForChanges() {
    if (this.inflight || !this.latest || !existsSync(this.path)) return;
    const s = statSync(this.path);
    const stamp = `${s.size}:${s.mtimeMs}`;
    const stale = s.size !== this.latest.fileSize || s.mtimeMs !== this.latest.mtimeMs;
    const unchangedSinceLastPoll = stamp === this.polledStamp;
    this.polledStamp = stamp;
    if (!stale || !unchangedSinceLastPoll) return;
    const now = Date.now();
    const attempts = this.retry?.stamp === stamp ? this.retry.attempts : 0;
    if (attempts && now < this.retry!.nextAt) return;
    this.retry = { stamp, attempts: attempts + 1, nextAt: now + Math.min(300_000, 10_000 * 2 ** attempts) };
    console.log(`[slate] ${this.name} on disk is newer than r${this.latest.n} and was not ingested; ingesting (attempt ${attempts + 1})`);
    this.scheduleIngest(0);
  }

  scheduleIngest(delay = 0) {
    clearTimeout(this.ingestTimer);
    this.ingestTimer = setTimeout(() => void this.ingestQuietly(), delay);
  }

  ingest(): Promise<Revision | undefined> {
    if (this.inflight) {
      this.ingestAgain = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      let made: Revision | undefined;
      try {
        do {
          this.ingestAgain = false;
          made = (await this.ingestOnce()) ?? made;
        } while (this.ingestAgain);
        return made;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  ingestQuietly(): Promise<Revision | undefined> {
    return this.ingest().catch((e) => {
      console.error(`[slate] could not ingest ${this.name}: ${e instanceof Error ? e.message : e}`);
      emit({ type: "cut", cutId: this.id });
      return undefined;
    });
  }

  private stamp() {
    try {
      const s = statSync(this.path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private async waitStable(): Promise<{ stat?: { size: number; mtimeMs: number }; stable: boolean }> {
    const started = Date.now();
    let prev: { size: number; mtimeMs: number } | undefined;
    let missingSince: number | undefined;
    let announced = false;
    while (Date.now() - started < STABLE_WAIT_MS) {
      const cur = this.stamp();
      if (!cur) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince > 12_000) return { stable: false };
        await sleep(300);
        continue;
      }
      missingSince = undefined;
      if (prev && prev.size === cur.size && prev.mtimeMs === cur.mtimeMs) return { stat: cur, stable: true };
      if (prev && !announced && Date.now() - started > 10_000) {
        announced = true;
        console.log(`[slate] ${this.name} is still being written (${gb(cur.size)} so far); waiting for it to settle`);
      }
      prev = cur;
      await sleep(250);
    }
    return { stat: prev, stable: false };
  }

  private async ingestOnce(): Promise<Revision | undefined> {
    const { stat, stable } = await this.waitStable();
    if (!stat) {
      emit({ type: "cut", cutId: this.id });
      return;
    }
    if (!stable) console.error(`[slate] ${this.name} kept changing for ${STABLE_WAIT_MS / 1000} s; reading it anyway`);
    const movedSince = () => {
      const now = this.stamp();
      return { gone: !now, moved: !now || now.mtimeMs !== stat.mtimeMs || now.size !== stat.size };
    };
    let loaded: Loaded | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        loaded = loadArchive(this.path);
        break;
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
    const read = movedSince();
    if (!loaded) {
      if (read.moved && !read.gone) {
        this.ingestAgain = true;
        return;
      }
      console.error(`[slate] cannot read ${this.path}: ${lastErr}`);
      return;
    }
    if (read.moved) {
      this.ingestAgain = true;
      return;
    }
    const prev = this.latest;
    if (prev && prev.hash === loaded.hash) {
      const id = fileId(this.path);
      if (prev.mtimeMs !== stat.mtimeMs || prev.fileId !== id) {
        prev.mtimeMs = stat.mtimeMs;
        prev.fileSize = stat.size;
        prev.fileId = id;
        this.saveState();
      }
      return;
    }
    const prevSnapshot = prev?.snapshot;
    const inPlace = !!prevSnapshot && sameFile(prevSnapshot, this.path);
    const id = fileId(this.path);
    if (this.inPlaceWriter && !inPlace && id && prev?.fileId && prev.fileId !== id) {
      this.inPlaceWriter = false;
      console.log(`[slate] ${this.name} is saved by replacing the file again; snapshots are hardlinks again`);
    }
    const incoming = await this.freeze(stat, inPlace || this.inPlaceWriter);
    const torn = !!incoming && (fileId(this.path) !== id || fileSize(incoming) !== stat.size);
    if (torn || movedSince().moved) {
      if (incoming) rmSync(incoming, { force: true });
      this.ingestAgain = true;
      return;
    }
    if (inPlace && prev?.snapshot) {
      try {
        rmSync(prev.snapshot, { force: true });
      } catch {}
      prev.snapshot = undefined;
      this.inPlaceWriter = true;
      console.error(`[slate] ${this.name} was rewritten in place; r${prev.n} can no longer be restored and future snapshots are copies`);
      this.onSourceLost?.(this, prev.n);
    }
    const author = this.attribute(stat);
    const folding = !!prev && (!prev.snapshot || !!incoming) && this.foldable(prev, author.author);
    const base = folding ? this.revisions[this.revisions.length - 2] : prev;
    const n = folding ? prev!.n : (prev?.n ?? 0) + 1;
    let snapshot: string | undefined;
    if (incoming) {
      const target = join(this.snapshotDir, `r${n}.tsrct`);
      snapshot = existsSync(target) ? join(this.snapshotDir, `r${n}-${Date.now()}.tsrct`) : target;
      renameSync(incoming, snapshot);
    }
    writeFileSync(join(this.dataDir, "docs", `r${n}.json.gz`), gzipSync(JSON.stringify({ doc: loaded.doc, assets: loaded.assets })));
    writeFileSync(this.rawDocFile(n), loaded.raw);
    this.docs.set(n, { doc: loaded.doc, assets: loaded.assets });
    const analysis = analyze(loaded.doc, loaded.assets, RENDER_SETTINGS);
    this.analyses.set(n, analysis);
    const baseAnalysis = base ? this.analysisFor(base.n) : undefined;
    const changedSegments: number[] = [];
    for (let s = 0; s < analysis.segments; s++) {
      if (!baseAnalysis || baseAnalysis.vkeys[s] !== analysis.vkeys[s] || baseAnalysis.akeys[s] !== analysis.akeys[s]) changedSegments.push(s);
    }
    const known = author.author.kind !== "unknown" || !folding ? author : { author: prev!.author, summary: prev!.summary, addresses: prev!.addresses, published: author.published };
    const rev: Revision = {
      n,
      hash: loaded.hash,
      at: nowIso(),
      author: known.author,
      summary: known.summary,
      addresses: known.addresses,
      changes: base ? diffDocs(this.docFor(base.n)?.doc, loaded.doc) : [],
      changedSegments,
      durationMs: analysis.durationMs,
      width: loaded.doc.dimensions?.width ?? 1920,
      height: loaded.doc.dimensions?.height ?? 1080,
      vkeys: analysis.vkeys,
      akeys: analysis.akeys,
      keySig: keySignature(),
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: id,
      snapshot,
      published: known.published || undefined,
      saves: folding ? (prev!.saves ?? 1) + 1 : undefined,
      firstAt: folding ? (prev!.firstAt ?? prev!.at) : undefined,
    };
    if (folding) {
      this.revisions[this.revisions.length - 1] = rev;
      this.onFold?.(this, n);
      for (const note of this.notes) if (note.overwrittenIn === n) {
        note.overwrittenIn = undefined;
        (note as { conflict?: string }).conflict = undefined;
      }
    } else this.revisions.push(rev);
    this.saveState();
    this.pruneSnapshots();
    this.checkOverwrites(rev, loaded.doc);
    this.markAddressed(rev, known.addresses);
    this.saveState();
    const text = rev.summary ?? describeChanges(rev);
    if (folding) this.relog(n, { author: rev.author, text });
    else this.log({ author: rev.author, kind: "revision", rev: n, text });
    emit({ type: "revision", cutId: this.id, n });
    emit({ type: "cuts" });
    this.onRevision?.(this, rev);
    return rev;
  }

  private foldable(prev: Revision, next: Author) {
    if (prev.published || prev.author.kind === "you" || next.kind === "you") return false;
    if (prev.author.kind === "agent" && next.kind === "agent" && prev.author.name !== next.name) return false;
    const now = Date.now();
    if (now - Date.parse(prev.at) > FOLD_MS || now - Date.parse(prev.firstAt ?? prev.at) > FOLD_SPAN_MS) return false;
    if (prev.n === this.approvedRev || this.pinned.has(prev.n)) return false;
    return !this.notes.some((x) => x.rev === prev.n || x.thread.some((t) => t.rev === prev.n));
  }


  private relog(n: number, update: { author: Author; text: string }) {
    const at = nowIso();
    const entry = [...this.activity].reverse().find((a) => a.kind === "revision" && a.rev === n);
    if (!entry) {
      this.log({ ...update, kind: "revision", rev: n });
      return;
    }
    Object.assign(entry, update, { at });
    this.activity.splice(this.activity.indexOf(entry), 1);
    this.activity.push(entry);
    try {
      appendFileSync(join(this.dataDir, "activity.jsonl"), JSON.stringify(entry) + "\n");
    } catch {}
    emit({ type: "activity", cutId: this.id });
  }

  private markAddressed(rev: Revision, ids?: string[]) {
    if (!ids?.length) return;
    let changed = false;
    for (const id of ids) {
      const note = this.notes.find((x) => x.id === id);
      if (!note || (note.status !== "open" && note.status !== "claimed")) continue;
      note.status = "addressed";
      note.updatedAt = nowIso();
      note.thread.push({ id: randomUUID().slice(0, 8), author: rev.author, text: `Addressed in r${rev.n}.`, at: nowIso(), rev: rev.n, status: "addressed" });
      changed = true;
    }
    if (changed) {
      this.saveNotes();
      emit({ type: "notes", cutId: this.id });
    }
  }

  async publishFromAgent(name: string, summary?: string, addresses?: string[]): Promise<{ rev?: Revision; reason?: string }> {
    this.lastAgentTouch = { name, at: Date.now(), summary, addresses, publishing: true };
    let made: Revision | undefined;
    try {
      made = await this.ingest();
    } finally {
      const touch = this.lastAgentTouch;
      if (touch?.publishing) this.lastAgentTouch = { name, at: touch.at };
    }
    if (made?.published && made.author.kind === "agent" && made.author.name === name) return { rev: made };
    let r: Revision | undefined;
    let reason = "there is no revision yet";
    for (const x of [...this.revisions].reverse()) {
      if (x.author.kind === "you") {
        reason = `r${x.n} is ${owner("the user")}'s own edit and nothing of yours is unpublished before it`;
        continue;
      }
      if (x.published) {
        reason = `r${x.n} is already published`;
        break;
      }
      if (x.author.kind === "agent" && x.author.name === name) r = x;
      else if (x.author.kind === "unknown" && Date.now() - Date.parse(x.at) < ATTRIBUTION_MS) r = x;
      else reason = x.author.kind === "agent" ? `r${x.n} belongs to ${x.author.name} and is not published yet` : `r${x.n} is unattributed and older than 5 minutes`;
      break;
    }
    if (!r) return { reason };
    r.author = { kind: "agent", name };
    if (summary) r.summary = summary;
    r.addresses = addresses;
    r.published = true;
    this.markAddressed(r, addresses);
    this.saveState();
    this.log({ author: r.author, kind: "publish", rev: r.n, text: `Published r${r.n}${summary ? `: ${summary}` : ""}` });
    emit({ type: "revision", cutId: this.id, n: r.n });
    emit({ type: "cuts" });
    return { rev: r };
  }

  private attribute(stat: { size: number; mtimeMs: number }): { author: Author; summary?: string; addresses?: string[]; published?: boolean } {
    const now = Date.now();
    const self = this.pendingSelf;
    this.pendingSelf = undefined;
    if (self && self.until > now && self.size === stat.size && self.mtimeMs === stat.mtimeMs) {
      return { author: { kind: "you", name: "You" }, summary: self.summary, published: true };
    }
    const touch = this.lastAgentTouch;
    if (touch && now - touch.at < ATTRIBUTION_MS) {
      const out = { author: { kind: "agent" as const, name: touch.name }, summary: touch.summary, addresses: touch.addresses, published: touch.publishing };
      this.lastAgentTouch = { name: touch.name, at: touch.at };
      return out;
    }
    return { author: { kind: "unknown", name: "Unattributed" } };
  }

  get snapshotDir() {
    return join(this.dataDir, "snapshots");
  }

  private setStorage(next: Storage) {
    const changed = this.storage?.mode !== next.mode || this.storage?.reason !== next.reason;
    this.storage = next;
    if (changed && next.reason) console.error(`[slate] ${this.name}: ${next.reason}`);
  }

  private async freeze(stat: { size: number }, copy: boolean): Promise<string | undefined> {
    mkdirSync(this.snapshotDir, { recursive: true });
    const target = join(this.snapshotDir, `incoming-${process.pid}.tsrct`);
    rmSync(target, { force: true });
    let linkError: unknown;
    if (!copy) {
      try {
        linkSync(this.path, target);
        this.setStorage({ mode: "linked" });
        return target;
      } catch (e) {
        linkError = e;
      }
    }
    const why = copy ? "This cut is saved in place, so Slate has to copy each save" : `This drive can't hardlink the cut (${linkError instanceof Error ? linkError.message : linkError}), so Slate has to copy each save`;
    if (stat.size > COPY_LIMIT) {
      this.setStorage({ mode: "none", reason: `${why}, and at ${gb(stat.size)} it is over the ${gb(COPY_LIMIT)} copy limit. Slate can't keep restore points for it, and saving during a render restarts that render.` });
      return undefined;
    }
    try {
      const started = Date.now();
      await copyFile(this.path, target);
      if (Date.now() - started > 2000) console.log(`[slate] copied ${gb(stat.size)} of ${this.name} for its snapshot in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      this.setStorage({ mode: "copied" });
      return target;
    } catch (e) {
      rmSync(target, { force: true });
      this.setStorage({ mode: "none", reason: `${why}, and the copy failed (${e instanceof Error ? e.message : e}). Slate can't keep restore points for it right now.` });
      return undefined;
    }
  }

  private sealed(path: string, r: Revision) {
    const before = stampOf(path);
    if (!sameFile(path, this.path)) return { stamp: before, fresh: before !== "gone" };
    let matches = false;
    try {
      const s = statSync(path);
      matches = s.size === r.fileSize && s.mtimeMs === r.mtimeMs;
    } catch {}
    return { stamp: before, fresh: matches && stampOf(path) === before };
  }

  leaseSource(n: number): SourceLease | undefined {
    const r = this.revision(n);
    const source = this.renderSource(n);
    if (!r || !source) return undefined;
    const lease = join(this.snapshotDir, `lease-${process.pid}-${randomUUID().slice(0, 8)}.tsrct`);
    try {
      mkdirSync(this.snapshotDir, { recursive: true });
      linkSync(source.path, lease);
    } catch {
      return { ...source, ...this.sealed(source.path, r), leased: false, release: () => {} };
    }
    const key = lease.toLowerCase();
    activeLeases.add(key);
    let released = false;
    return {
      path: lease,
      live: source.live,
      leased: true,
      ...this.sealed(lease, r),
      release: () => {
        if (released) return;
        released = true;
        try {
          rmSync(lease, { force: true });
        } catch {
        } finally {
          activeLeases.delete(key);
        }
      },
    };
  }

  private sweepSnapshotDir(referenced?: Set<string>) {
    let files: string[] = [];
    try {
      files = readdirSync(this.snapshotDir);
    } catch {}
    const orphaned = (f: string, key: string) => {
      const owned = /^(lease|incoming)-(\d+)[-.]/i.exec(f);
      if (!owned) return !!referenced && /^r\d+(-\d+)?\.tsrct$/i.test(f) && !referenced.has(key);
      const pid = Number(owned[2]);
      if (pid !== process.pid) return !pidAlive(pid);
      return owned[1].toLowerCase() === "lease" && !activeLeases.has(key);
    };
    for (const f of files) {
      const p = join(this.snapshotDir, f);
      if (!orphaned(f, p.toLowerCase())) continue;
      try {
        rmSync(p, { force: true });
      } catch {}
    }
  }

  snapshotBytes() {
    let bytes = 0;
    for (const r of this.revisions) if (r.snapshot && existsSync(r.snapshot) && !sameFile(r.snapshot, this.path)) bytes += r.fileSize;
    return bytes;
  }

  private pruneSnapshots() {
    const has = (r?: Revision): r is Revision => !!r?.snapshot && existsSync(r.snapshot);
    const cost = (r: Revision) => (sameFile(r.snapshot!, this.path) ? 0 : r.fileSize);
    const keep = new Set<number>();
    let bytes = 0;
    const hold = (r: Revision) => {
      if (keep.has(r.n)) return;
      keep.add(r.n);
      bytes += cost(r);
    };
    const latest = this.latest;
    if (has(latest)) hold(latest);
    for (const r of this.revisions) if ((r.n === this.approvedRev || this.pinned.has(r.n)) && has(r)) hold(r);
    for (const r of [...this.revisions].reverse()) {
      if (keep.has(r.n) || !has(r)) continue;
      const size = cost(r);
      if (keep.size >= SNAPSHOT_KEEP || (keep.size >= SNAPSHOT_MIN && bytes + size > SNAPSHOT_BUDGET)) break;
      hold(r);
    }
    this.sweepSnapshotDir(this.snapshotFiles());
    for (const r of this.revisions) {
      if (!keep.has(r.n) && r.snapshot) {
        try {
          rmSync(r.snapshot, { force: true });
          r.snapshot = undefined;
        } catch {}
      }
    }
  }

  renderSource(n: number): { path: string; live: boolean } | undefined {
    const r = this.revision(n);
    if (!r) return undefined;
    if (r.snapshot && existsSync(r.snapshot)) return { path: r.snapshot, live: false };
    if (r.n === this.latest?.n && existsSync(this.path)) return { path: this.path, live: true };
    return undefined;
  }

  liveMatches(n: number) {
    const r = this.revision(n);
    if (!r || !existsSync(this.path)) return false;
    const s = statSync(this.path);
    return s.mtimeMs === r.mtimeMs && s.size === r.fileSize;
  }

  private checkOverwrites(rev: Revision, doc: Doc) {
    if (rev.author.kind === "you") return;
    let changed = false;
    for (const note of this.notes as (Note & { expect?: { layerId: number; path: string[]; before: unknown; after: unknown }[]; applied?: boolean; conflict?: string })[]) {
      if (note.kind !== "edit" || note.applied === false || note.overwrittenIn || note.status === "resolved" || note.status === "wontfix" || !Array.isArray(note.expect)) continue;
      for (const exp of note.expect) {
        const layer = findLayer(doc, exp.layerId);
        const norm = (v: unknown) => (exp.path[0] === "hidden" ? v === true || undefined : v);
        const value = norm(editedValue(layer, exp.path));
        const reverted = canonical(value) === canonical(norm(exp.before));
        const diverged = exp.after !== "__any__" && canonical(value) !== canonical(norm(exp.after));
        if (!layer || reverted || diverged) {
          note.overwrittenIn = rev.n;
          note.conflict = !layer ? "layer removed" : reverted ? "reverted" : "changed";
          note.updatedAt = nowIso();
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.saveNotes();
      emit({ type: "notes", cutId: this.id });
    }
  }

  summary(render: CutSummary["render"], poster?: string): CutSummary {
    const l = this.latest;
    return {
      id: this.id,
      path: this.path,
      name: this.name,
      folder: this.folder,
      latest: l ? { n: l.n, hash: l.hash.slice(0, 10), at: l.at, author: l.author, durationMs: l.durationMs, width: l.width, height: l.height, summary: l.summary ?? describeChanges(l), changed: l.changedSegments, segments: l.vkeys.length } : undefined,
      recent: this.revisions.slice(-6).map((r) => ({ n: r.n, at: r.at, author: r.author })),
      openNotes: this.notes.filter((n) => n.status === "open" || n.status === "claimed").length,
      draftNotes: this.notes.filter(sendable).length,
      agent: this.agent,
      approvedRev: this.approvedRev,
      seenRev: this.seenRev,
      render,
      poster,
      missing: !existsSync(this.path),
    };
  }
}

export function describeChanges(rev: Revision) {
  if (rev.n === 1) return `First revision, ${(rev.durationMs / 1000).toFixed(1)} s at ${rev.width}x${rev.height}`;
  if (!rev.changes.length) return rev.changedSegments.length ? "Project settings or media changed" : "No visible changes";
  const parts = rev.changes.slice(0, 3).map((c) => {
    if (c.kind === "added") return `added ${c.name}`;
    if (c.kind === "removed") return `removed ${c.name}`;
    return `${c.name}: ${c.fields.join(", ")}${c.detail ? ` (${c.detail})` : ""}`;
  });
  const more = rev.changes.length > 3 ? `, +${rev.changes.length - 3} more` : "";
  return parts.join("; ") + more;
}

export class Registry {
  cuts = new Map<string, Cut>();
  roots: string[];
  onRevision?: (cut: Cut, rev: Revision) => void;
  onSourceLost?: (cut: Cut, n: number) => void;
  onFold?: (cut: Cut, n: number) => void;

  constructor() {
    const saved = readJson<{ cuts: string[]; roots?: string[] }>(REGISTRY_FILE, { cuts: [] });
    this.roots = saved.roots ?? [join(process.env.USERPROFILE ?? "", "Documents", "Tesseract")];
    for (const p of saved.cuts) {
      if (existsSync(p)) this.add(p, false);
    }
  }

  save() {
    writeJsonAtomic(REGISTRY_FILE, { cuts: [...this.cuts.values()].map((c) => c.path), roots: this.roots });
  }

  add(path: string, persist = true): Cut {
    const id = cutIdFor(path);
    let cut = this.cuts.get(id);
    if (cut) return cut;
    cut = new Cut(path);
    cut.onRevision = (c, r) => this.onRevision?.(c, r);
    cut.onSourceLost = (c, n) => this.onSourceLost?.(c, n);
    cut.onFold = (c, n) => this.onFold?.(c, n);
    this.cuts.set(id, cut);
    cut.startWatching();
    cut.scheduleIngest(0);
    if (persist) {
      this.save();
      emit({ type: "cuts" });
    }
    return cut;
  }

  remove(id: string) {
    const cut = this.cuts.get(id);
    if (!cut) return;
    cut.stopWatching();
    this.cuts.delete(id);
    this.save();
    emit({ type: "cuts" });
  }

  get(idOrPath: string): Cut | undefined {
    return this.cuts.get(idOrPath) ?? this.cuts.get(cutIdFor(idOrPath));
  }

  setRoots(roots: string[]) {
    const seen = new Set<string>();
    this.roots = roots.map(normPath).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
    this.save();
    emit({ type: "library" });
  }

  scanLibrary(): { path: string; folder: string; name: string; mtimeMs: number; size: number; registered: boolean }[] {
    const out: { path: string; folder: string; name: string; mtimeMs: number; size: number; registered: boolean }[] = [];
    const skip = (d: string) => d.startsWith(".") || /^(versions|final|previews|sources|captures|brainstorm|node_modules)$/i.test(d);
    const visit = (dir: string, depth: number) => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2 && !skip(e.name)) visit(p, depth + 1);
        } else if (e.name.toLowerCase().endsWith(".tsrct")) {
          try {
            const s = statSync(p);
            out.push({ path: normPath(p), folder: basename(dir), name: basename(e.name, ".tsrct"), mtimeMs: s.mtimeMs, size: s.size, registered: this.cuts.has(cutIdFor(p)) });
          } catch {}
        }
      }
    };
    for (const root of this.roots) visit(root, 0);
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}
