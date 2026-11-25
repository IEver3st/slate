import { existsSync, writeFileSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { absoluteWindow, canonical, contextAt, editedValue, findLayer, isLayerHidden, layerWindow, walk, type Doc, type Layer } from "./doc";
import { applyActions, findCli } from "./tsrct";
import { emit } from "./events";
import { MEDIA_GUIDE, relocate, type MediaRef } from "./medialib";
import { owner } from "./settings";
import { nowIso, describeChanges, sendable, type Cut } from "./cuts";
import { NOTE_TAGS, type Annotation, type Author, type CutMessage, type Note, type NoteStatus, type NoteTag, type NoteTarget, type Revision, type Suggestion } from "./types";

export const YOU: Author = { kind: "you", name: "You" };

export type EditRequest =
  | { kind: "text"; layerId: number; text: string }
  | { kind: "volume"; layerId: number; db: number }
  | { kind: "hide"; layerId: number; hidden: boolean }
  | { kind: "timing"; layerId: number; start: number; end: number };

type Expect = { layerId: number; path: string[]; before: unknown; after: unknown };

const shortId = () => randomUUID().replace(/-/g, "").slice(0, 10);

export function anchorFor(doc: Doc, t: number) {
  let best: { layer: Layer; start: number; end: number } | undefined;
  for (const layer of doc.composition.layers) {
    if (layer.type === "Audio") continue;
    const w = layerWindow(layer);
    if (!Number.isFinite(w.start) || !(t >= w.start && t < w.end)) continue;
    if (!best || w.end - w.start < best.end - best.start) best = { layer, start: w.start, end: w.end };
  }
  return best ? { layerId: best.layer.id, name: best.layer.name ?? String(best.layer.id), offset: Math.round(t - best.start) } : undefined;
}

export function displayTime(note: Note & { anchor?: { layerId: number; offset: number } }, doc: Doc | undefined): { t: number; moved: boolean; gone: boolean } {
  if (!note.anchor || !doc) return { t: note.t, moved: false, gone: false };
  if (!findLayer(doc, note.anchor.layerId)) return { t: note.t, moved: false, gone: true };
  const w = absoluteWindow(doc, note.anchor.layerId);
  if (!w || !Number.isFinite(w.start)) return { t: note.t, moved: false, gone: false };
  const t = Math.min(w.end - 1, w.start + note.anchor.offset);
  return { t, moved: Math.abs(t - note.t) > 20, gone: false };
}

function targetAnchor(doc: Doc, target: NoteTarget, t: number) {
  const w = absoluteWindow(doc, target.layerId);
  if (!w || !Number.isFinite(w.start)) return undefined;
  return { layerId: target.layerId, name: target.name, offset: Math.round(t - w.start) };
}

export const TAG_TEXT: Record<NoteTag, string> = {
  timing: "Timing is off here.",
  text: "Fix this text.",
  audio: "Fix the sound here.",
  framing: "Fix the framing.",
  remove: "Cut this.",
};


const cleanTag = (v: unknown) => (NOTE_TAGS.includes(v as NoteTag) ? (v as NoteTag) : undefined);
const cleanTarget = (v: any): NoteTarget | undefined => {
  if (!v || typeof v.layerId !== "number") return undefined;
  const b = v.box;
  const box = b && [b.x, b.y, b.w, b.h].every((x) => typeof x === "number" && x >= -0.01 && x <= 1.01) ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined;
  return { layerId: v.layerId, name: String(v.name ?? v.layerId), box };
};

export function createNote(cut: Cut, input: {
  rev?: number;
  t: number;
  end?: number;
  text: string;
  annotations?: Annotation[];
  status?: NoteStatus;
  author?: Author;
  frame?: Buffer;
  annotatedFrame?: Buffer;
  suggestion?: Suggestion;
  tag?: unknown;
  target?: unknown;
  against?: unknown;
  media?: MediaRef[];
}): Note {
  const rev = cut.revision(input.rev) ?? cut.latest;
  if (!rev) throw new Error("this cut has no revision yet");
  const doc = cut.docFor(rev.n)?.doc;
  const id = shortId();
  const target = cleanTarget(input.target);
  const against = Number(input.against);
  const note: Note & { anchor?: ReturnType<typeof anchorFor> } = {
    id,
    kind: "note",
    rev: rev.n,
    t: Math.max(0, Math.min(rev.durationMs, Math.round(input.t))),
    end: input.end !== undefined ? Math.round(input.end) : undefined,
    author: input.author ?? YOU,
    text: input.text.trim(),
    status: input.status ?? "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    annotations: input.annotations ?? [],
    context: doc ? contextAt(doc, input.t) : [],
    suggestion: input.suggestion,
    tag: cleanTag(input.tag),
    target,
    against: Number.isInteger(against) && against !== rev.n && cut.revision(against) ? against : undefined,
    media: input.media?.length ? input.media : undefined,
    thread: [],
    anchor: doc ? (target && targetAnchor(doc, target, input.t)) || anchorFor(doc, input.t) : undefined,
  };
  if (input.frame) {
    note.frame = join(cut.dataDir, "frames", `${id}.png`);
    writeFileSync(note.frame, input.frame);
  }
  if (input.annotatedFrame) {
    note.annotatedFrame = join(cut.dataDir, "frames", `${id}-marked.png`);
    writeFileSync(note.annotatedFrame, input.annotatedFrame);
  }
  if (note.status === "open") note.publishedAt = nowIso();
  if (note.status === "open" && note.author.kind === "you") note.humanAt = nowIso();
  cut.notes.push(note);
  cut.saveNotes();
  emit({ type: "notes", cutId: cut.id, noteId: id });
  return note;
}

export function updateNote(cut: Cut, id: string, patch: Partial<Pick<Note, "text" | "status" | "annotations" | "t" | "end">> & { tag?: unknown; target?: unknown; annotatedFrame?: Buffer | null }, by: Author = YOU) {
  const note = cut.notes.find((n) => n.id === id) as (Note & { anchor?: ReturnType<typeof anchorFor> }) | undefined;
  if (!note) throw new Error(`no note ${id}`);
  if (patch.text !== undefined) note.text = String(patch.text);
  if (patch.annotations !== undefined) note.annotations = patch.annotations;
  if (patch.t !== undefined) note.t = patch.t;
  if (patch.end !== undefined) note.end = patch.end === null ? undefined : patch.end;
  if (patch.tag !== undefined) note.tag = cleanTag(patch.tag);
  if (patch.target !== undefined) {
    note.target = cleanTarget(patch.target);
    const doc = cut.docFor(note.rev)?.doc;
    if (doc) note.anchor = (note.target && targetAnchor(doc, note.target, note.t)) || anchorFor(doc, note.t);
  }
  if (patch.annotatedFrame !== undefined) {
    if (note.annotatedFrame) rmSync(note.annotatedFrame, { force: true });
    note.annotatedFrame = undefined;
    if (patch.annotatedFrame) {
      note.annotatedFrame = join(cut.dataDir, "frames", `${id}-marked.png`);
      writeFileSync(note.annotatedFrame, patch.annotatedFrame);
    }
  }
  if (by.kind === "you" && note.publishedAt && (patch.text !== undefined || patch.annotations !== undefined || patch.status)) note.humanAt = nowIso();
  if (patch.status && patch.status !== note.status) {
    note.status = patch.status;
    if (patch.status === "open" && !note.publishedAt) note.publishedAt = nowIso();
    if (by.kind === "you" && (patch.status === "resolved" || patch.status === "open") && note.publishedAt) {
      note.thread.push({ id: shortId(), author: by, text: patch.status === "resolved" ? "Resolved." : "Reopened.", at: nowIso(), status: patch.status });
      cut.log({ author: by, kind: "reply", noteId: id, text: `${patch.status === "resolved" ? "Resolved" : "Reopened"}: ${clip(note.text)}` });
    }
  }
  note.updatedAt = nowIso();
  cut.saveNotes();
  emit({ type: "notes", cutId: cut.id, noteId: id });
  return note;
}

export function deleteNote(cut: Cut, id: string) {
  const i = cut.notes.findIndex((n) => n.id === id);
  if (i < 0) return;
  const [note] = cut.notes.splice(i, 1);
  for (const f of [note.frame, note.annotatedFrame]) if (f) rmSync(f, { force: true });
  cut.saveNotes();
  emit({ type: "notes", cutId: cut.id });
}

export function reply(cut: Cut, id: string, text: string, author: Author, status?: NoteStatus, rev?: number) {
  const note = cut.notes.find((n) => n.id === id);
  if (!note) throw new Error(`no note ${id}`);
  if (text.trim()) note.thread.push({ id: shortId(), author, text: text.trim(), at: nowIso(), rev, status });
  if (status) note.status = status;
  note.updatedAt = nowIso();
  if (author.kind === "you") note.humanAt = note.updatedAt;
  cut.saveNotes();
  cut.log({ author, kind: "reply", noteId: id, rev, text: `${status ? `${labelStatus(status)}: ` : ""}${clip(text || note.text)}` });
  emit({ type: "notes", cutId: cut.id, noteId: id });
  return note;
}

function labelStatus(s: NoteStatus) {
  return { draft: "Draft", open: "Open", claimed: "Working on it", addressed: "Addressed", resolved: "Resolved", wontfix: "Won't fix" }[s];
}

export function clip(text: string, n = 90) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function digestNotes(notes: Note[], doc: Doc | undefined) {
  const lines = notes.slice(0, 8).map((n) => {
    const d = displayTime(n as any, doc);
    const body = clip(n.text || (n.tag ? TAG_TEXT[n.tag] : "See frame"), 100);
    const extras = [
      n.tag ? `[${n.tag}]` : "",
      n.target ? `on "${n.target.name}"` : "",
      n.annotations.length ? "+drawing" : "",
      n.media?.length ? `+${n.media.length} media` : "",
    ].filter(Boolean).join(" ");
    return `- [${n.id}] @${fmtTime(d.t)}${extras ? ` ${extras}` : ""}: ${body}`;
  });
  if (notes.length > 8) lines.push(`- ...and ${notes.length - 8} more`);
  return lines.join("\n");
}

export async function publish(cut: Cut) {
  const drafts = cut.notes.filter(sendable);
  const leftBehind = cut.notes.filter((n) => n.status === "draft").length - drafts.length;
  if (!drafts.length) return { published: 0, leftBehind, delivered: [] as string[] };
  for (const n of drafts) {
    n.status = "open";
    n.publishedAt = nowIso();
    n.updatedAt = nowIso();
    n.humanAt = n.updatedAt;
  }
  cut.saveNotes();
  cut.log({ author: YOU, kind: "publish", rev: cut.latest?.n, text: `Sent ${drafts.length} note${drafts.length === 1 ? "" : "s"} on r${cut.latest?.n ?? "?"}` });
  emit({ type: "notes", cutId: cut.id });
  const doc = cut.latest ? cut.docFor(cut.latest.n)?.doc : undefined;
  const summary = digestNotes(drafts, doc);
  const delivered = await deliver(
    cut,
    `${owner()} left ${drafts.length} new note${drafts.length === 1 ? "" : "s"} on "${cut.name}" (r${cut.latest?.n}) in Slate:\n${summary}\n`,
  );
  return { published: drafts.length, leftBehind, delivered };
}

export async function sendMessage(cut: Cut, text: string, author: Author = YOU) {
  const clean = text.trim();
  if (!clean) throw new Error("message cannot be empty");
  const wasBlocked = cut.agent?.state === "blocked";
  const msg: CutMessage = { id: shortId(), author, text: clean, at: nowIso(), rev: cut.latest?.n, replyToBlocked: wasBlocked || undefined };
  cut.messages.push(msg);
  if (cut.messages.length > 100) cut.messages.splice(0, cut.messages.length - 100);
  if (author.kind === "you" && wasBlocked && cut.agent) {
    cut.agent = { ...cut.agent, state: "working", text: `Answered: ${clip(clean, 80)}`, at: msg.at };
  }
  cut.saveState();
  cut.log({ author, kind: "message", rev: cut.latest?.n, text: clip(clean, 140) });
  emit({ type: "cut", cutId: cut.id });
  emit({ type: "cuts" });
  const delivered = author.kind === "you"
    ? await deliver(
        cut,
        wasBlocked
          ? `${owner()} answered your question on "${cut.name}" (r${cut.latest?.n}) in Slate: "${clip(clean, 300)}".`
          : `${owner()} sent a note on "${cut.name}" (r${cut.latest?.n}) in Slate: "${clip(clean, 300)}".`,
      )
    : [];
  return { message: msg, delivered, unblocked: wasBlocked };
}

export async function notifyReply(cut: Cut, note: Note, text: string, status?: NoteStatus) {
  if (note.status === "draft") return [];
  const doc = cut.latest ? cut.docFor(cut.latest.n)?.doc : undefined;
  const d = displayTime(note as any, doc);
  const verb = status === "open" ? "reopened" : "replied to";
  const body = text.trim() ? `: "${clip(text, 220)}"` : "";
  return deliver(cut, `${owner()} ${verb} note [${note.id}] @${fmtTime(d.t)} on "${cut.name}" (r${cut.latest?.n})${body}.`);
}

export async function deliverReopened(cut: Cut, noteIds: string[]) {
  const list = noteIds.map((id) => cut.notes.find((n) => n.id === id)).filter((n): n is Note => !!n);
  if (!list.length) return [];
  const doc = cut.latest ? cut.docFor(cut.latest.n)?.doc : undefined;
  const lines = list.slice(0, 8).map((n) => {
    const d = displayTime(n as any, doc);
    const last = [...n.thread].reverse().find((t) => t.author.kind === "you")?.text;
    return `- [${n.id}] @${fmtTime(d.t)}: ${clip(last || n.text, 100)}`;
  });
  return deliver(cut, `${owner()} checked fixes on "${cut.name}" (r${cut.latest?.n}) and reopened ${list.length} note${list.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n`);
}

export function batchNotes(cut: Cut, action: "resolveAddressed" | "resolve" | "reopen" | "restore" | "delete", ids?: string[], statuses?: Record<string, NoteStatus>) {
  const targetIds = new Set(ids ?? []);
  const previous: Record<string, NoteStatus> = {};
  const changed: string[] = [];
  if (action === "delete") {
    const kept: Note[] = [];
    for (const n of cut.notes) {
      if (targetIds.has(n.id)) {
        for (const f of [n.frame, n.annotatedFrame]) if (f) rmSync(f, { force: true });
        changed.push(n.id);
      } else kept.push(n);
    }
    if (changed.length) {
      cut.notes = kept;
      cut.saveNotes();
      emit({ type: "notes", cutId: cut.id });
    }
    return { changed, previous };
  }
  const now = nowIso();
  for (const n of cut.notes) {
    const match = action === "resolveAddressed" ? n.status === "addressed" : targetIds.has(n.id);
    if (!match) continue;
    const next: NoteStatus =
      action === "resolveAddressed" || action === "resolve"
        ? "resolved"
        : action === "reopen"
          ? "open"
          : (statuses?.[n.id] ?? n.status);
    if (next === n.status) continue;
    previous[n.id] = n.status;
    n.status = next;
    n.updatedAt = now;
    if (n.publishedAt) {
      n.humanAt = now;
      if (action === "resolveAddressed" || action === "resolve") n.thread.push({ id: shortId(), author: YOU, text: "Resolved.", at: now, status: "resolved" });
      else if (action === "reopen") n.thread.push({ id: shortId(), author: YOU, text: "Reopened.", at: now, status: "open" });
    }
    changed.push(n.id);
  }
  if (changed.length) {
    cut.saveNotes();
    if (action === "resolveAddressed" || action === "resolve") {
      cut.log({ author: YOU, kind: "reply", text: `Resolved ${changed.length} note${changed.length === 1 ? "" : "s"}` });
    }
    emit({ type: "notes", cutId: cut.id });
  }
  return { changed, previous };
}

export async function approve(cut: Cut, revN: number) {
  cut.approvedRev = revN;
  cut.saveState();
  cut.log({ author: YOU, kind: "approve", rev: revN, text: `Approved r${revN}` });
  emit({ type: "cuts" });
  emit({ type: "cut", cutId: cut.id });
  await deliver(cut, `${owner()} approved r${revN} of "${cut.name}" in Slate.`);
}

export type Collaborator = { thread: string; agent: string; at: string; link?: string };

export function t3Launcher(): { argv: string[]; env: Record<string, string> } | undefined {
  const home = process.env.T3CODE_HOME || join(process.env.USERPROFILE ?? "", ".t3");
  const cmd = process.env.T3CODE_CLI_PATH || join(home, "bin", "t3.cmd");
  if (!existsSync(cmd)) return undefined;
  const text = readFileSync(cmd, "utf8");
  const m = /^\s*"([^"]+\.exe)"\s+"([^"]+\.m?js)"\s+%\*/im.exec(text);
  if (!m || !existsSync(m[1])) return undefined;
  return { argv: [m[1], m[2]], env: { ELECTRON_RUN_AS_NODE: "1", T3CODE_CLI_PATH: cmd, T3CODE_HOME: home, T3CODE_DESKTOP_CLI_LAUNCHER: "1" } };
}

async function sendToThread(thread: string, message: string) {
  const t3 = t3Launcher();
  if (!t3) return { code: 127, stderr: "T3 Code CLI not found" };
  const p = Bun.spawn([...t3.argv, "thread", "send", thread, message], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...t3.env }, windowsHide: true });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited, new Response(p.stdout).text()]);
  return { code, stderr };
}

export async function deliver(cut: Cut, headline: string): Promise<string[]> {
  const threads = cut.collaborators;
  if (!threads?.length) return [];
  const message = `${headline} Call slate_feedback with cut "${cut.path}" to read it, then address the open notes and call slate_publish when the new revision is committed.`;
  const out: string[] = [];
  for (const c of threads.slice(-2)) {
    const r = await sendToThread(c.thread, message);
    if (r.code === 0) out.push(c.agent);
    else console.error(`[slate] could not reach thread ${c.thread}: ${r.stderr.trim()}`);
  }
  if (out.length) cut.log({ author: { kind: "unknown", name: "Slate" }, kind: "status", text: `Delivered to ${out.join(", ")}` });
  return out;
}

function getPath(obj: any, path: string[]) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildEdit(cut: Cut, doc: Doc, compositionId: string, req: EditRequest): { actions: unknown[]; expect: Expect[]; summary: string; suggestion: Suggestion } {
  const layer = findLayer(doc, req.layerId);
  if (!layer) throw new Error(`layer ${req.layerId} not found in the latest revision`);
  const name = layer.name ?? String(layer.id);
  if (req.kind === "text") {
    if (layer.type !== "Text") throw new Error(`${name} is not a text layer`);
    const before = layer.sourceText?.text ?? "";
    if (before === req.text) throw new Error(`"${name}" already reads that`);
    return {
      actions: [{ type: "animatorSetTextContent", compositionId, layerId: layer.id, text: req.text }],
      expect: [{ layerId: layer.id, path: ["sourceText", "text"], before, after: req.text }],
      summary: `${name}: text "${clip(before, 40)}" -> "${clip(req.text, 40)}"`,
      suggestion: { kind: "text", layerId: layer.id, layer: name, from: before, to: req.text },
    };
  }
  if (req.kind === "volume") {
    const before = typeof layer.volume === "number" ? layer.volume : 1;
    const after = req.db <= -60 ? 0 : Math.pow(10, req.db / 20);
    const fromDb = before <= 0 ? -60 : 20 * Math.log10(before);
    if (Math.abs(fromDb - req.db) < 0.05) throw new Error(`"${name}" is already at ${req.db.toFixed(1)} dB`);
    return {
      actions: [{ type: "animatorSetLayerVolume", compositionId, layerId: layer.id, volume: Number(after.toFixed(5)) }],
      expect: [{ layerId: layer.id, path: ["volume"], before, after: Number(after.toFixed(5)) }],
      summary: `${name}: volume ${fromDb.toFixed(1)} dB -> ${req.db.toFixed(1)} dB`,
      suggestion: { kind: "volume", layerId: layer.id, layer: name, fromDb: Number(fromDb.toFixed(1)), toDb: req.db },
    };
  }
  if (req.kind === "hide") {
    const before = isLayerHidden(layer);
    if (before === req.hidden) throw new Error(`"${name}" is already ${req.hidden ? "hidden" : "shown"}`);
    return {
      actions: [{ type: "setFxLayerHidden", compositionId, layerId: layer.id, hidden: req.hidden }],
      expect: [{ layerId: layer.id, path: ["hidden"], before: before || undefined, after: req.hidden || undefined }],
      summary: `${name}: ${req.hidden ? "hidden" : "shown"}`,
      suggestion: { kind: "hide", layerId: layer.id, layer: name, hidden: req.hidden },
    };
  }
  const w = layerWindow(layer);
  if (!Number.isFinite(w.start)) throw new Error(`${name} has no timeline placement to edit`);
  const start = Math.max(0, Math.round(req.start));
  const end = Math.max(start + 1, Math.round(req.end));
  if (Math.abs(start - w.start) < 1 && Math.abs(end - w.end) < 1) throw new Error(`"${name}" already has that timing`);
  const isGroup = layer.type === "Group";
  const sameLength = Math.abs(end - start - (w.end - w.start)) < 1;
  const actions = isGroup && sameLength
    ? [{ type: "moveFxGroupLayerTiming", compositionId, layerId: layer.id, startTimeMs: start }]
    : [{ type: "animatorSetLayerTiming", compositionId, layerId: layer.id, startTimeMs: start, endTimeMs: end }];
  return {
    actions,
    expect: [{ layerId: layer.id, path: [layer.playback ? "playback" : "activeRange"], before: layer.playback ?? layer.activeRange, after: undefined }],
    summary: `${name}: timing ${(w.start / 1000).toFixed(2)}-${(w.end / 1000).toFixed(2)} s -> ${(start / 1000).toFixed(2)}-${(end / 1000).toFixed(2)} s`,
    suggestion: { kind: "timing", layerId: layer.id, layer: name, fromMs: [w.start, w.end], toMs: [start, end] },
  };
}

export function agentBusy(cut: Cut) {
  const a = cut.agent;
  return !!a && a.state === "working" && Date.now() - Date.parse(a.at) < 10 * 60_000;
}

function commitAsYou(cut: Cut, tmp: string, baseRev: Revision, summary: string, changedMessage: string) {
  const s = statSync(cut.path);
  if (s.mtimeMs !== baseRev.mtimeMs || s.size !== baseRev.fileSize) throw new Error(changedMessage);
  renameSync(tmp, cut.path);
  const written = statSync(cut.path);
  cut.pendingSelf = { until: Date.now() + 60_000, summary, size: written.size, mtimeMs: written.mtimeMs };
}

async function writeActions(cut: Cut, actions: unknown[], baseRev: Revision, summary: string) {
  const cli = findCli();
  const dir = dirname(cut.path);
  const tmp = join(dir, `.${basename(cut.path)}.slate-${process.pid}-${Date.now()}.tsrct`);
  const actionsFile = join(cut.dataDir, `actions-${Date.now()}.json`);
  writeFileSync(actionsFile, JSON.stringify(actions));
  try {
    const source = cut.renderSource(baseRev.n)?.path ?? cut.path;
    await tsrctRun(cli, ["project", "apply", "--project", source, "--actions", actionsFile, "--output", tmp], "tsrct project apply failed");
    await unpinFonts(cut, cli, tmp);
    commitAsYou(cut, tmp, baseRev, summary, "the cut changed while your edit was being written; it was not applied");
  } finally {
    rmSync(tmp, { force: true });
    rmSync(actionsFile, { force: true });
  }
}

async function tsrctRun(cli: string, args: string[], failure: string) {
  const p = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim().split("\n").filter((l) => !l.startsWith("info:")).slice(-3).join(" | ") || failure);
}

async function unpinFonts(cut: Cut, cli: string, archive: string) {
  const checkout = join(cut.dataDir, `unpin-${process.pid}-${Date.now()}.json`);
  const rewritten = `${archive}.unpinned.tsrct`;
  try {
    await tsrctRun(cli, ["project", "checkout", "--project", archive, "--output", checkout], "tsrct project checkout failed");
    const doc = JSON.parse(readFileSync(checkout, "utf8")) as Doc;
    let unpinned = 0;
    walk(doc.composition.layers, (l) => {
      if (l.sourceText?.fontAssetId) {
        delete l.sourceText.fontAssetId;
        unpinned++;
      }
    });
    if (!unpinned) return;
    writeFileSync(checkout, JSON.stringify(doc));
    await tsrctRun(cli, ["project", "commit", "--project", archive, "--file", checkout, "--output", rewritten], "tsrct project commit failed");
    renameSync(rewritten, archive);
    console.log(`[slate] ${cut.name}: removed ${unpinned} font pin${unpinned === 1 ? "" : "s"} that tsrct project apply adds, so the cut still renders`);
  } finally {
    rmSync(checkout, { force: true });
    rmSync(rewritten, { force: true });
  }
}

export async function edit(cut: Cut, requests: EditRequest[], opts: { force?: boolean; text?: string } = {}) {
  const rev = cut.latest;
  if (!rev) throw new Error("this cut has no revision yet");
  await cut.ingest();
  const base = cut.latest!;
  const doc = cut.docFor(base.n)!.doc;
  const compositionId = doc.composition.id;
  const built = requests.map((r) => buildEdit(cut, doc, compositionId, r));
  const actions = built.flatMap((b) => b.actions);
  const expect = built.flatMap((b) => b.expect);
  const summary = built.map((b) => b.summary).join("; ");
  const queued = agentBusy(cut) && !opts.force;
  const id = shortId();
  const note: Note & { expect?: Expect[]; applied?: boolean } = {
    id,
    kind: "edit",
    rev: base.n,
    t: 0,
    author: YOU,
    text: opts.text?.trim() || summary,
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    publishedAt: nowIso(),
    humanAt: nowIso(),
    annotations: [],
    context: [],
    actions,
    suggestion: built.length === 1 ? built[0].suggestion : { kind: "actions", actions, summary },
    thread: [],
    expect,
    applied: !queued,
  };
  const target = built[0]?.suggestion as any;
  const layer = target?.layerId !== undefined ? findLayer(doc, target.layerId) : undefined;
  if (layer) {
    const w = absoluteWindow(doc, layer.id);
    if (w) {
      note.t = Math.max(0, Math.round(w.start));
      note.end = Math.round(w.end);
      note.context = contextAt(doc, Math.min(w.end - 1, w.start + 1));
      (note as any).anchor = anchorFor(doc, note.t);
    }
  }
  if (!queued) {
    await writeActions(cut, actions, base, summary);
    for (const exp of expect) if (exp.after === undefined && exp.path[0] !== "hidden") {
      exp.after = "__any__";
    }
  }
  if (!queued) supersede(cut, expect);
  cut.notes.push(note);
  cut.saveNotes();
  cut.log({ author: YOU, kind: "edit", noteId: id, rev: base.n, text: queued ? `Queued for ${cut.agent?.name}: ${summary}` : `Edited: ${summary}` });
  emit({ type: "notes", cutId: cut.id, noteId: id });
  if (queued) await deliver(cut, `${owner()} queued an edit on "${cut.name}" in Slate: ${summary}.`);
  else cut.scheduleIngest(0);
  return { note, queued };
}

function supersede(cut: Cut, expect: Expect[]) {
  const covers = (e: Expect) => expect.some((n) => n.layerId === e.layerId && n.path.join(".") === e.path.join("."));
  for (const old of cut.notes as (Note & { expect?: Expect[]; applied?: boolean })[]) {
    if (old.kind !== "edit" || old.status === "resolved" || old.status === "wontfix" || old.applied === false || !old.expect?.length) continue;
    if (!old.expect.every(covers)) continue;
    old.status = "resolved";
    old.updatedAt = nowIso();
    old.thread.push({ id: shortId(), author: YOU, text: "Replaced by a later edit.", at: nowIso(), status: "resolved" });
  }
}

export async function applyQueued(cut: Cut, noteId: string) {
  const note = cut.notes.find((n) => n.id === noteId) as any;
  if (!note || note.kind !== "edit" || !note.actions) throw new Error("not an edit");
  await cut.ingest();
  const base = cut.latest!;
  await writeActions(cut, note.actions, base, note.text);
  if (note.expect) supersede(cut, note.expect);
  note.applied = true;
  note.overwrittenIn = undefined;
  note.updatedAt = nowIso();
  cut.saveNotes();
  cut.log({ author: YOU, kind: "edit", noteId, text: `Applied: ${clip(note.text)}` });
  emit({ type: "notes", cutId: cut.id, noteId });
  cut.scheduleIngest(0);
}

export async function undoEdit(cut: Cut, noteId: string) {
  const note = cut.notes.find((n) => n.id === noteId) as any;
  if (!note || note.kind !== "edit") throw new Error("not an edit");
  const doc = cut.docFor(note.rev)?.doc;
  if (!doc) throw new Error("the revision this edit was made on is gone");
  const inverse: EditRequest[] = [];
  const s = note.suggestion as Suggestion;
  if (s.kind === "text") inverse.push({ kind: "text", layerId: s.layerId, text: s.from });
  else if (s.kind === "volume") {
    const exact = (note.expect as Expect[] | undefined)?.find((e) => e.path[0] === "volume")?.before;
    inverse.push({ kind: "volume", layerId: s.layerId, db: typeof exact === "number" ? (exact <= 0 ? -60 : 20 * Math.log10(exact)) : s.fromDb });
  }
  else if (s.kind === "hide") inverse.push({ kind: "hide", layerId: s.layerId, hidden: !s.hidden });
  else if (s.kind === "timing") inverse.push({ kind: "timing", layerId: s.layerId, start: s.fromMs[0], end: s.fromMs[1] });
  else throw new Error("this edit cannot be undone automatically; revert to an earlier revision instead");
  await cut.ingest();
  const base = cut.latest!;
  const latestDoc = cut.docFor(base.n)!.doc;
  const drift = driftSince(latestDoc, note, s);
  if (drift) throw new Error(`${drift} Undo would overwrite that, so nothing was changed. Edit it directly or restore an earlier revision.`);
  const built = inverse.map((r) => buildEdit(cut, latestDoc, latestDoc.composition.id, r));
  await writeActions(cut, built.flatMap((b) => b.actions), base, `Undo: ${note.text}`);
  note.status = "wontfix";
  note.thread.push({ id: shortId(), author: YOU, text: "Undone.", at: nowIso(), status: "wontfix" });
  note.updatedAt = nowIso();
  cut.saveNotes();
  cut.log({ author: YOU, kind: "edit", noteId, text: `Undid: ${clip(note.text)}` });
  emit({ type: "notes", cutId: cut.id, noteId });
  cut.scheduleIngest(0);
}

function driftSince(doc: Doc, note: { expect?: Expect[] }, s: Suggestion): string | undefined {
  const layerId = (s as any).layerId as number | undefined;
  const layer = layerId !== undefined ? findLayer(doc, layerId) : undefined;
  const name = (s as any).layer ?? "That layer";
  if (!layer) return `"${name}" is no longer in the cut.`;
  if (s.kind === "timing") {
    const w = layerWindow(layer);
    if (Math.abs(w.start - s.toMs[0]) > 1 || Math.abs(w.end - s.toMs[1]) > 1) return `"${name}" has been retimed since your edit (now ${(w.start / 1000).toFixed(2)}-${(w.end / 1000).toFixed(2)} s).`;
    return undefined;
  }
  for (const exp of note.expect ?? []) {
    if (exp.after === "__any__" || exp.layerId !== layer.id) continue;
    const norm = (v: unknown) => (exp.path[0] === "hidden" ? v === true || undefined : v);
    const value = editedValue(layer, exp.path);
    if (canonical(norm(value)) !== canonical(norm(exp.after))) return `"${name}" has changed since your edit.`;
  }
  return undefined;
}

export async function revertTo(cut: Cut, revN: number) {
  const rev = cut.revision(revN);
  if (!rev?.snapshot || !existsSync(rev.snapshot)) throw new Error(`r${revN} is no longer kept on disk; only the last few revisions can be restored`);
  await cut.ingest();
  const base = cut.latest!;
  if (!rev.snapshot || !existsSync(rev.snapshot)) throw new Error(`r${revN} is no longer kept on disk; only the last few revisions can be restored`);
  if (rev.hash === base.hash) throw new Error(`The cut already matches r${revN}; nothing to restore`);
  const tmp = join(dirname(cut.path), `.${basename(cut.path)}.slate-revert-${Date.now()}.tsrct`);
  try {
    await copyFile(rev.snapshot, tmp);
    commitAsYou(cut, tmp, base, `Reverted to r${revN}`, `the cut changed while r${revN} was being restored; nothing was overwritten`);
  } finally {
    rmSync(tmp, { force: true });
  }
  cut.log({ author: YOU, kind: "edit", rev: revN, text: `Reverted to r${revN}` });
  cut.scheduleIngest(0);
}

export function feedbackFor(cut: Cut, opts: { status?: string; since?: string } = {}) {
  const now = nowIso();
  const latest = cut.latest;
  const doc = latest ? cut.docFor(latest.n)?.doc : undefined;
  const wanted = (n: Note) => {
    if (n.status === "draft") return false;
    if (opts.since && n.updatedAt <= opts.since) return false;
    if (!opts.status || opts.status === "actionable") return n.status === "open" || n.status === "claimed" || (n.kind === "edit" && !!n.overwrittenIn && n.status !== "resolved" && n.status !== "wontfix");
    if (opts.status === "all") return true;
    return n.status === opts.status;
  };
  const notes = cut.notes.filter(wanted).map((n) => {
    const d = displayTime(n as any, doc);
    return {
      id: n.id,
      kind: n.kind,
      status: n.status,
      madeOnRevision: n.rev,
      comparedWithRevision: n.against,
      time: fmtTime(d.t),
      timeMs: d.t,
      endMs: n.end !== undefined ? n.end + (d.t - n.t) : undefined,
      movedFromMs: d.moved ? n.t : undefined,
      anchorGone: d.gone || undefined,
      tag: n.tag,
      text: n.text || (n.tag ? TAG_TEXT[n.tag] : ""),
      target: n.target,
      author: n.author.name,
      visibleLayers: n.context.filter((c) => !c.hidden).map((c) => ({ id: c.id, name: c.name, type: c.type, text: c.text, asset: c.asset, sourceMs: c.sourceMs, volume: c.volume })),
      drawings: n.annotations.length ? n.annotations : undefined,
      frame: n.frame,
      markedFrame: n.annotatedFrame,
      suggestion: n.suggestion,
      actions: n.kind === "edit" ? n.actions : undefined,
      appliedToCut: n.kind === "edit" ? (n as any).applied !== false && !n.overwrittenIn : undefined,
      overwrittenInRevision: n.overwrittenIn,
      media: n.media?.map((m) => relocate(m, cut)),
      thread: n.thread.map((t) => ({ by: t.author.name, text: t.text, status: t.status, rev: t.rev })),
    };
  });
  const withMedia = notes.some((n) => n.media?.length);
  const messages = cut.messages
    .filter((m) => m.author.kind === "you" && (!opts.since || m.at > opts.since))
    .slice(-15)
    .map((m) => ({ id: m.id, by: m.author.name, text: m.text, at: m.at, rev: m.rev, replyToBlocked: m.replyToBlocked }));
  return {
    now,
    cut: cut.path,
    name: cut.name,
    latestRevision: latest?.n,
    approvedRevision: cut.approvedRev,
    durationMs: latest?.durationMs,
    size: latest ? `${latest.width}x${latest.height}` : undefined,
    agentState: cut.agent,
    messages: messages.length ? messages : undefined,
    notes,
    guidance: notes.length || messages.length
      ? "Address each note and any direct messages. A note with only a tag carries the tag sentence as its text. target names the layer the note is about. comparedWithRevision means the reviewer was comparing against that revision when writing it, so check what differs there. Edits marked appliedToCut are already in the project: fold them into your generator or source so your next build keeps them. Reply with slate_reply (status claimed/addressed/wontfix; supports batch replies) and call slate_publish with addresses=[note ids] after committing."
      : "No open feedback.",
    mediaGuide: withMedia ? MEDIA_GUIDE : undefined,
  };
}

export function fmtTime(ms: number) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function revisionInfo(rev: Revision) {
  return {
    n: rev.n,
    at: rev.at,
    author: rev.author.name,
    summary: rev.summary ?? describeChanges(rev),
    changes: rev.changes,
    changedSeconds: rev.changedSegments,
    durationMs: rev.durationMs,
    size: `${rev.width}x${rev.height}`,
  };
}
