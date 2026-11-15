import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, Smartphone, Columns2, Maximize, FolderOpen, ExternalLink, Settings as Gear } from "lucide-react";
import type { Annotation, ContextLayer, CutDetail, Finding, Note, NoteTag, NoteTarget, TrackItem } from "@/lib/api";
import { useChecks, useDiff, usePeaks } from "@/lib/review-data";
import { TAGS, unwritten } from "@/lib/tags";
import { ChangeList, FixCheck, LayerPicker } from "./ReviewTools";
import { api, mediaUrl, onEvent } from "@/lib/api";
import { useCut } from "@/lib/store";
import { PlayerController, usePlayerSelect } from "@/lib/player";
import { ago, cn, FPS, frameAt, frameOf, megabytes, tc } from "@/lib/format";
import { Button, IconButton, Tip } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tabs, Tab, TabsContent, TabsList } from "./ui/tabs";
import { Player, type CompareMode } from "./Player";
import { VolumeControl } from "./Volume";
import { Sketch, drawAnnotations, markName, type MarkRef, type ShownMark, type Tool } from "./Sketch";
import { Filmstrip } from "./Filmstrip";
import { Cues, type ComposerHandle } from "./Cues";
import { Inspector, type EditRequest } from "./Inspector";
import { History } from "./History";
import { Mark } from "./Mark";
import { openSettings } from "./Settings";
import { ExportControl } from "./Export";
import { preferences, usePreference } from "@/lib/preferences";
import { MediaPanel } from "./Media";
import { setActive, trackTarget } from "@/lib/presence";
import { addTransfer, aspectOf, currentDrag, isExternal, isInternal, readDrag, stopPlay, thumbUrl, type DragItem } from "@/lib/medialib";
import type { MediaItem, MediaListing, Placement } from "@/lib/api";

type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; tone?: "error"; action?: ToastAction };

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: "error", action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 9000 : tone === "error" ? 7000 : 3800);
  }, []);
  return { toasts, push };
}

async function decoded(src: string) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img.naturalWidth && img.naturalHeight ? img : undefined;
  } catch {
    return undefined;
  }
}

function DropGhost({ hint, placement, at }: { hint: { point: [number, number]; item?: DragItem }; placement?: Placement; at: number }) {
  const label = hint.item ? `Cue at ${tc(at)} with ${hint.item.name}` : `Add to this project and cue at ${tc(at)}`;
  return (
    <div className="pointer-events-none absolute inset-0 bg-ink/25">
      {placement && (
        <div
          className="absolute overflow-hidden rounded-md shadow-[0_0_0_2px_var(--color-amber),0_10px_30px_rgba(0,0,0,.45)]"
          style={{ left: `${placement.x * 100}%`, top: `${placement.y * 100}%`, width: `${placement.w * 100}%`, height: `${placement.h * 100}%` }}
        >
          {hint.item?.thumb && <img src={hint.item.thumb} className="size-full object-contain opacity-90" draggable={false} />}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-4 flex justify-center">
        <span className="rounded-lg bg-ink/90 px-3 py-1.5 text-[13px] font-semibold text-amber">{label}</span>
      </div>
    </div>
  );
}

function SafeZones() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-x-0 top-0 h-[8%] border-b border-dashed border-white/25" />
      <div className="absolute top-[38%] right-0 h-[42%] w-[14%] border-l border-dashed border-white/25" />
      <div className="absolute inset-x-0 bottom-0 h-[19%] border-t border-dashed border-white/25" />
      <div className="absolute top-[8%] right-[14%] bottom-[19%] left-[5%] border border-dashed border-amber/30" />
    </div>
  );
}

function Presence({ cut, room, inline }: { cut: CutDetail; room?: number; inline?: boolean }) {
  const a = cut.agent;
  const latest = cut.revisions.at(-1);
  const rendering = cut.segments.filter((s) => s === "rendering" || s === "queued").length;
  const stale = cut.movie && cut.movie.rev === cut.rev ? cut.movie.stale.length : 0;
  const collaborator = cut.collaborators.at(-1);
  const fresh = a && Date.now() - Date.parse(a.at) < 30 * 60_000;
  const dot = a && (
    <span className={cn("size-2 shrink-0 rounded-full", a.state === "working" && fresh ? "motion-safe:animate-pulse bg-teal" : a.state === "blocked" ? "bg-red" : a.state === "ready" ? "bg-amber" : "bg-faint")} />
  );
  const status =
    a && (a.state === "working" ? a.text || "Working on this cut" : a.state === "ready" ? a.text || `r${latest?.n} is ready` : a.state === "blocked" ? `Needs you: ${a.text}` : a.text || "Idle");
  if (inline) {
    if (!a && !rendering && !cut.renderError) return null;
    return (
      <div className="flex min-w-0 items-center gap-2 text-[13px]" title={a ? `${a.name}: ${status}` : undefined}>
        {a && (
          <>
            {dot}
            <span className="shrink-0 font-semibold">{a.name}</span>
            <span className="truncate text-soft">{status}</span>
          </>
        )}
        {rendering > 0 && <span className="shrink-0 text-amber">Rendering {rendering}s</span>}
        {cut.renderError && <span className="shrink-0 text-red">Render failed</span>}
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute top-5 left-6 z-10 grid gap-3" style={{ maxWidth: Math.min(320, room ?? 320) }}>
      {a && (
        <div>
          <div className="flex items-start gap-2 font-semibold">
            <span className="flex h-[1lh] shrink-0 items-center">{dot}</span>
            <span className="pointer-events-auto line-clamp-2 min-w-0 break-words" title={a.name}>
              {a.name}
            </span>
            {collaborator?.link && (
              <button className="pointer-events-auto flex h-[1lh] shrink-0 items-center text-dim hover:text-text" aria-label="Open the agent's thread" onClick={() => void window.slate?.openExternal(collaborator.link!)}>
                <ExternalLink className="size-3.5" />
              </button>
            )}
          </div>
          <div className="mt-0.5 text-soft">{status}</div>
          <div className="mt-0.5 text-[12px] text-faint">{ago(a.at)}</div>
        </div>
      )}
      {(rendering > 0 || stale > 0 || cut.renderError) && (
        <div className="text-[12.5px]">
          {rendering > 0 && (
            <div className="text-amber">
              Rendering {rendering} {rendering === 1 ? "second" : "seconds"}
            </div>
          )}
          {stale > 0 && (
            <div className="text-soft">
              {stale} {stale === 1 ? "second still shows" : "seconds still show"} the previous revision
            </div>
          )}
          {cut.renderError && (
            <div className="pointer-events-auto text-red">
              <span className="break-words">{cut.renderError}</span>{" "}
              <button className="font-semibold text-text underline-offset-2 hover:underline" onClick={() => void api(`/api/cuts/${cut.id}/retry`, { method: "POST" })}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PRESENCE_MIN = 156;

function StagePlaceholder({ onGutter, children }: { onGutter: (px: number) => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const measure = () => {
      if (box.current && label.current) onGutter((box.current.clientWidth - label.current.offsetWidth) / 2);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    if (label.current) ro.observe(label.current);
    return () => ro.disconnect();
  }, [onGutter]);
  return (
    <div ref={box} className="grid flex-1 place-items-center text-soft">
      <span ref={label}>{children}</span>
    </div>
  );
}

export function Review({ cutId, start, onBack }: { cutId: string; start?: { rev?: number; t?: number; tab?: string }; onBack: () => void }) {
  const [viewRev, setViewRev] = useState<number | undefined>(start?.rev);
  const { cut, error } = useCut(cutId, viewRev);
  const controller = useMemo(() => {
    const c = new PlayerController();
    if (start?.t) c.seek(start.t);
    return c;
  }, []);
  const playing = usePlayerSelect(controller, (s) => s.playing);
  useEffect(() => {
    if (playing) stopPlay();
    setActive("play", playing ? "a cut is playing" : undefined);
  }, [playing]);
  useEffect(() => () => setActive("play", undefined), []);
  useEffect(() => stopPlay, []);
  const rate = usePlayerSelect(controller, (s) => s.rate);
  const loop = usePlayerSelect(controller, (s) => s.loop);
  const durationMs = usePlayerSelect(controller, (s) => s.durationMs);
  const time = usePlayerSelect(controller, (s) => (s.playing ? Math.floor(s.time / 250) * 250 : s.time));
  const [src, setSrc] = useState<string>();
  const [compare, setCompare] = useState<{ rev: number; mode: CompareMode; pos: number; src?: string }>();
  const [safe, setSafe] = useState(false);
  const [gutter, setGutter] = useState(PRESENCE_MIN);
  const [tool, setTool] = useState<Tool>();
  const [pending, setPending] = useState<Annotation[]>([]);
  const [markSel, setMarkSel] = useState<MarkRef>();
  const [selectedNote, setSelectedNote] = useState<string>();
  const [selectedLayer, setSelectedLayer] = useState<number>();
  const [tab, setTab] = useState(() => start?.tab ?? new URL(location.href).searchParams.get("tab") ?? "cues");
  const [flip, setFlip] = useState(false);
  const hearCompare = usePlayerSelect(controller, (s) => s.hearCompare);
  const [rangeOff, setRangeOff] = useState<string>();
  const [target, setTarget] = useState<NoteTarget & { measuring?: boolean }>();
  const [picker, setPicker] = useState<{ x: number; y: number; t: number; layers?: ContextLayer[] }>();
  const [fix, setFix] = useState<{ ids: string[]; i: number; resolved: number; reopened: number; skipped: number; replying: boolean }>();
  const composer = useRef<ComposerHandle>(null);
  const [dropHint, setDropHint] = useState<{ point: [number, number]; item?: DragItem }>();
  const stage = useRef<HTMLDivElement>(null);
  const { toasts, push } = useToasts();
  const loopCut = usePreference("loopCut");
  const safeDefault = usePreference("safeZones");
  const safeApplied = useRef(false);
  const autoplayed = useRef(false);
  const portrait = cut?.latest ? cut.latest.height > cut.latest.width : undefined;

  useEffect(() => controller.setLoopAll(loopCut), [controller, loopCut]);
  useEffect(() => {
    if (safeApplied.current || portrait === undefined) return;
    safeApplied.current = true;
    setSafe(safeDefault === "always" || (safeDefault === "portrait" && portrait));
  }, [portrait, safeDefault]);
  const watching = cut ? (cut.rev ?? cut.revisions.at(-1)?.n) : undefined;
  useEffect(() => {
    if (watching) void api(`/api/cuts/${cutId}/seen`, { body: { rev: watching } }).catch(() => {});
  }, [cutId, watching]);
  useEffect(() => {
    if (!src || autoplayed.current) return;
    autoplayed.current = true;
    if (preferences().autoplay) controller.play();
  }, [src, controller]);

  useEffect(() => {
    const off = onEvent((e) => {
        if (e.type !== "export" || e.cutId !== cutId) return;
        if (e.state === "done" && typeof e.file === "string") {
          const file = e.file;
          const size = typeof e.bytes === "number" ? `, ${megabytes(e.bytes)}` : "";
          push(`Exported r${e.rev} in 4K60${size}`, undefined, window.slate ? { label: "Show in Explorer", run: () => void window.slate?.reveal(file) } : undefined);
        } else if (e.state === "failed") push(`Export of r${e.rev} failed: ${String(e.error ?? "unknown error")}`, "error");
      else if (e.state === "cancelled") push(`Cancelled the r${e.rev} export`);
    });
    return () => {
      off();
    };
  }, [cutId, push]);

  const movieKey = cut?.movie ? `${cut.movie.rev}-${cut.movie.key}` : undefined;
  useEffect(() => {
    if (!cut?.movie) {
      if (viewRev !== undefined && cut?.rev === viewRev) {
        setSrc(undefined);
        void api(`/api/cuts/${cut.id}/render`, { body: { rev: viewRev } }).catch(() => {});
      }
      return;
    }
    void mediaUrl(`/api/cuts/${cut.id}/movie?rev=${cut.movie.rev}&k=${cut.movie.key}`).then(setSrc);
  }, [movieKey, viewRev, cut?.rev]);

  const compareKey = cut?.revisions.find((r) => r.n === compare?.rev)?.movieKey;
  useEffect(() => {
    if (!compare || !cut) return;
    if (!compareKey) return void api(`/api/cuts/${cut.id}/render`, { body: { rev: compare.rev } }).catch(() => {});
    void mediaUrl(`/api/cuts/${cut.id}/movie?rev=${compare.rev}&k=${compareKey}`).then((u) => setCompare((c) => (c && c.rev === compare.rev ? { ...c, src: u } : c)));
  }, [compare?.rev, cut?.id, compareKey]);

  useEffect(() => {
    let last = 0;
    controller.onTime = (ms) => {
      if (Math.abs(ms - last) < 1500) return;
      last = ms;
      void api(`/api/cuts/${cutId}/playhead`, { body: { t: Math.round(ms) } }).catch(() => {});
    };
    return () => {
      controller.onTime = undefined;
    };
  }, [controller, cutId]);

  const cues = useMemo(() => [...(cut?.notes ?? [])].sort((a, b) => a.displayT - b.displayT || a.createdAt.localeCompare(b.createdAt)), [cut?.notes]);
  const shown = useMemo<ShownMark[]>(() => {
    const marks = (n: Note) => n.annotations.map((a, i) => ({ note: n.id, i, a }));
    if (!playing && !tool) {
      const sel = cues.find((n) => n.id === selectedNote);
      if (sel && Math.abs(sel.displayT - time) < 120) return marks(sel);
      return cues.filter((n) => n.annotations.length && Math.abs(n.displayT - time) < 1000 / FPS).flatMap(marks);
    }
    return [];
  }, [cues, selectedNote, playing, time, tool]);
  const liveSel = markSel && (markSel.note ? shown.some((m) => m.note === markSel.note && m.i === markSel.i) : markSel.i < pending.length) ? markSel : undefined;
  useEffect(() => {
    if (!liveSel) return;
    const away = () => setMarkSel(undefined);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [liveSel]);

  const selectedItem: TrackItem | undefined = cut?.timeline.find((t) => t.id === selectedLayer);

  const edit = useCallback(
    async (req: EditRequest, force = false) => {
      if (!cut) return;
      try {
        const r = await api<{ id: string; queued: boolean }>(`/api/cuts/${cut.id}/edits`, { body: { edits: [req], force } });
        if (r.queued) push(`${cut.agent?.name ?? "The agent"} is working on this cut, so the edit is queued. Apply it from its cue when ready.`);
        else push("Edit applied. Re-rendering the changed seconds.");
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, push],
  );

  const captureWith = useCallback(
    (list: Annotation[]) => {
      const v = controller.video;
      if (!v || !v.videoWidth) return undefined;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0);
      drawAnnotations(ctx, list, c.width, c.height);
      return c.toDataURL("image/png");
    },
    [controller],
  );

  const captureMarked = useCallback(
    (extra: Annotation[] = []) => captureWith([...extra, ...pending, ...(target?.box ? [{ kind: "rect" as const, ...target.box }] : [])]),
    [captureWith, pending, target],
  );

  const removeMark = useCallback(
    async (ref: MarkRef) => {
      setMarkSel(undefined);
      if (!ref.note) {
        const a = pending[ref.i];
        if (!a) return;
        setPending((p) => p.filter((_, i) => i !== ref.i));
        let undone = false;
        push(`Removed the ${markName(a)}`, undefined, {
          label: "Undo",
          run: () => {
            if (undone) return;
            undone = true;
            setPending((p) => [...p.slice(0, ref.i), a, ...p.slice(ref.i)]);
          },
        });
        return;
      }
      if (!cut) return;
      const n = cut.notes.find((x) => x.id === ref.note);
      const a = n?.annotations[ref.i];
      if (!n || !a) return;
      const save = (list: Annotation[]) => api(`/api/cuts/${cut.id}/notes/${n.id}`, { method: "PATCH", body: { annotations: list, annotatedFrame: list.length ? captureWith(list) : null } });
      try {
        await save(n.annotations.filter((_, i) => i !== ref.i));
        let undone = false;
        push(`Removed the ${markName(a)} from cue ${cues.findIndex((x) => x.id === n.id) + 1}`, undefined, {
          label: "Undo",
          run: () => {
            if (undone) return;
            undone = true;
            void save(n.annotations).catch((e) => push(e instanceof Error ? e.message : String(e), "error"));
          },
        });
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [pending, cut, cues, captureWith, push],
  );

  const placementFor = useCallback(
    (aspect: number, point: [number, number] = [0.5, 0.5]): Placement => {
      const W = cut?.latest?.width ?? 1080;
      const H = cut?.latest?.height ?? 1920;
      let bw = Math.sqrt(0.16 * W * H * aspect);
      let bh = bw / aspect;
      const k = Math.min(1, (0.9 * W) / bw, (0.9 * H) / bh);
      bw *= k;
      bh *= k;
      const w = bw / W;
      const h = bh / H;
      const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
      return { x: clamp(point[0] - w / 2, 1 - w), y: clamp(point[1] - h / 2, 1 - h), w, h };
    },
    [cut?.latest?.width, cut?.latest?.height],
  );

  const composite = useCallback(
    async (img: HTMLImageElement | undefined, p: Placement) => {
      const v = controller.video;
      if (!v || !v.videoWidth) return undefined;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0);
      if (img) {
        try {
          const s = Math.min((p.w * c.width) / img.naturalWidth, (p.h * c.height) / img.naturalHeight);
          const dw = img.naturalWidth * s;
          const dh = img.naturalHeight * s;
          ctx.globalAlpha = 0.92;
          ctx.drawImage(img, p.x * c.width + (p.w * c.width - dw) / 2, p.y * c.height + (p.h * c.height - dh) / 2, dw, dh);
          ctx.globalAlpha = 1;
        } catch {}
      }
      drawAnnotations(ctx, [{ kind: "rect", ...p }], c.width, c.height);
      try {
        return c.toDataURL("image/png");
      } catch {
        return undefined;
      }
    },
    [controller],
  );

  const cueMedia = useCallback(
    async (m: DragItem, point?: [number, number]) => {
      if (!cut) return;
      controller.pause();
      const key = loop ? `${Math.round(loop.in)}-${Math.round(loop.out)}` : undefined;
      const range = loop && key !== rangeOff && !fix ? loop : undefined;
      const t = Math.round(range ? range.in : controller.state.time);
      const visual = m.kind !== "audio";
      const img = visual && m.thumb ? await decoded(m.thumb) : undefined;
      const placement = visual ? placementFor(img ? img.naturalWidth / img.naturalHeight : (m.aspect ?? 1), point) : undefined;
      const verb = m.kind === "audio" ? "Play" : "Add";
      try {
        const n = await api<Note>(`/api/cuts/${cut.id}/notes`, {
          body: {
            t,
            end: range ? Math.round(range.out) : undefined,
            rev: cut.rev,
            text: `${verb} "${m.name}" here`,
            annotations: placement ? [{ kind: "rect", ...placement }] : [],
            annotatedFrame: placement ? await composite(img, placement) : undefined,
            media: [{ lib: m.lib, path: m.path, placement }],
          },
        });
        setSelectedNote(n.id);
        push(`Cue at ${tc(t)} with ${m.name}`, undefined, { label: "Open cue", run: () => setTab("cues") });
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, controller, loop, rangeOff, fix, placementFor, composite, push],
  );

  const cueItem = useCallback(
    (it: MediaItem, point?: [number, number]) => void cueMedia({ lib: it.lib, path: it.path, name: it.name, kind: it.kind, aspect: aspectOf(it), thumb: thumbUrl(it) }, point),
    [cueMedia],
  );

  const dropOnFrame = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      if (!cut) return;
      const r = e.currentTarget.getBoundingClientRect();
      const point: [number, number] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      const internal = readDrag(e.dataTransfer);
      if (internal?.some((i) => i.folder)) return;
      if (internal?.length) return void cueMedia(internal[0], point);
      try {
        const added = await addTransfer(cut.id, "", e.dataTransfer);
        const first = added?.added[0];
        if (!first) return push("Drop an image, GIF, clip or sound", "error");
        const listing = await api<MediaListing>(`/api/media?lib=${cut.id}`);
        const it = listing.items.find((i) => i.path === first);
        if (it) cueItem(it, point);
      } catch (err) {
        push(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [cut, cueMedia, cueItem, push],
  );

  const viewingRev = cut ? (cut.rev ?? cut.revisions.at(-1)?.n) : undefined;
  useEffect(() => {
    trackTarget(() => ({ cutId, rev: viewRev, t: Math.round(controller.state.time), tab }));
    return () => trackTarget(undefined);
  }, [cutId, viewRev, tab, controller]);
  const diff = useDiff(cutId, compare ? viewingRev : undefined, compare?.rev);
  const checks = useChecks(cutId, viewingRev);
  const peaks = usePeaks(cutId, viewingRev);

  useEffect(() => {
    if (compare && compare.rev === viewingRev) setCompare(undefined);
  }, [compare?.rev, viewingRev]);
  useEffect(() => {
    if (!compare) {
      setFlip(false);
      controller.setHearCompare(false);
    }
  }, [!!compare, controller]);
  useEffect(() => {
    const release = () => setFlip(false);
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === "v" && setFlip(false);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  const dropMarker = useCallback(
    async (tag?: NoteTag) => {
      if (!cut) return;
      const t = Math.max(0, controller.state.time - (controller.state.playing ? 250 : 0));
      try {
        const n = await api<Note>(`/api/cuts/${cut.id}/notes`, { body: { t: Math.round(t), rev: cut.rev, text: "", tag, against: compare?.rev } });
        if (!controller.state.playing) setSelectedNote(n.id);
        setTab("cues");
        push(`${tag ? `${TAGS.find((x) => x.id === tag)?.label} marker` : "Marker"} at ${tc(t)}`);
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, controller, compare?.rev, push],
  );

  const nextUnwritten = useCallback(
    (after?: string) => {
      const list = cues.filter(unwritten);
      if (!list.length) {
        setSelectedNote(undefined);
        return;
      }
      const from = after ? cues.findIndex((n) => n.id === after) : -1;
      const next = list.find((n) => cues.indexOf(n) > from && n.id !== after) ?? list.find((n) => n.id !== after);
      if (!next) return setSelectedNote(undefined);
      controller.pause();
      controller.seek(next.displayT);
      setSelectedNote(next.id);
      setTab("cues");
      setTimeout(() => composer.current?.focus(), 0);
    },
    [cues, controller],
  );

  const chooseLayer = useCallback(
    (l: { id: number; name: string; text?: string }, t: number) => {
      if (!cut) return;
      setPicker(undefined);
      setTool(undefined);
      const name = l.text ? `${l.name}` : l.name;
      setTarget({ layerId: l.id, name, measuring: true });
      setTab("cues");
      void api<{ box: NoteTarget["box"] | null }>(`/api/cuts/${cut.id}/target`, { body: { rev: cut.rev ?? cut.latest?.n, t: Math.round(t), layerId: l.id } })
        .then((r) => setTarget((cur) => (cur?.layerId === l.id ? { layerId: l.id, name, box: r.box ?? undefined } : cur)))
        .catch(() => setTarget((cur) => (cur?.layerId === l.id ? { layerId: l.id, name } : cur)));
      setTimeout(() => composer.current?.focus(), 0);
    },
    [cut],
  );

  const openPicker = useCallback(
    (at: { clientX: number; clientY: number }) => {
      if (!cut) return;
      controller.pause();
      const t = controller.state.time;
      setPicker({ x: at.clientX + 8, y: at.clientY + 8, t });
      void api<{ layers: ContextLayer[] }>(`/api/cuts/${cut.id}/context?t=${Math.round(t)}${cut.rev !== undefined ? `&rev=${cut.rev}` : ""}`)
        .then((r) => setPicker((p) => (p && p.t === t ? { ...p, layers: r.layers } : p)))
        .catch(() => setPicker((p) => (p && p.t === t ? { ...p, layers: [] } : p)));
    },
    [cut, controller],
  );

  const noteFinding = useCallback(
    async (fd: Finding) => {
      if (!cut) return;
      const tag: NoteTag | undefined = /clip|audio|music|sound|loud/i.test(fd.rule) ? "audio" : /text|caption|cta|font|copy|credit/i.test(fd.rule) ? "text" : /cut|pace|length|open|hook/i.test(fd.rule) ? "timing" : undefined;
      try {
        const n = await api<Note>(`/api/cuts/${cut.id}/notes`, { body: { t: Math.round(fd.atMs ?? controller.state.time), rev: cut.rev, text: fd.message.charAt(0).toUpperCase() + fd.message.slice(1), tag } });
        controller.pause();
        controller.seek(n.displayT);
        setSelectedNote(n.id);
        setTab("cues");
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, controller, push],
  );

  const jumpChange = useCallback(
    (dir: 1 | -1) => {
      const secs = diff ? diff.seconds.filter((x) => x.picture !== "same" || x.sound !== "same").map((x) => x.s) : (cut?.changedSegments ?? []);
      if (!secs.length) return push(compare ? `Nothing changed between r${viewingRev} and r${compare.rev}` : "Nothing changed since the previous revision");
      const now = Math.floor(controller.state.time / 1000);
      const runs = secs.filter((x, i) => i === 0 || secs[i - 1] !== x - 1);
      const next = dir > 0 ? runs.find((x) => x > now) : [...runs].reverse().find((x) => x < now);
      if (next === undefined) return push(dir > 0 ? "That was the last change" : "That was the first change");
      controller.pause();
      controller.seek(next * 1000 + 1);
    },
    [diff, cut?.changedSegments, compare, viewingRev, controller, push],
  );

  const fixNote = fix ? cues.find((n) => n.id === fix.ids[fix.i]) : undefined;
  const latestN = cut?.revisions.at(-1)?.n;

  const showFix = useCallback(
    (n: Note) => {
      if (!cut) return;
      const t = n.displayT;
      controller.pause();
      controller.seek(t);
      controller.setLoop({ in: Math.max(0, t - 1500), out: t + 1500 });
      setSelectedNote(n.id);
      const old = cut.revisions.find((r) => r.n === n.rev);
      if (old && n.rev !== latestN && (old.hasMovie || old.restorable)) setCompare((c) => ({ rev: n.rev, mode: c?.mode === "side" ? "side" : "wipe", pos: c?.pos ?? 50, src: c?.rev === n.rev ? c.src : undefined }));
      else setCompare(undefined);
      setTimeout(() => controller.play(), 120);
    },
    [cut, controller, latestN],
  );

  const startFix = useCallback(() => {
    const list = cues.filter((n) => n.status === "addressed" && n.kind === "note");
    if (!list.length) return;
    setViewRev(undefined);
    setTool(undefined);
    setFix({ ids: list.map((n) => n.id), i: 0, resolved: 0, reopened: 0, skipped: 0, replying: false });
    showFix(list[0]);
  }, [cues, showFix]);

  const endFix = useCallback(
    (f: NonNullable<typeof fix>) => {
      setFix(undefined);
      controller.pause();
      controller.setLoop(undefined);
      setCompare(undefined);
      const parts = [f.resolved && `${f.resolved} resolved`, f.reopened && `${f.reopened} reopened`, f.skipped && `${f.skipped} skipped`].filter(Boolean);
      push(parts.length ? `Checked the fixes: ${parts.join(", ")}` : "Stopped checking fixes");
    },
    [controller, push],
  );

  const advanceFix = useCallback(
    (outcome: "resolved" | "reopened" | "skipped") => {
      if (!fix) return;
      const next = { ...fix, [outcome]: fix[outcome] + 1, i: fix.i + 1, replying: false };
      if (next.i >= next.ids.length) return endFix(next);
      setFix(next);
      const n = cues.find((x) => x.id === next.ids[next.i]);
      if (n) showFix(n);
    },
    [fix, cues, endFix, showFix],
  );

  const resolveFix = useCallback(async () => {
    if (!cut || !fixNote) return;
    try {
      await api(`/api/cuts/${cut.id}/notes/${fixNote.id}`, { method: "PATCH", body: { status: "resolved" } });
      advanceFix("resolved");
    } catch (e) {
      push(e instanceof Error ? e.message : String(e), "error");
    }
  }, [cut, fixNote, advanceFix, push]);

  const reopenFix = useCallback(
    async (text: string) => {
      if (!cut || !fixNote) return;
      try {
        await api(`/api/cuts/${cut.id}/notes/${fixNote.id}/reply`, { body: { text, status: "open" } });
        advanceFix("reopened");
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, fixNote, advanceFix, push],
  );

  const seekNote = useCallback(
    (dir: 1 | -1) => {
      if (!cues.length) return;
      const t = controller.state.time;
      const next = dir > 0 ? cues.find((n) => n.displayT > t + 20) : [...cues].reverse().find((n) => n.displayT < t - 20);
      if (next) {
        controller.pause();
        controller.seek(next.displayT);
        setSelectedNote(next.id);
        setTab("cues");
      }
    },
    [cues, controller],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const inEmptyComposer = e.target instanceof HTMLTextAreaElement && e.target.dataset.composer !== undefined && !e.target.value;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && pending.length && (!typing || inEmptyComposer)) {
        e.preventDefault();
        return void removeMark({ i: pending.length - 1 });
      }
      if (typing) return;
      const k = e.key.toLowerCase();
      if (e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider" && /^(arrow|home|end|page)/.test(k)) return;
      if (e.ctrlKey && k === "enter") return void (e.preventDefault(), composer.current?.send());
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (fix && fixNote && !fix.replying) {
        const fixMap: Record<string, () => void> = {
          enter: () => void resolveFix(),
          r: () => (controller.pause(), setFix((f) => f && { ...f, replying: true })),
          arrowright: () => advanceFix("skipped"),
          escape: () => endFix(fix),
        };
        if (fixMap[k] && !e.shiftKey) {
          e.preventDefault();
          return fixMap[k]();
        }
      }
      if (k === "v") {
        e.preventDefault();
        if (e.repeat) return;
        if (!compare) return push("Pick a revision to compare first: C, or Shift-click a revision");
        return setFlip(true);
      }
      if (e.key === "?") return void (e.preventDefault(), openSettings("keyboard"));
      if (k === "tab" && (e.shiftKey || !cues.some(unwritten))) return;
      const id = e.shiftKey && /^[a-z]$/.test(k) ? `shift+${k}` : k;
      const loop = controller.state.loop;
      const map: Record<string, () => void> = {
        m: () => void dropMarker(),
        ...Object.fromEntries(TAGS.map((t) => [t.key, () => void dropMarker(t.id)])),
        "shift+m": () => controller.setMuted(!(controller.state.muted || controller.state.volume === 0)),
        t: () => (controller.pause(), setTool((x) => (x === "target" ? undefined : "target"))),
        h: () => (compare ? controller.setHearCompare(!controller.state.hearCompare) : push("Pick a revision to compare first: C, or Shift-click a revision")),
        g: () => jumpChange(1),
        "shift+g": () => jumpChange(-1),
        tab: () => nextUnwritten(cues.find((n) => n.id === selectedNote && unwritten(n))?.id),
        " ": () => controller.toggle(),
        k: () => controller.toggle(),
        j: () => controller.shuttleBack(),
        l: () => controller.shuttleForward(),
        arrowleft: () => controller.step(e.shiftKey ? -FPS : -1),
        arrowright: () => controller.step(e.shiftKey ? FPS : 1),
        ",": () => controller.step(-1),
        ".": () => controller.step(1),
        home: () => controller.seek(0),
        end: () => controller.seek(controller.state.durationMs),
        i: () => controller.setLoop({ in: controller.state.time, out: Math.max(controller.state.time + 100, loop?.out ?? controller.state.durationMs) }),
        o: () => controller.setLoop({ in: Math.min(loop?.in ?? 0, controller.state.time - 100), out: controller.state.time }),
        x: () => controller.setLoop(undefined),
        n: () => composer.current?.focus(),
        enter: () => composer.current?.focus(),
        r: () => (controller.pause(), setTool((t) => (t === "rect" ? undefined : "rect"))),
        a: () => (controller.pause(), setTool((t) => (t === "arrow" ? undefined : "arrow"))),
        d: () => (controller.pause(), setTool((t) => (t === "pen" ? undefined : "pen"))),
        p: () => (controller.pause(), setTool((t) => (t === "pin" ? undefined : "pin"))),
        escape: () =>
          liveSel
            ? setMarkSel(undefined)
            : tool
              ? setTool(undefined)
              : pending.length
                ? setPending([])
                : target
                  ? setTarget(undefined)
                  : selectedLayer !== undefined
                    ? setSelectedLayer(undefined)
                    : loop && controller.setLoop(undefined),
        delete: () => liveSel && void removeMark(liveSel),
        backspace: () => liveSel && void removeMark(liveSel),
        "[": () => seekNote(-1),
        "]": () => seekNote(1),
        s: () => setSafe((v) => !v),
        arrowup: () => controller.nudgeVolume(0.05),
        arrowdown: () => controller.nudgeVolume(-0.05),
        c: () => toggleCompare(),
        f: () => void (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen()),
      };
      const fn = map[id];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggleCompare(rev?: number, mode?: CompareMode) {
    if (!cut) return;
    if (compare && rev === undefined && mode === undefined) return setCompare(undefined);
    const current = cut.rev ?? cut.latest?.n ?? 1;
    const target = rev ?? compare?.rev ?? [...cut.revisions].reverse().find((r) => r.n < current && (r.hasMovie || r.restorable))?.n;
    if (target === undefined) return push("There is no earlier revision to compare with yet.");
    setCompare({ rev: target, mode: mode ?? compare?.mode ?? "wipe", pos: compare?.pos ?? 50, src: compare?.rev === target ? compare.src : undefined });
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      push(ok);
    } catch (e) {
      push(e instanceof Error ? e.message : String(e), "error");
    }
  };

  if (error && !cut) {
    return (
      <div className="flex h-full flex-col">
        <header className="drag flex h-12 items-center px-3">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4" />
            Library
          </Button>
        </header>
        <div className="p-8 text-red">{error}</div>
      </div>
    );
  }
  if (!cut) return <div className="drag h-12" />;

  const latest = cut.revisions.at(-1);
  const viewing = cut.rev ?? latest?.n;
  const aspect = latest
    ? (cut.revisions.find((r) => r.n === viewing)?.size ?? latest.size)
        .split("x")
        .map(Number)
        .reduce((w, h) => w / h)
    : 9 / 16;
  const duration = durationMs || cut.latest?.durationMs || 0;
  const drafts = cut.notes.filter((n) => n.status === "draft").length;
  const rangeKey = loop ? `${Math.round(loop.in)}-${Math.round(loop.out)}` : undefined;
  const noteRange = loop && rangeKey !== rangeOff && !fix ? loop : undefined;
  const pinned = new Set([viewing, compare?.rev, cut.approvedRev].filter((x): x is number => x !== undefined));
  const strip = cut.revisions.filter((r, i, all) => i >= all.length - 6 || pinned.has(r.n));

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[48px_1fr_auto]">
      <header className="drag flex items-center gap-3 pr-[150px] pl-2">
        <Button variant="ghost" onClick={onBack} className="text-dim">
          <ChevronLeft className="size-4" />
          <Mark size={18} />
        </Button>
        <div className="min-w-0 truncate" title={cut.folder !== cut.name ? `${cut.name}, ${cut.folder}` : cut.name}>
          <span className="font-semibold">{cut.name}</span>
          {cut.folder !== cut.name && <span className="ml-2.5 text-dim">{cut.folder}</span>}
        </div>
        <IconButton label="Show in Explorer" side="bottom" onClick={() => void window.slate?.reveal(cut.path)}>
          <FolderOpen />
        </IconButton>
        <div className="flex min-w-0 flex-1 justify-center px-4">{gutter < PRESENCE_MIN && <Presence cut={cut} inline />}</div>
        <div className="no-drag flex gap-0.5 rounded-lg bg-panel p-[3px]">
          {strip.map((r) => {
            const usable = r.hasMovie || r.restorable;
            return (
              <Tip key={r.n} label={usable ? `${r.author}, ${ago(r.at)}: ${r.summary}. Shift-click to compare` : `r${r.n} was not kept on disk, so it cannot be played`} side="bottom">
                <button
                  onClick={(e) => {
                    if (!usable && r.n !== latest?.n) return;
                    if (e.shiftKey) return r.n === viewing ? push(`You are already watching r${r.n}`) : toggleCompare(r.n);
                    setViewRev(r.n === latest?.n ? undefined : r.n);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold",
                    viewing === r.n ? "bg-raised text-text" : compare?.rev === r.n ? "bg-raised/60 text-soft" : "text-dim hover:text-text",
                    !usable && r.n !== latest?.n && "cursor-not-allowed text-faint hover:text-faint",
                  )}
                >
                  <i className={cn("size-1.5 rounded-full", r.authorKind === "agent" ? "bg-teal" : r.authorKind === "you" ? "bg-amber" : "bg-faint")} />r{r.n}
                  {compare && viewing === r.n && <span className="rounded bg-amber px-1 text-[10.5px] leading-[15px] text-amber-ink">A</span>}
                  {compare?.rev === r.n && <span className="rounded bg-text px-1 text-[10.5px] leading-[15px] text-ink">B</span>}
                </button>
              </Tip>
            );
          })}
        </div>
        <Menu>
          <MenuTrigger asChild>
            <Button variant={compare ? "primary" : "quiet"}>{compare ? `${compare.src ? "Comparing" : "Preparing"} r${compare.rev}` : "Compare"}</Button>
          </MenuTrigger>
          <MenuContent>
            <div className="max-h-[300px] overflow-y-auto">
              {[...cut.revisions]
                .reverse()
                .filter((r) => r.n !== viewing)
                .map((r) => (
                  <MenuItem key={r.n} disabled={!(r.hasMovie || r.restorable)} onSelect={() => toggleCompare(r.n)}>
                    <span className="min-w-0 flex-1 truncate">
                      r{r.n} by {r.author}
                    </span>
                    <span className="shrink-0 text-[12px] text-faint">{r.hasMovie || r.restorable ? ago(r.at) : "not kept"}</span>
                  </MenuItem>
                ))}
            </div>
            <MenuSeparator />
            <MenuItem onSelect={() => toggleCompare(undefined, "wipe")}>Wipe</MenuItem>
            <MenuItem onSelect={() => toggleCompare(undefined, "side")}>Side by side</MenuItem>
            <MenuItem onSelect={() => toggleCompare(undefined, "diff")}>Difference (paused)</MenuItem>
            {compare && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => setCompare(undefined)}>Stop comparing</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <Button
          variant={cut.approvedRev === viewing ? "ghost" : "quiet"}
          disabled={cut.approvedRev === viewing}
          onClick={() => void run(() => api(`/api/cuts/${cut.id}/approve`, { body: { rev: viewing } }), `Approved r${viewing}`)}
        >
          {cut.approvedRev === viewing ? `r${viewing} approved` : `Approve r${viewing}`}
        </Button>
        <ExportControl cut={cut} viewing={viewing} toast={push} />
        <IconButton label="Settings" keys="Ctrl ," side="bottom" onClick={() => openSettings("review")}>
          <Gear />
        </IconButton>
      </header>

      <div className="grid min-h-0 grid-cols-[1fr_400px]">
        <div ref={stage} className="relative flex min-h-0 min-w-0 flex-col bg-ink">
          {gutter >= PRESENCE_MIN && <Presence cut={cut} room={gutter - 16} />}
          {viewing !== latest?.n && (
            <div className="absolute top-5 right-6 z-10 flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5">
              Watching r{viewing}
              <Button size="sm" variant="primary" onClick={() => setViewRev(undefined)}>
                Back to r{latest?.n}
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1 px-6 pt-5 pb-3">
            {src ? (
              <Player
                src={src}
                controller={controller}
                aspect={aspect}
                revLabel={`r${viewing}`}
                onGutter={setGutter}
                flip={flip}
                busy={!!tool}
                compare={compare ? { src: compare.src, label: `r${compare.rev}`, mode: compare.mode, pos: compare.pos, onPos: (pos) => setCompare((c) => c && { ...c, pos }) } : undefined}
                overlay={
                  <>
                    {safe && <SafeZones />}
                    <div
                      data-frame-drop
                      className="absolute inset-0"
                      onPointerDown={(e) => e.altKey && (e.preventDefault(), openPicker(e))}
                      onDragOver={(e) => {
                        if ((!isInternal(e.dataTransfer) && !isExternal(e.dataTransfer)) || currentDrag()?.some((i) => i.folder)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        const r = e.currentTarget.getBoundingClientRect();
                        const point: [number, number] = [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
                        setDropHint({ point, item: currentDrag()?.[0] });
                      }}
                      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropHint(undefined)}
                      onDrop={(e) => {
                        if (!isInternal(e.dataTransfer) && !isExternal(e.dataTransfer)) return;
                        e.preventDefault();
                        setDropHint(undefined);
                        void dropOnFrame(e);
                      }}
                    >
                    <Sketch
                      tool={tool}
                      pending={pending}
                      shown={shown}
                      selected={liveSel}
                      onSelect={(m) => {
                        setMarkSel(m);
                        if (m && document.activeElement instanceof HTMLElement) document.activeElement.blur();
                      }}
                      onRemove={(m) => void removeMark(m)}
                      onPick={openPicker}
                      targetBox={target?.box}
                      onAdd={(a) => {
                        setPending((p) => [...p, a]);
                        composer.current?.focus();
                      }}
                    />
                    {dropHint && <DropGhost hint={dropHint} placement={dropHint.item && dropHint.item.kind !== "audio" ? placementFor(dropHint.item.aspect ?? 1, dropHint.point) : undefined} at={noteRange ? noteRange.in : time} />}
                    </div>
                  </>
                }
              />
            ) : (
              <StagePlaceholder onGutter={setGutter}>
                {viewRev !== undefined
                  ? `Preparing r${viewing}, ${cut.segments.filter((x) => x === "ready").length} of ${cut.segments.length} seconds rendered`
                  : cut.render.total
                    ? `Rendering the first seconds, ${cut.render.ready} of ${cut.render.total} ready`
                    : "Reading the project"}
              </StagePlaceholder>
            )}
          </div>
          {fix && fixNote && (
            <FixCheck
              note={fixNote}
              index={fix.i}
              total={fix.ids.length}
              latest={latestN}
              replying={fix.replying}
              onReplying={(on) => setFix((f) => f && { ...f, replying: on })}
              onResolve={() => void resolveFix()}
              onReopen={(text) => void reopenFix(text)}
              onSkip={() => advanceFix("skipped")}
              onExit={() => endFix(fix)}
              comparing={compare?.rev}
            />
          )}
          <div className="@container flex h-14 shrink-0 items-center gap-1 px-5">
            <IconButton label="Previous frame" keys="," onClick={() => controller.step(-1)}>
              <ChevronLeft />
            </IconButton>
            <IconButton label={playing ? "Pause" : "Play"} keys="Space" active={false} onClick={() => controller.toggle()} className="bg-raised text-text">
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <IconButton label="Next frame" keys="." onClick={() => controller.step(1)}>
              <ChevronRight />
            </IconButton>
            <Clock controller={controller} duration={duration} rate={rate} />
            <div className="flex-1" />
            {compare && (
              <button
                className={cn("mr-1 shrink-0 rounded-md px-2 py-1 text-[12.5px] hover:bg-raised", hearCompare ? "text-text" : "text-dim")}
                onClick={() => controller.setHearCompare(!hearCompare)}
                title="H switches which revision you hear. Hold V to flip the picture"
              >
                Hearing r{hearCompare ? compare.rev : viewing}
              </button>
            )}
            {loop && (
              <button className="mr-1 min-w-0 truncate rounded-md px-2 py-1 text-[12.5px] text-amber hover:bg-raised" onClick={() => controller.setLoop(undefined)}>
                <span className="@max-[800px]:hidden">Looping </span>
                {tc(loop.in)} to {tc(loop.out)}
              </button>
            )}
            <Menu>
              <MenuTrigger asChild>
                <button className="no-drag rounded-lg px-2.5 py-1.5 font-semibold text-soft hover:bg-raised hover:text-text">{rate}x</button>
              </MenuTrigger>
              <MenuContent>
                {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                  <MenuItem key={r} onSelect={() => controller.setRate(r)}>
                    {r}x
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <IconButton
              label={loop ? "Clear loop" : "Loop the cue range"}
              keys="I / O / X"
              active={!!loop}
              onClick={() => controller.setLoop(loop ? undefined : { in: Math.max(0, controller.state.time - 1000), out: Math.min(duration, controller.state.time + 1000) })}
            >
              <Repeat />
            </IconButton>
            <VolumeControl controller={controller} />
            <IconButton label="Phone safe zones" keys="S" active={safe} onClick={() => setSafe(!safe)}>
              <Smartphone />
            </IconButton>
            <IconButton label="Compare revisions" keys="C" active={!!compare} onClick={() => toggleCompare()}>
              <Columns2 />
            </IconButton>
            <IconButton label="Full screen" keys="F" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen())}>
              <Maximize />
            </IconButton>
          </div>
        </div>

        <aside className="flex min-h-0 flex-col bg-panel">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList>
              <Tab value="cues" count={cut.notes.filter((n) => n.status !== "resolved" && n.status !== "wontfix").length}>
                Cues
              </Tab>
              <Tab value="layers">Layers</Tab>
              <Tab value="media">Media</Tab>
              <Tab value="history" count={cut.revisions.length}>
                History
              </Tab>
            </TabsList>
            <TabsContent value="cues" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount>
              <Cues
                ref={composer}
                cut={cut}
                cues={cues}
                selected={selectedNote}
                onSelect={(id) => {
                  setSelectedNote(id);
                  const n = cues.find((x) => x.id === id);
                  if (n && Math.abs(n.displayT - controller.state.time) > 30) {
                    controller.pause();
                    controller.seek(n.displayT);
                  }
                }}
                onSeek={(ms) => {
                  controller.pause();
                  controller.seek(ms);
                }}
                now={time}
                range={noteRange}
                onDismissRange={() => setRangeOff(rangeKey)}
                tool={tool}
                onTool={(t) => {
                  if (t) controller.pause();
                  setTool(t);
                }}
                pending={pending}
                onClearPending={() => setPending([])}
                captureMarked={captureMarked}
                target={target}
                onClearTarget={() => setTarget(undefined)}
                against={compare?.rev}
                onNextUnwritten={nextUnwritten}
                onFixCheck={startFix}
                toast={push}
              />
            </TabsContent>
            <TabsContent value="layers" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <Inspector cut={cut} time={time} paused={!playing} selected={selectedItem} onEdit={(r) => void edit(r)} onNoteLayer={(l) => chooseLayer(l, controller.state.time)} />
            </TabsContent>
            <TabsContent value="media" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <MediaPanel cutId={cut.id} cueLabel={playing ? "Cue at playhead" : `Cue at ${tc(noteRange ? noteRange.in : time)}`} onCue={(it) => cueItem(it)} toast={push} />
            </TabsContent>
            <TabsContent value="history" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              {diff && (
                <div className="max-h-[45%] shrink-0 overflow-y-auto px-2">
                  <ChangeList diff={diff} onSeek={(ms) => (controller.pause(), controller.seek(ms))} />
                </div>
              )}
              <History
                cut={cut}
                viewing={viewRev}
                onView={setViewRev}
                onCompare={(n) => toggleCompare(n)}
                onRevert={(n) => void run(() => api(`/api/cuts/${cut.id}/revert`, { body: { rev: n } }), `Restoring r${n} as a new revision`)}
                onApprove={(n) => void run(() => api(`/api/cuts/${cut.id}/approve`, { body: { rev: n } }), `Approved r${n}`)}
              />
            </TabsContent>
          </Tabs>
          {drafts > 0 && tab !== "cues" && (
            <button className="mx-4 mb-4 rounded-lg bg-raised px-3 py-2 text-left text-soft hover:text-text" onClick={() => setTab("cues")}>
              {drafts} {drafts === 1 ? "draft is" : "drafts are"} waiting to be sent
            </button>
          )}
        </aside>
      </div>

      <Filmstrip
        cut={cut}
        controller={controller}
        cues={cues}
        selectedNote={selectedNote}
        onSelectNote={(id) => {
          const n = cues.find((x) => x.id === id);
          setSelectedNote(id);
          setTab("cues");
          if (n) {
            controller.pause();
            controller.seek(n.displayT);
          }
        }}
        selectedLayer={selectedLayer}
        onSelectLayer={(id) => {
          setSelectedLayer(id);
          if (id !== undefined) setTab("layers");
        }}
        onRetime={(item, start, end) => void edit({ kind: "timing", layerId: item.id, start, end })}
        diff={diff}
        checks={checks}
        peaks={peaks}
        onNoteFinding={(fd) => void noteFinding(fd)}
      />

      {picker && <LayerPicker at={picker} layers={picker.layers} onPick={(l) => chooseLayer(l, picker.t)} onClose={() => (setPicker(undefined), setTool(undefined))} />}

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex max-w-xl items-center gap-4 rounded-xl py-2.5 shadow-[0_10px_40px_rgba(0,0,0,.5)]",
              t.action ? "pointer-events-auto pr-2.5 pl-4" : "px-4",
              t.tone === "error" ? "bg-error-bg text-error-text" : "bg-raised text-text",
            )}
          >
            {t.text}
            {t.action && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  t.action!.run();
                }}
              >
                {t.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Clock({ controller, duration, rate }: { controller: PlayerController; duration: number; rate: number }) {
  const time = usePlayerSelect(controller, (s) => s.time);
  return (
    <div className="ml-3 flex shrink-0 items-baseline gap-2.5">
      <span className="text-[24px] leading-none font-semibold text-amber">{tc(time)}</span>
      <span className="whitespace-nowrap text-dim">
        frame {frameAt(time)} of {frameOf(duration)}
        {rate !== 1 && `, ${rate}x`}
      </span>
    </div>
  );
}
