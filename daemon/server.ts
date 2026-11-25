import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { diffPair } from "./compare";
import { checksFor, peaksFor } from "./checks";
import { measureTarget } from "./target";
import { join, extname, resolve, sep } from "node:path";
import { subscribe, type SlateEvent, emit } from "./events";
import type { Registry, Cut } from "./cuts";
import type { Renderer } from "./render";
import type { Exporter } from "./exports";
import { videoFile } from "./render";
import { contextAt, timelineItems, SEGMENT_MS } from "./doc";
import { buildContactSheet, extractFrame, extractThumb, run, FFMPEG, THUMB_SHORT_SIDE } from "./media";
import { FRAME_CACHE, THUMB_CACHE } from "./paths";
import { RENDER_SETTINGS } from "./cuts";
import { findCli } from "./tsrct";
import { projectInfo, libraryPoster, resolveLibraryPath, entryRange, chunkedStream, groupOf, POSTER_SHORT_SIDE } from "./library";
import {
  createNote, updateNote, deleteNote, reply, publish, approve, edit, applyQueued, undoEdit, revertTo, feedbackFor, revisionInfo, displayTime, sendMessage, notifyReply, deliverReopened, batchNotes, fmtTime, YOU, clip,
  type EditRequest,
} from "./collab";
import type { Author, Note, NoteStatus } from "./types";
import { owner, seeClient, updateSettings } from "./settings";
import { setupReport } from "./setup";
import { CACHE_CHOICES, PREVIEW_QUALITIES, SERVICE_DEFAULTS, SLOT_CHOICES, cacheUsage, serviceSettings, updateService } from "./service";
import { CACHE_DIR, HOME_ID } from "./paths";
import {
  MIME_OF, MediaError, addBytes, addFiles, addUrl, defaultGlobalRoot, globalRoot, settledListing, itemAt, kindOf, listing, makeFolder, peaksFor as mediaPeaks, projectRoot, recycle, refOf, relocate, rewatch, MAX_BYTES as MEDIA_MAX_BYTES, renameEntry, thumbFor, transfer, MEDIA_GUIDE,
  type MediaItem, type MediaRef,
} from "./medialib";

type Ctx = { registry: Registry; renderer: Renderer; exporter: Exporter; token: string; uiDir: () => string | undefined; startedAt: string; version: string };

type Caching = "immutable" | "no-cache" | "no-store";
const CACHE_HEADER: Record<Caching, string> = { immutable: "private, max-age=31536000, immutable", "no-cache": "no-cache", "no-store": "no-store" };

const building = new Map<string, Promise<void>>();
const POSTER_SEARCH = 120;
function buildOnce(file: string, make: () => Promise<void>) {
  let p = building.get(file);
  if (!p) {
    p = make().finally(() => building.delete(file));
    building.set(file, p);
  }
  return p;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, message: string) => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function allowedOrigin(origin: string | null, host: string | null) {
  if (!origin) return true;
  if (origin === "null" || origin.startsWith("file://") || origin.startsWith("app://")) return true;
  try {
    const u = new URL(origin);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (!host || u.host === host || u.port === "5173" || u.port === "5174");
  } catch {
    return false;
  }
}

async function serveFile(req: Request, path: string, type: string | undefined, caching: Caching) {
  const file = Bun.file(path);
  if (!(await file.exists())) return fail(404, "not found");
  const size = file.size;
  const range = req.headers.get("range");
  const headers: Record<string, string> = { "content-type": type ?? MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": CACHE_HEADER[caching] };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
    }
  }
  return new Response(file, { headers: { ...headers, "content-length": String(size) } });
}

const waiters = new Set<{ cutId?: string; resolve: (e: SlateEvent) => void }>();
subscribe((e) => {
  for (const w of [...waiters]) {
    if ("cutId" in e && w.cutId && e.cutId !== w.cutId) continue;
    w.resolve(e);
  }
});

function linkOf(body: any): string | undefined {
  return typeof body?.threadLink === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(body.threadLink) ? body.threadLink : undefined;
}

function agentOf(body: any): Author {
  const name = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim().slice(0, 60) : "Agent";
  return { kind: "agent", name };
}

export function cutDetail(ctx: Ctx, cut: Cut, rev?: number) {
  const latest = cut.latest;
  const r = cut.revision(rev) ?? latest;
  const doc = r ? cut.docFor(r.n)?.doc : undefined;
  const movie = r ? ctx.renderer.movie(cut.id, r.n) : undefined;
  const segments = r ? ctx.renderer.segmentStates(cut, r) : [];
  const renderProgress = r && latest && r.n === latest.n ? ctx.renderer.progressFromStates(segments) : ctx.renderer.progressFor(cut);
  return {
    ...cut.summary(renderProgress),
    rev: r?.n,
    revisions: cut.revisions.map((x) => ({ ...revisionInfo(x), authorKind: x.author.kind, published: !!x.published, hasMovie: !!ctx.renderer.movie(cut.id, x.n), movieKey: ctx.renderer.movie(cut.id, x.n)?.key, restorable: !!x.snapshot && existsSync(x.snapshot), exportable: !!cut.renderSource(x.n) })),
    timeline: doc ? timelineItems(doc) : [],
    segments,
    changedSegments: r?.changedSegments ?? [],
    movie: movie ? { rev: movie.rev, key: movie.key, stale: movie.stale, missing: movie.missing, complete: movie.complete } : undefined,
    jobs: ctx.renderer.jobsFor(cut.id),
    renderError: ctx.renderer.failureFor(cut),
    renderFps: RENDER_SETTINGS.fps,
    previewQuality: serviceSettings().previewQuality,
    storageNotice: cut.storage?.mode === "none" ? cut.storage.reason : undefined,
    snapshotBytes: cut.snapshotBytes(),
    export: ctx.exporter.stateFor(cut),
    notes: cut.notes.map((n) => {
      const d = displayTime(n as any, doc);
      return { ...n, media: n.media?.map((m) => relocate(m, cut)), displayT: d.t, moved: d.moved, anchorGone: d.gone, frame: n.frame ? `/api/cuts/${cut.id}/notes/${n.id}/frame` : undefined, annotatedFrame: n.annotatedFrame ? `/api/cuts/${cut.id}/notes/${n.id}/frame?marked=1` : undefined };
    }),
    messages: cut.messages.slice(-50),
    activity: cut.activity.slice(-200),
    collaborators: cut.collaborators,
  };
}

async function frameFor(ctx: Ctx, cut: Cut, t: number, revN?: number): Promise<string | undefined> {
  const rev = cut.revision(revN) ?? cut.latest;
  if (!rev) return undefined;
  const fps = RENDER_SETTINGS.fps;
  const clamped = Math.max(0, Math.min(rev.durationMs - 1, t));
  const s = Math.min(rev.vkeys.length - 1, Math.floor(clamped / SEGMENT_MS));
  const seg = videoFile(rev.vkeys[s]);
  if (!existsSync(seg)) return undefined;
  const segMs = Math.min(rev.durationMs, (s + 1) * SEGMENT_MS) - s * SEGMENT_MS;
  const frames = Math.max(1, Math.round((segMs * fps) / 1000));
  const index = Math.min(frames - 1, Math.floor(((clamped - s * SEGMENT_MS) * fps) / 1000 + 0.01));
  const out = join(FRAME_CACHE, `${rev.vkeys[s]}-f${index}.png`);
  if (existsSync(out)) ctx.renderer.touch(out);
  else await buildOnce(out, () => extractFrame(seg, index, out));
  return out;
}

async function exactFrame(cut: Cut, t: number, revN?: number): Promise<string> {
  const rev = cut.revision(revN) ?? cut.latest;
  if (!rev) throw new Error("no revision");
  const source = cut.renderSource(rev.n);
  if (!source) throw new Error("revision archive not available");
  const out = join(FRAME_CACHE, `exact-${cut.id}-r${rev.n}-${Math.round(t)}.png`);
  if (existsSync(out)) return out;
  const mov = `${out}.mov`;
  const p = Bun.spawn([findCli(), "export", "--project", source.path, "--output", mov, "--format", "prores", "--resolution", "1080p", "--fps", "60", "--start-ms", String(Math.round(t)), "--duration-ms", "17"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n").slice(-2).join(" | "));
  const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", mov, "-frames:v", "1", out]);
  rmSync(mov, { force: true });
  if (r.code !== 0) throw new Error(r.stderr);
  return out;
}

function decodeDataUrl(v: unknown): Buffer | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(v);
  return m ? Buffer.from(m[2], "base64") : undefined;
}

function resolveCut(ctx: Ctx, idOrPath: string | null | undefined, open = false): Cut | undefined {
  if (!idOrPath) return undefined;
  const hit = ctx.registry.get(idOrPath);
  if (hit) return hit;
  if (open && /\.tsrct$/i.test(idOrPath) && existsSync(idOrPath)) return ctx.registry.add(resolve(idOrPath));
  return undefined;
}

export function startServer(ctx: Ctx, port: number) {
  return Bun.serve({
    port,
    maxRequestBodySize: MEDIA_MAX_BYTES + 1024 * 1024,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      if (!allowedOrigin(origin, req.headers.get("host"))) return fail(403, "origin not allowed");
      const p = url.pathname;

      if (!p.startsWith("/api/")) {
        const uiDir = ctx.uiDir();
        if (!uiDir) return fail(404, "no UI bundle; run bun run build");
        let rel = "index.html";
        try {
          if (p !== "/") rel = decodeURIComponent(p.slice(1));
        } catch {
          return fail(400, "bad path");
        }
        const file = resolve(uiDir, rel);
        if (!file.startsWith(resolve(uiDir) + sep)) return fail(403, "bad path");
        if (existsSync(file) && statSync(file).isFile()) return serveFile(req, file, undefined, rel.startsWith("assets/") ? "immutable" : "no-cache");
        return serveFile(req, join(uiDir, "index.html"), undefined, "no-cache");
      }

      const token = req.headers.get("x-slate-token") ?? url.searchParams.get("token");
      if (p === "/api/health") return json({ ok: true, app: "slate", version: ctx.version, pid: process.pid, home: HOME_ID, startedAt: ctx.startedAt, authed: token === ctx.token });
      if (token !== ctx.token) return fail(401, "missing or wrong token");
      seeClient(req.headers.get("x-slate-client"), req.headers.get("x-slate-t3") === "1");
      if (p === "/api/busy") return json({ reasons: busyReasons(ctx) });

      const agentCall = (p.startsWith("/api/agent/") && p !== "/api/agent/wait") || p === "/api/media/add";
      if (agentCall) agentCalls++;
      try {
        if (p === "/api/media/upload" && req.method === "POST") {
          const lib = libRoot(ctx, url.searchParams.get("lib"));
          const bytes = new Uint8Array(await req.arrayBuffer());
          const rel = addBytes(lib.root, url.searchParams.get("folder") ?? "", url.searchParams.get("name") ?? "Pasted", req.headers.get("content-type") ?? "", bytes);
          return json({ added: [rel] });
        }
        const body: any = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : {};
        if (p === "/api/media" || p.startsWith("/api/media/")) return await mediaRoute(ctx, req, url, p.slice("/api/media".length), body);
        const segs = p.split("/").filter(Boolean);

        if (p === "/api/events") {
          const cutFilter = url.searchParams.get("cut");
          let unsub: (() => void) | undefined;
          let beat: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (e: unknown) => {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
                } catch {}
              };
              send({ type: "hello" });
              unsub = subscribe((e) => {
                if (cutFilter && "cutId" in e && e.cutId !== cutFilter) return;
                send(e);
              });
              beat = setInterval(() => send({ type: "ping" }), 15000);
            },
            cancel() {
              unsub?.();
              clearInterval(beat);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
        }

        if (p === "/api/setup") return json(await setupReport(ctx.registry.roots));
        if (p === "/api/settings" && req.method === "POST") {
          updateSettings(body);
          return json(await setupReport(ctx.registry.roots));
        }
        if (p === "/api/service" || p.startsWith("/api/service/")) return json(await serviceRoute(ctx, p.slice("/api/service".length), req.method, body));
        if (p === "/api/state") {
          return json({ cuts: [...ctx.registry.cuts.values()].map((c) => c.summary(ctx.renderer.progressFor(c))).sort((a, b) => (b.latest?.at ?? "").localeCompare(a.latest?.at ?? "")) });
        }
        if (p === "/api/library") return json({ roots: ctx.registry.roots, files: ctx.registry.scanLibrary().map((f) => ({ ...f, ...projectInfo(f.path), group: groupOf(f.path, ctx.registry.roots) })) });
        if (p === "/api/library/poster") {
          const path = resolveLibraryPath(url.searchParams.get("path"), ctx.registry.roots);
          if (!path) return fail(404, "not a project in the library");
          const f = await libraryPoster(path, (name, sig) => `${url.origin}/api/library/entry?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}&sig=${sig}&token=${ctx.token}`);
          if (!f) return fail(404, "no footage to make a poster from");
          return serveFile(req, f, "image/jpeg", url.searchParams.has("v") ? "immutable" : "no-cache");
        }
        if (p === "/api/library/entry") {
          const path = resolveLibraryPath(url.searchParams.get("path"), ctx.registry.roots);
          const sig = url.searchParams.get("sig") ?? "";
          const range = path ? entryRange(path, url.searchParams.get("name") ?? "", sig) : undefined;
          if (!path || !range) return fail(404, "no such entry");
          const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
          const from = m?.[1] ? Number(m[1]) : m?.[2] ? Math.max(0, range.size - Number(m[2])) : 0;
          const to = m?.[1] && m[2] ? Math.min(range.size - 1, Number(m[2])) : range.size - 1;
          if (from >= range.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${range.size}` } });
          const headers: Record<string, string> = { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": String(to - from + 1), "cache-control": "no-store" };
          if (m) headers["content-range"] = `bytes ${from}-${to}/${range.size}`;
          return new Response(chunkedStream(path, range.start + from, range.start + to, sig), { status: m ? 206 : 200, headers });
        }
        if (p === "/api/activity") {
          const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit") ?? 80)));
          const items = [...ctx.registry.cuts.values()].flatMap((c) => c.activity.slice(-limit).map((a) => ({ ...a, cutId: c.id, cut: c.name })));
          items.sort((a, b) => b.at.localeCompare(a.at));
          return json({ items: items.slice(0, limit) });
        }
        if (p === "/api/cuts/open" && req.method === "POST") {
          const path = String(body.path ?? "");
          if (!/\.tsrct$/i.test(path) || !existsSync(path)) return fail(400, `not a .tsrct file: ${path}`);
          const cut = ctx.registry.add(resolve(path));
          return json(cut.summary(ctx.renderer.progressFor(cut)));
        }

        if (segs[1] === "cuts" && segs[2]) {
          const cut = resolveCut(ctx, segs[2]);
          if (!cut) return fail(404, "unknown cut");
          const sub = segs[3];
          if (!sub && req.method === "GET") return json(cutDetail(ctx, cut, url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined));
          if (sub === "close" && req.method === "POST") {
            ctx.registry.remove(cut.id);
            return json({ ok: true });
          }
          if (sub === "movie") {
            const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : cut.latest?.n;
            const key = url.searchParams.get("k");
            if (rev === undefined) return fail(404, "no revision");
            if (key) {
              const file = ctx.renderer.movieFile(cut.id, rev, key);
              if (!existsSync(file)) return fail(404, "that movie was replaced; reload the cut");
              ctx.renderer.touch(file);
              return serveFile(req, file, "video/mp4", "immutable");
            }
            const m = ctx.renderer.movie(cut.id, rev);
            if (!m || !existsSync(m.file)) return fail(404, "not rendered yet");
            ctx.renderer.touch(m.file);
            return serveFile(req, m.file, "video/mp4", "no-store");
          }
          if (sub === "frame") {
            const t = Number(url.searchParams.get("t") ?? 0);
            const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined;
            const f = url.searchParams.get("exact") ? await exactFrame(cut, t, rev) : await frameFor(ctx, cut, t, rev);
            if (!f) return fail(404, "that part has not rendered yet");
            return serveFile(req, f, "image/png", rev !== undefined ? "immutable" : "no-store");
          }
          if (sub === "thumb") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined);
            const s = Number(url.searchParams.get("s"));
            if (!rev || !Number.isInteger(s) || s < 0 || s >= rev.vkeys.length) return fail(404, "no such second");
            const seg = videoFile(rev.vkeys[s]);
            if (!existsSync(seg)) return fail(404, "not rendered yet");
            const side = url.searchParams.get("size") === "poster" ? POSTER_SHORT_SIDE : THUMB_SHORT_SIDE;
            const out = join(THUMB_CACHE, `${rev.vkeys[s]}-${side}.jpg`);
            if (existsSync(out)) ctx.renderer.touch(out);
            else await buildOnce(out, () => extractThumb(seg, out, side));
            return serveFile(req, out, "image/jpeg", url.searchParams.has("rev") ? "immutable" : "no-store");
          }
          if (sub === "poster") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined) ?? cut.latest;
            if (!rev) return fail(404, "no revision");
            const want = Math.min(rev.vkeys.length - 1, Math.floor(Math.min(rev.durationMs * 0.3, 2500) / SEGMENT_MS));
            let s: number | undefined;
            for (let d = 0; d <= POSTER_SEARCH && s === undefined; d++) {
              for (const i of d ? [want + d, want - d] : [want]) {
                if (i >= 0 && i < rev.vkeys.length && existsSync(videoFile(rev.vkeys[i]))) {
                  s = i;
                  break;
                }
              }
            }
            if (s === undefined) return fail(404, "not rendered yet");
            const seg = videoFile(rev.vkeys[s]);
            const out = join(THUMB_CACHE, `${rev.vkeys[s]}-${POSTER_SHORT_SIDE}.jpg`);
            if (existsSync(out)) ctx.renderer.touch(out);
            else await buildOnce(out, () => extractThumb(seg, out, POSTER_SHORT_SIDE));
            return serveFile(req, out, "image/jpeg", url.searchParams.has("rev") ? "immutable" : "no-store");
          }
          if (sub === "context") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined);
            const doc = rev ? cut.docFor(rev.n)?.doc : undefined;
            return json({ layers: doc ? contextAt(doc, Number(url.searchParams.get("t") ?? 0)) : [] });
          }
          if (sub === "playhead" && req.method === "POST") {
            ctx.renderer.setPlayhead(cut.id, Number(body.t ?? 0));
            return json({ ok: true });
          }
          if (sub === "retry" && req.method === "POST") {
            ctx.renderer.retry(cut);
            return json({ ok: true });
          }
          if (sub === "render" && req.method === "POST") {
            const rev = Number(body.rev);
            ctx.renderer.plan(cut, rev);
            return json({ ok: true });
          }
          if (sub === "export" && req.method === "POST") {
            if (segs[4] === "cancel") return json({ ok: ctx.exporter.cancel(cut) });
            const rev = Number(body.rev ?? cut.latest?.n);
            const id = ctx.exporter.start(cut, rev, YOU, body.preset);
            return json({ id, export: ctx.exporter.stateFor(cut) });
          }
          if (sub === "publish" && req.method === "POST") return json(await publish(cut));
          if (sub === "message" && req.method === "POST") return json(await sendMessage(cut, String(body.text ?? ""), YOU));
          if (sub === "deliver-reopened" && req.method === "POST") {
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
            return json({ delivered: await deliverReopened(cut, ids) });
          }
          if (sub === "target" && req.method === "POST") {
            const box = await measureTarget(cut, Number(body.rev ?? cut.latest?.n), Number(body.t ?? 0), Number(body.layerId)).catch((e) => ({ error: String(e?.message ?? e) }));
            return json(box && "error" in box ? { box: null, error: box.error } : { box });
          }
          if (sub === "checks") {
            const c = await checksFor(cut, Number(url.searchParams.get("rev") ?? cut.latest?.n));
            return c ? json(c) : fail(404, "no such revision");
          }
          if (sub === "peaks") {
            const p = peaksFor(cut, Number(url.searchParams.get("rev") ?? cut.latest?.n));
            return p ? json(p) : fail(404, "no such revision");
          }
          if (sub === "diff") {
            const d = diffPair(cut, Number(url.searchParams.get("a")), Number(url.searchParams.get("b")));
            return d ? json(d) : fail(404, "no such revisions");
          }
          if (sub === "seen" && req.method === "POST") {
            if (cut.markSeen(Number(body.rev ?? cut.latest?.n))) emit({ type: "cuts" });
            return json({ ok: true, seenRev: cut.seenRev });
          }
          if (sub === "approve" && req.method === "POST") {
            await approve(cut, Number(body.rev ?? cut.latest?.n));
            return json({ ok: true });
          }
          if (sub === "revert" && req.method === "POST") {
            await revertTo(cut, Number(body.rev));
            return json({ ok: true });
          }
          if (sub === "edits" && req.method === "POST") {
            if (segs[4] && segs[5] === "apply") {
              await applyQueued(cut, segs[4]);
              return json({ ok: true });
            }
            if (segs[4] && segs[5] === "undo") {
              await undoEdit(cut, segs[4]);
              return json({ ok: true });
            }
            const r = await edit(cut, (body.edits ?? []) as EditRequest[], { force: !!body.force, text: body.text });
            return json({ id: r.note.id, queued: r.queued });
          }
          if (sub === "notes") {
            const noteId = segs[4];
            if (noteId === "batch" && req.method === "POST") {
              const action = body.action;
              if (!["resolveAddressed", "resolve", "reopen", "restore", "delete"].includes(action)) return fail(400, "unknown batch action");
              return json(batchNotes(cut, action, Array.isArray(body.ids) ? body.ids.map(String) : undefined, body.statuses));
            }
            if (!noteId && req.method === "POST") {
              const note = createNote(cut, {
                rev: body.rev,
                t: Number(body.t ?? 0),
                end: body.end !== undefined ? Number(body.end) : undefined,
                text: String(body.text ?? ""),
                annotations: Array.isArray(body.annotations) ? body.annotations : [],
                status: body.status === "open" ? "open" : "draft",
                frame: decodeDataUrl(body.frame),
                annotatedFrame: decodeDataUrl(body.annotatedFrame),
                tag: body.tag,
                target: body.target,
                against: body.against,
                media: mediaRefs(ctx, cut, body.media),
              });
              if (!note.frame) {
                const f = await frameFor(ctx, cut, note.t, note.rev).catch(() => undefined);
                if (f) {
                  note.frame = join(cut.dataDir, "frames", `${note.id}.png`);
                  await Bun.write(note.frame, Bun.file(f));
                  cut.saveNotes();
                }
              }
              return json(note);
            }
            if (noteId && segs[5] === "frame") {
              const n = cut.notes.find((x) => x.id === noteId);
              const f = url.searchParams.get("marked") ? n?.annotatedFrame : n?.frame;
              if (!f || !existsSync(f)) return fail(404, "no frame");
              return serveFile(req, f, "image/png", "no-cache");
            }
            if (noteId && segs[5] === "reply" && req.method === "POST") {
              const n = reply(cut, noteId, String(body.text ?? ""), YOU, body.status as NoteStatus | undefined);
              if (body.notify !== false && n.publishedAt) void notifyReply(cut, n, String(body.text ?? ""), body.status as NoteStatus | undefined);
              return json(n);
            }
            if (noteId && req.method === "PATCH") return json(updateNote(cut, noteId, { ...body, annotatedFrame: body.annotatedFrame === undefined ? undefined : (decodeDataUrl(body.annotatedFrame) ?? null) }));
            if (noteId && req.method === "DELETE") {
              deleteNote(cut, noteId);
              return json({ ok: true });
            }
          }
          return fail(404, "unknown endpoint");
        }

        if (segs[1] === "agent") {
          const op = segs[2];
          const cutRef = body.cut ?? url.searchParams.get("cut");
          if (op === "open") {
            const path = String(body.path ?? body.cut ?? "");
            if (!/\.tsrct$/i.test(path) || !existsSync(path)) return fail(400, `not a .tsrct file: ${path}`);
            const cut = ctx.registry.add(resolve(path));
            const who = agentOf(body);
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            cut.agent = { name: who.name, state: "working", text: body.message ? String(body.message) : "Opened for review", at: new Date().toISOString() };
            if (!cut.lastAgentTouch?.publishing) cut.lastAgentTouch = { name: who.name, at: Date.now() };
            cut.saveState();
            cut.log({ author: who, kind: "open", text: `${who.name} opened this cut` });
            await cut.ingest();
            emit({ type: "cuts" });
            emit({ type: "focus", cutId: cut.id });
            const recentMessages = cut.messages.filter((m) => m.author.kind === "you").slice(-5).map((m) => ({ id: m.id, text: m.text, at: m.at, rev: m.rev }));
            return json({
              cut: cut.path,
              id: cut.id,
              revision: cut.latest?.n,
              revisionsCount: cut.revisions.length,
              render: ctx.renderer.progressFor(cut),
              openNotes: cut.notes.filter((n) => n.status === "open" || n.status === "claimed").length,
              recentMessages: recentMessages.length ? recentMessages : undefined,
              threadLinked: !!body.thread,
            });
          }
          const cut = resolveCut(ctx, cutRef, true);
          if (!cut) return fail(404, `unknown cut: ${cutRef}. Call slate_open first.`);
          const who = agentOf(body);
          if (op === "status") {
            const state = ["working", "ready", "blocked", "idle"].includes(body.state) ? body.state : "working";
            const progress = typeof body.progress === "number" && Number.isFinite(body.progress) ? Math.max(0, Math.min(1, body.progress)) : undefined;
            const step = typeof body.step === "string" && body.step.trim() ? body.step.trim().slice(0, 40) : undefined;
            cut.agent = { name: who.name, state, text: String(body.message ?? ""), at: new Date().toISOString(), progress, step };
            if (state === "working" && !cut.lastAgentTouch?.publishing) cut.lastAgentTouch = { name: who.name, at: Date.now() };
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            cut.saveState();
            cut.log({ author: who, kind: "status", state, text: String(body.message ?? state) });
            emit({ type: "cuts" });
            emit({ type: "agent", cutId: cut.id, cut: cut.name, name: who.name, state, text: String(body.message ?? ""), progress, step });
            return json({ ok: true });
          }
          if (op === "publish") {
            const summary = body.summary ? String(body.summary) : undefined;
            const addresses: string[] | undefined = Array.isArray(body.addresses) ? body.addresses.map(String) : undefined;
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            const { rev, reason } = await cut.publishFromAgent(who.name, summary, addresses);
            const latest = cut.latest;
            cut.agent = { name: who.name, state: "ready", text: rev ? `Published r${rev.n}${summary ? `: ${summary}` : ""}` : `Nothing new to publish since r${latest?.n ?? "?"}`, at: new Date().toISOString() };
            cut.saveState();
            if (rev) void checksFor(cut, rev.n).catch(() => {});
            emit({ type: "cuts" });
            emit({ type: "cut", cutId: cut.id });
            const unknown = (addresses ?? []).filter((id) => !cut.notes.some((n) => n.id === id));
            const remainingOpenNotes = cut.notes.filter((n) => n.status === "open" || n.status === "claimed").length;
            return json({
              revision: latest?.n,
              published: rev?.n,
              newRevision: !!rev,
              addressed: rev ? (addresses ?? []).filter((id) => cut.notes.find((n) => n.id === id)?.status === "addressed") : [],
              remainingOpenNotes,
              changedSeconds: rev?.changedSegments,
              changes: rev?.changes.slice(0, 15),
              unknownNotes: unknown.length ? unknown : undefined,
              render: ctx.renderer.progressFor(cut),
              warning: rev
                ? undefined
                : `Nothing was published and no notes were marked addressed: ${reason}. Save or commit the project first. If a note needs no change, answer it with slate_reply (status addressed or wontfix) instead.`,
            });
          }
          if (op === "feedback") return json(feedbackFor(cut, { status: body.status ?? url.searchParams.get("status") ?? undefined, since: body.since ?? url.searchParams.get("since") ?? undefined }));
          if (op === "wait") {
            const timeout = Math.min(55, Math.max(1, Number(body.timeoutSec ?? url.searchParams.get("timeoutSec") ?? 50)));
            const since = String(body.since ?? url.searchParams.get("since") ?? new Date().toISOString());
            const pending = () => cut.notes.filter((n) => n.status !== "draft" && ((n.humanAt ?? (n.author.kind === "you" ? n.publishedAt : undefined) ?? "") > since || n.thread.some((t) => t.author.kind === "you" && t.at > since)));
            const pendingMessages = () => cut.messages.filter((m) => m.author.kind === "you" && m.at > since);
            const approvedSince = () => cut.activity.find((a) => a.kind === "approve" && a.at > since);
            let found = pending();
            let msgs = pendingMessages();
            if (!found.length && !msgs.length && !approvedSince()) {
              await new Promise<void>((done) => {
                const w = { cutId: cut.id, resolve: () => {
                  if (pending().length || pendingMessages().length || approvedSince()) {
                    waiters.delete(w);
                    clearTimeout(timer);
                    done();
                  }
                } };
                const timer = setTimeout(() => {
                  waiters.delete(w);
                  done();
                }, timeout * 1000);
                waiters.add(w);
              });
              found = pending();
              msgs = pendingMessages();
            }
            const appr = approvedSince();
            return json({
              now: new Date().toISOString(),
              approved: appr ? appr.rev : undefined,
              changed: found.map((n) => ({ id: n.id, kind: n.kind, status: n.status, text: clip(n.text, 140) })),
              messages: msgs.length ? msgs.map((m) => ({ id: m.id, text: m.text, at: m.at })) : undefined,
              hint: found.length || msgs.length || appr ? "Call slate_feedback for details." : `Nothing new yet. Wait again or end your turn; Slate messages a linked T3 thread when ${owner("the user")} sends notes.`,
            });
          }
          if (op === "reply") {
            if (Array.isArray(body.replies) && body.replies.length) {
              const results = body.replies.map((r: any) => {
                const n = reply(cut, String(r.note), String(r.text ?? ""), who, r.status as NoteStatus | undefined, cut.latest?.n);
                return { id: n.id, status: n.status };
              });
              return json({ replies: results });
            }
            const n = reply(cut, String(body.note), String(body.text ?? ""), who, body.status as NoteStatus | undefined, cut.latest?.n);
            return json({ id: n.id, status: n.status });
          }
          if (op === "inspect") {
            const revN = body.revision !== undefined ? Number(body.revision) : cut.latest?.n;
            const rev = cut.revision(revN) ?? cut.latest;
            if (!rev) return fail(404, "no revision");
            const doc = cut.docFor(rev.n)?.doc;
            const t = typeof body.t === "number" ? body.t : undefined;
            const compareWith = typeof body.compareWith === "number" ? body.compareWith : undefined;
            const checks = await checksFor(cut, rev.n).catch(() => undefined);
            const diff = compareWith !== undefined ? diffPair(cut, compareWith, rev.n) : undefined;
            return json({
              cut: cut.path,
              name: cut.name,
              revision: rev.n,
              durationMs: rev.durationMs,
              size: `${rev.width}x${rev.height}`,
              render: ctx.renderer.progressFor(cut),
              layers: doc ? timelineItems(doc) : [],
              visibleAt: t !== undefined && doc ? { t, time: fmtTime(t), layers: contextAt(doc, t) } : undefined,
              checks,
              diff: diff ? { old: diff.old, new: diff.new, changedSeconds: diff.seconds.filter((s) => s.picture !== "same" || s.sound !== "same").map((s) => s.s), changes: diff.changes, pending: diff.pending } : undefined,
            });
          }
          if (op === "sheet") {
            const revN = body.revision !== undefined ? Number(body.revision) : cut.latest?.n;
            const rev = cut.revision(revN) ?? cut.latest;
            if (!rev) return fail(404, "no revision");
            let times: number[] = [];
            if (Array.isArray(body.times) && body.times.length) {
              times = body.times.slice(0, 16).map((x: unknown) => Math.max(0, Math.min(rev.durationMs - 1, Math.round(Number(x) || 0))));
            } else {
              const count = Math.max(2, Math.min(16, Math.round(Number(body.count ?? 6))));
              const from = Math.max(0, Math.min(rev.durationMs - 1, Math.round(Number(body.fromMs ?? 0))));
              const to = Math.max(from, Math.min(rev.durationMs - 1, Math.round(Number(body.toMs ?? rev.durationMs - 1))));
              for (let i = 0; i < count; i++) times.push(Math.round(from + ((to - from) * i) / Math.max(1, count - 1)));
            }
            const extracted = await Promise.all(times.map(async (t) => ({ t, file: await frameFor(ctx, cut, t, rev.n) })));
            const ready = extracted.filter((x): x is { t: number; file: string } => !!x.file);
            if (!ready.length) return fail(409, "no rendered segments available for those times yet; try again shortly");
            const cols = typeof body.cols === "number" ? Math.max(1, Math.min(6, Math.round(body.cols))) : undefined;
            const key = Bun.hash(`${cut.id}:${rev.n}:${rev.hash}:${ready.map((x) => `${x.t}=${x.file}`).join(",")}:${cols ?? "auto"}`).toString(16);
            const out = join(FRAME_CACHE, `sheet-${cut.id}-r${rev.n}-${key}.png`);
            if (!existsSync(out)) {
              await buildOnce(out, () => buildContactSheet(ready.map((x) => ({ file: x.file, label: fmtTime(x.t) })), out, cols));
            } else ctx.renderer.touch(out);
            const missing = extracted.filter((x) => !x.file).map((x) => x.t);
            return json({ path: out, revision: rev.n, count: ready.length, times: ready.map((x) => ({ t: x.t, time: fmtTime(x.t) })), missing: missing.length ? missing : undefined });
          }
          if (op === "frame") {
            const t = Number(body.t ?? url.searchParams.get("t") ?? 0);
            const rev = body.revision ?? (url.searchParams.has("revision") ? Number(url.searchParams.get("revision")) : undefined);
            const exact = !!(body.exact ?? url.searchParams.get("exact"));
            const f = exact ? await exactFrame(cut, t, rev) : await frameFor(ctx, cut, t, rev);
            if (!f) return fail(409, "that second has not rendered yet; try again shortly or pass exact=true");
            return json({ path: f, t, revision: rev ?? cut.latest?.n, exact });
          }
          if (op === "revisions") return json({ cut: cut.path, revisions: cut.revisions.map(revisionInfo), approvedRevision: cut.approvedRev });
          return fail(404, "unknown agent op");
        }
        return fail(404, "unknown endpoint");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(e instanceof MediaError ? 422 : 400, msg);
      } finally {
        if (agentCall) agentCalls--;
      }
    },
  });
}

let agentCalls = 0;

function busyReasons(ctx: Ctx) {
  const reasons: string[] = [];
  if (ctx.exporter.busy()) reasons.push("an export is running");
  if (ctx.renderer.rendering()) reasons.push("a revision is rendering");
  if (agentCalls > 0) reasons.push("an agent is talking to Slate");
  return reasons;
}

function serviceState(ctx: Ctx) {
  const files = ctx.registry.scanLibrary();
  const roots = ctx.registry.roots.map((path) => ({
    path,
    exists: existsSync(path),
    projects: files.filter((f) => f.path.toLowerCase().startsWith(path.toLowerCase() + sep)).length,
  }));
  return {
    settings: serviceSettings(),
    defaults: SERVICE_DEFAULTS,
    choices: { cacheGb: CACHE_CHOICES, renderSlots: SLOT_CHOICES, previewQuality: Object.values(PREVIEW_QUALITIES) },
    roots,
    cache: { dir: CACHE_DIR, ...cacheUsage() },
    media: { dir: globalRoot(), default: defaultGlobalRoot(), items: listing("global", globalRoot()).items.length },
    render: { resolution: RENDER_SETTINGS.resolution, fps: RENDER_SETTINGS.fps, segmentMs: RENDER_SETTINGS.segmentMs, encoder: RENDER_SETTINGS.encoder, cli: RENDER_SETTINGS.cli },
    version: ctx.version,
    startedAt: ctx.startedAt,
  };
}

async function serviceRoute(ctx: Ctx, sub: string, method: string, body: any) {
  if (sub === "" && method === "POST") {
    const before = serviceSettings().mediaDir;
    updateService(body);
    if (serviceSettings().mediaDir !== before) {
      rewatch("global", globalRoot());
      emit({ type: "media", lib: "global" });
    }
  }
  else if (sub === "/roots" && method === "POST") {
    const roots = ctx.registry.roots;
    const add = typeof body.add === "string" && body.add.trim() ? resolve(body.add.trim()) : undefined;
    if (add && !existsSync(add)) throw new Error(`${add} does not exist`);
    if (add && !statSync(add).isDirectory()) throw new Error(`${add} is not a folder`);
    const drop = typeof body.remove === "string" ? body.remove.toLowerCase() : undefined;
    ctx.registry.setRoots([...roots.filter((r) => r.toLowerCase() !== drop), ...(add ? [add] : [])]);
  } else if (sub === "/trim" && method === "POST") {
    const r = ctx.renderer.evict(body.all ? 0 : undefined);
    return { ...serviceState(ctx), trimmed: r };
  }
  return serviceState(ctx);
}

type Lib = { lib: string; root: string; scope: "global" | "project"; cut?: Cut };

function libRoot(ctx: Ctx, raw: unknown): Lib {
  const lib = typeof raw === "string" ? raw.trim() : "";
  if (!lib || lib === "global") return { lib: "global", root: globalRoot(), scope: "global" };
  const cut = resolveCut(ctx, lib, true);
  if (!cut) throw new MediaError(`unknown project: ${lib}. Call slate_open first.`);
  return { lib: cut.id, root: projectRoot(cut.dataDir), scope: "project", cut };
}

function mediaRefs(ctx: Ctx, cut: Cut, raw: unknown): MediaRef[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.slice(0, 12).map((r: any) => {
    const lib = libRoot(ctx, r?.lib === "global" ? "global" : cut.id);
    return refOf(itemAt(lib.lib, lib.root, String(r?.path ?? "")), lib.scope, r?.placement);
  });
}

function forAgent(it: MediaItem, scope: "global" | "project") {
  return {
    scope,
    file: it.file,
    name: it.name,
    folder: it.folder || undefined,
    kind: it.kind,
    format: it.ext,
    size: it.width && it.height ? `${it.width}x${it.height}` : undefined,
    durationMs: it.durationMs,
    animated: it.animated || undefined,
    transparent: it.alpha || undefined,
  };
}

async function mediaRoute(ctx: Ctx, req: Request, url: URL, sub: string, body: any): Promise<Response> {
  const q = (k: string) => url.searchParams.get(k);
  if (sub === "" && req.method === "GET") {
    const lib = libRoot(ctx, q("lib"));
    return json({ ...listing(lib.lib, lib.root), scope: lib.scope });
  }
  if (sub === "/thumb" || sub === "/file" || sub === "/peaks") {
    const lib = libRoot(ctx, q("lib"));
    const it = itemAt(lib.lib, lib.root, q("path") ?? "");
    if (sub === "/peaks") return json({ peaks: await mediaPeaks(it) });
    if (sub === "/file") return serveFile(req, it.file, MIME_OF[`.${it.ext}`], "no-cache");
    const f = await thumbFor(it);
    if (!f) return fail(404, "no preview for this file");
    return serveFile(req, f, f === it.file ? MIME_OF[`.${it.ext}`] : f.endsWith(".jpg") ? "image/jpeg" : "image/png", q("v") ? "immutable" : "no-cache");
  }
  if (req.method !== "POST") return fail(404, "unknown media endpoint");
  if (sub === "/import") {
    const lib = libRoot(ctx, body.lib);
    const paths: string[] = Array.isArray(body.paths) ? body.paths.map(String) : [];
    return json(addFiles(lib.root, String(body.folder ?? ""), paths));
  }
  if (sub === "/url") {
    const lib = libRoot(ctx, body.lib);
    return json({ added: [await addUrl(lib.root, String(body.folder ?? ""), String(body.url ?? ""), body.name ? String(body.name) : undefined)] });
  }
  if (sub === "/folder") {
    const lib = libRoot(ctx, body.lib);
    return json({ path: makeFolder(lib.root, String(body.parent ?? ""), String(body.name ?? "")) });
  }
  if (sub === "/rename") {
    const lib = libRoot(ctx, body.lib);
    return json({ path: renameEntry(lib.root, String(body.path ?? ""), String(body.name ?? "")) });
  }
  if (sub === "/move") {
    const to = libRoot(ctx, body.to?.lib);
    const from = (Array.isArray(body.items) ? body.items : []).map((i: any) => ({ root: libRoot(ctx, i?.lib).root, rel: String(i?.path ?? "") }));
    return json({ paths: transfer(from, { root: to.root, folder: String(body.to?.folder ?? "") }, !!body.copy) });
  }
  if (sub === "/recycle") {
    const lib = libRoot(ctx, body.lib);
    return json({ recycled: await recycle(lib.root, Array.isArray(body.paths) ? body.paths.map(String) : []) });
  }
  if (sub === "/find") {
    const scope = ["project", "global", "all"].includes(body.scope) ? body.scope : "all";
    const terms = String(body.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const folder = String(body.folder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const libs: Lib[] = [];
    if (scope !== "global" && body.cut) libs.push(libRoot(ctx, body.cut));
    if (scope !== "project") libs.push(libRoot(ctx, "global"));
    if (!libs.length) throw new MediaError("pass cut to read a project's media");
    const listed = await Promise.all(libs.map((l) => settledListing(l.lib, l.root)));
    const out = libs.map((l, n) => {
      const all = listed[n];
      const items = all.items
        .filter((i) => !body.kind || i.kind === body.kind)
        .filter((i) => !folder || i.folder.toLowerCase() === folder || i.folder.toLowerCase().startsWith(folder + "/"))
        .filter((i) => terms.every((t) => `${i.name} ${i.folder}`.toLowerCase().includes(t)));
      return {
        scope: l.scope,
        root: l.root,
        folders: all.folders.map((f) => ({ path: f.path, items: f.count })),
        items: items.slice(0, 300).map((i) => forAgent(i, l.scope)),
        more: items.length > 300 ? items.length - 300 : undefined,
      };
    });
    return json({ libraries: out, howToUse: MEDIA_GUIDE });
  }
  if (sub === "/add") {
    if (body.scope !== "global" && !body.cut) throw new MediaError("pass cut to save into a project, or scope global");
    const lib = libRoot(ctx, body.scope === "global" ? "global" : body.cut);
    const folder = String(body.folder ?? "").replace(/\\/g, "/");
    let rels: string[] = [];
    if (body.url) rels = [await addUrl(lib.root, folder, String(body.url), body.name ? String(body.name) : undefined)];
    else if (body.path) {
      const src = resolve(String(body.path));
      if (!kindOf(src) && !(existsSync(src) && statSync(src).isDirectory())) throw new MediaError("only images, video, sound or a folder of them can be added");
      rels = addFiles(lib.root, folder, [src]).added;
      if (body.name && rels.length === 1) rels = [renameEntry(lib.root, rels[0], String(body.name))];
    } else throw new MediaError("pass path or url");
    const items = (await settledListing(lib.lib, lib.root)).items.filter((i) => rels.includes(i.path));
    return json({ added: items.map((i) => forAgent(i, lib.scope)) });
  }
  return fail(404, "unknown media endpoint");
}
