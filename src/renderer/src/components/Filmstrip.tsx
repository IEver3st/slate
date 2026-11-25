import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Checks, CutDetail, Finding, Note, PairDiff, Peaks, TrackItem } from "@/lib/api";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { tagOf } from "@/lib/tags";
import { media } from "@/lib/api";
import { usePlayerSelect, type PlayerController } from "@/lib/player";
import { cn, tc } from "@/lib/format";

const LANES: { key: string; label: string; test: (i: TrackItem) => boolean }[] = [
  { key: "text", label: "Captions", test: (i) => i.type !== "Audio" && (/^(caption|title|text|close: app)/i.test(i.name) || (!!i.text && i.type !== "Video")) },
  { key: "picture", label: "Footage", test: (i) => i.type === "Video" || i.type === "Image" || /^(hook|pre-roll|flipbook|b-roll|clip)/i.test(i.name) },
  { key: "graphics", label: "Graphics", test: (i) => i.type !== "Audio" },
  { key: "sfx", label: "Effects", test: (i) => i.type === "Audio" && !/^music/i.test(i.name) && i.end - i.start < 20000 },
  { key: "music", label: "Music", test: (i) => i.type === "Audio" },
];

function laneLayout(items: TrackItem[]) {
  const taken = new Set<number>();
  return LANES.map((lane) => {
    const mine = items.filter((i) => !taken.has(i.id) && lane.test(i)).sort((a, b) => a.start - b.start);
    mine.forEach((i) => taken.add(i.id));
    const rows: TrackItem[][] = [];
    for (const it of mine) {
      const row = rows.find((r) => r[r.length - 1].end <= it.start + 1);
      if (row) row.push(it);
      else rows.push([it]);
    }
    return { ...lane, rows };
  }).filter((l) => l.rows.length);
}

const TRACKS_KEY = "slate-tracks-height";
const TRACKS_DEFAULT = 220;
const TRACKS_MIN = 64;
const PLAYER_RESERVE = 560;
const LABEL_W = 84;
const RIGHT_PAD = 20;

function readTracksHeight() {
  try {
    const v = Number(localStorage.getItem(TRACKS_KEY));
    return Number.isFinite(v) && v >= TRACKS_MIN ? v : TRACKS_DEFAULT;
  } catch {
    return TRACKS_DEFAULT;
  }
}

function saveTracksHeight(v: number | undefined) {
  try {
    if (v === undefined) localStorage.removeItem(TRACKS_KEY);
    else localStorage.setItem(TRACKS_KEY, String(Math.round(v)));
  } catch {}
}

function shortName(n: string) {
  return n.replace(/^(caption|touch|close|review|hook|pre-roll): /i, "").replace(/ \(real app[^)]*\)/i, "");
}

const Thumb = memo(function Thumb({ cutId, s, rev, ready, version }: { cutId: string; s: number; rev?: number; ready: boolean; version: string }) {
  const [failed, setFailed] = useState<string>();
  const src = ready && rev !== undefined ? media(`/api/cuts/${cutId}/thumb?s=${s}&rev=${rev}&v=${version}-t240`) : undefined;
  if (!src || failed === src) return null;
  return <img src={src} loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" draggable={false} onError={() => setFailed(src)} />;
});

export const Filmstrip = memo(function Filmstrip({
  cut,
  controller,
  cues,
  selectedNote,
  onSelectNote,
  onMoveNote,
  selectedLayer,
  onSelectLayer,
  onRetime,
  diff,
  checks,
  peaks,
  onNoteFinding,
}: {
  cut: CutDetail;
  controller: PlayerController;
  cues: Note[];
  selectedNote?: string;
  onSelectNote: (id: string) => void;
  onMoveNote?: (id: string, ms: number) => void;
  selectedLayer?: number;
  onSelectLayer: (id: number | undefined) => void;
  onRetime: (item: TrackItem, start: number, end: number) => void;
  diff?: PairDiff;
  checks?: Checks;
  peaks?: Peaks;
  onNoteFinding: (f: Finding) => void;
}) {
  const loop = usePlayerSelect(controller, (s) => s.loop);
  const rev = cut.revisions.find((r) => r.n === cut.rev);
  const duration = rev?.durationMs ?? cut.latest?.durationMs ?? 1;
  const seconds = cut.segments.length || Math.ceil(duration / 1000);
  const { changed, maybe, soundOnly, stale } = useMemo(() => {
    const ch = new Set(
      diff
        ? diff.seconds.filter((x) => x.picture === "changed" || x.sound === "changed" || x.picture === "only").map((x) => x.s)
        : cut.changedSegments.length === seconds && cut.rev === cut.revisions[0]?.n
          ? []
          : cut.changedSegments,
    );
    const mb = new Set(diff ? diff.seconds.filter((x) => !ch.has(x.s) && (x.picture === "maybe" || x.sound === "maybe")).map((x) => x.s) : []);
    const so = new Set(diff ? diff.seconds.filter((x) => x.sound === "changed" && x.picture === "same").map((x) => x.s) : []);
    const st = new Set(cut.movie && cut.movie.rev === cut.rev ? cut.movie.stale : []);
    return { changed: ch, maybe: mb, soundOnly: so, stale: st };
  }, [diff, cut.changedSegments, cut.rev, cut.revisions, cut.movie, seconds]);

  const lanes = useMemo(() => laneLayout(cut.timeline), [cut.timeline]);
  const scroller = useRef<HTMLDivElement>(null);
  const tracksInner = useRef<HTMLDivElement>(null);
  const waveInner = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(1100);
  const [zoom, setZoom] = useState(1);

  const syncScrollX = () => {
    const sl = scroller.current?.scrollLeft ?? 0;
    const tx = sl ? `translate3d(${-sl}px, 0, 0)` : "";
    if (tracksInner.current) tracksInner.current.style.transform = tx;
    if (waveInner.current) waveInner.current.style.transform = tx;
  };

  useEffect(() => {
    setZoom(1);
    if (scroller.current) scroller.current.scrollLeft = 0;
    syncScrollX();
  }, [cut.id]);

  useEffect(() => {
    if (zoom === 1 && scroller.current) scroller.current.scrollLeft = 0;
    syncScrollX();
  }, [zoom, viewportW]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewportW(Math.max(200, el.clientWidth - RIGHT_PAD));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const contentW = Math.round(viewportW * zoom);

  const tracks = useRef<HTMLDivElement>(null);
  const [tracksMax, setTracksMax] = useState(readTracksHeight);
  const [more, setMore] = useState(false);
  const measureMore = () => {
    const el = tracks.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  useEffect(() => {
    const el = tracks.current;
    if (!el) return;
    const ro = new ResizeObserver(measureMore);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const box = tracks.current;
    if (!box || selectedLayer === undefined) return;
    const el = box.querySelector<HTMLElement>(`[data-layer="${selectedLayer}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop) box.scrollTop = top - 4;
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight + 4;
  }, [selectedLayer]);

  const resizeTracks = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = tracks.current?.clientHeight ?? tracksMax;
    const full = tracks.current?.scrollHeight ?? Infinity;
    const limit = () => Math.max(TRACKS_MIN, Math.min(full, window.innerHeight - PLAYER_RESERVE));
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = Math.max(TRACKS_MIN, Math.min(limit(), h0 + y0 - ev.clientY));
      setTracksMax(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      saveTracksHeight(h);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const [drag, setDrag] = useState<{ id: number; start: number; end: number }>();
  const [pinDrag, setPinDrag] = useState<{ id: string; ms: number }>();
  const [hoveredPin, setHoveredPin] = useState<string>();
  const [hoverScrub, setHoverScrub] = useState<{ ms: number; x: number; viewX: number }>();
  const [scrubbing, setScrubbing] = useState(false);
  const prevStates = useRef<string[]>([]);
  const [landed, setLanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const prev = prevStates.current;
    const fresh = new Set<number>();
    cut.segments.forEach((st, i) => {
      if (st === "ready" && prev[i] && prev[i] !== "ready") fresh.add(i);
    });
    prevStates.current = cut.segments;
    if (fresh.size) {
      setLanded(fresh);
      const t = setTimeout(() => setLanded(new Set()), 1000);
      return () => clearTimeout(t);
    }
  }, [cut.segments]);

  const pct = (ms: number) => `${(ms / duration) * 100}%`;
  const msAt = (clientX: number) => {
    const r = area.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const applyZoom = (nextZoom: number, anchorClientX?: number) => {
    const clamped = Math.max(1, Math.min(8, Math.round(nextZoom * 100) / 100));
    const el = scroller.current;
    if (!el) return setZoom(clamped);
    const rect = el.getBoundingClientRect();
    const anchorX = anchorClientX !== undefined ? anchorClientX - rect.left : viewportW / 2;
    const ratio = (el.scrollLeft + anchorX) / Math.max(1, contentW);
    setZoom(clamped);
    requestAnimationFrame(() => {
      if (!scroller.current) return;
      const newW = Math.round(viewportW * clamped);
      scroller.current.scrollLeft = Math.max(0, ratio * newW - anchorX);
      syncScrollX();
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      const next = zoom * factor;
      applyZoom(next < 1.06 ? 1 : next, e.clientX);
    } else if (zoom > 1 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) && scroller.current) {
      e.preventDefault();
      scroller.current.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX;
      syncScrollX();
    }
  };

  const scrub = (e: React.PointerEvent, firstMs?: number) => {
    if (e.button !== 0) return;
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    if (firstMs === undefined && (e.clientX < r.left - 6 || e.clientX > r.right + 20)) return;
    e.preventDefault();
    const wasPlaying = controller.state.playing;
    controller.pause();
    controller.seek(firstMs ?? msAt(e.clientX));
    setScrubbing(true);
    setHoverScrub(undefined);
    const move = (ev: PointerEvent) => controller.seek(msAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setScrubbing(false);
      if (wasPlaying) controller.play();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const grab = (e: React.PointerEvent, item: TrackItem, edge: "move" | "start" | "end") => {
    e.stopPropagation();
    if (selectedLayer !== item.id || !item.editable.timing) {
      onSelectLayer(item.id);
      scrub(e, Math.max(item.start, Math.min(item.end - 1, msAt(e.clientX))));
      return;
    }
    const x0 = e.clientX;
    const r = area.current!.getBoundingClientRect();
    const frame = 1000 / 60;
    let cur = { id: item.id, start: item.start, end: item.end };
    const move = (ev: PointerEvent) => {
      const d = Math.round((((ev.clientX - x0) / r.width) * duration) / frame) * frame;
      if (edge === "move") cur = { id: item.id, start: Math.max(0, item.start + d), end: Math.max(0, item.start + d) + (item.end - item.start) };
      else if (edge === "start") cur = { ...cur, start: Math.max(0, Math.min(item.end - frame, item.start + d)) };
      else cur = { ...cur, end: Math.max(item.start + frame, item.end + d) };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(undefined);
      if (Math.abs(cur.start - item.start) >= 1 || Math.abs(cur.end - item.end) >= 1) onRetime(item, Math.round(cur.start), Math.round(cur.end));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const grabPin = (e: React.PointerEvent, n: Note) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    let lastMs = n.displayT;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      if (!onMoveNote || n.kind === "edit") return;
      moved = true;
      setHoveredPin(undefined);
      lastMs = Math.round(msAt(ev.clientX));
      setPinDrag({ id: n.id, ms: lastMs });
      controller.pause();
      controller.seek(lastMs);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPinDrag(undefined);
      if (moved && onMoveNote && Math.abs(lastMs - n.displayT) >= 15) onMoveNote(n.id, lastMs);
      else if (!moved) onSelectNote(n.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cellState = (s: number) => {
    const st = cut.segments[s];
    if (st === "rendering") return "rendering-cell";
    if (st === "queued") return "bg-raised";
    if (st === "failed") return "bg-red/70";
    if (st === "missing") return "bg-transparent";
    if (stale.has(s)) return "bg-faint/50";
    return changed.has(s) ? "bg-amber" : maybe.has(s) ? "bg-amber/40" : "bg-line";
  };

  const rule = (e: React.PointerEvent) => {
    if (e.button !== 0 || !e.shiftKey) return;
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const t0 = msAt(x0);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      const t = msAt(ev.clientX);
      controller.setLoop({ in: Math.min(t0, t), out: Math.max(t0, t) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        controller.pause();
        controller.seek(t0);
      } else {
        const l = controller.state.loop;
        if (l) controller.seek(l.in);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHoverStrip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing || drag || pinDrag) return;
    const r = area.current?.getBoundingClientRect();
    const sr = scroller.current?.getBoundingClientRect();
    if (!r || !sr || e.clientX < r.left || e.clientX > r.right) return setHoverScrub(undefined);
    const ms = Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
    setHoverScrub({ ms, x: e.clientX - r.left, viewX: e.clientX - sr.left });
  };

  const timed = checks?.findings.filter((f) => f.atMs !== undefined) ?? [];
  const general = checks?.findings.filter((f) => f.atMs === undefined) ?? [];
  const showChecks = !!checks && (checks.lint !== "missing" || checks.findings.length > 0);
  const hasPeaks = !!peaks?.seconds.some(Boolean);
  const version = `${cut.rev}-${cut.movie?.key ?? ""}`;
  const hoverSec = hoverScrub ? Math.min(seconds - 1, Math.floor(hoverScrub.ms / 1000)) : undefined;
  const hoverThumb = hoverSec !== undefined && cut.segments[hoverSec] === "ready" && cut.rev !== undefined ? media(`/api/cuts/${cut.id}/thumb?s=${hoverSec}&rev=${cut.rev}&v=${version}-t240&size=poster`) : undefined;
  const hoveredNote = hoveredPin && !pinDrag && !scrubbing ? cues.find((n) => n.id === hoveredPin) : undefined;
  const rulerStep = useMemo(() => {
    const pxPerSec = contentW / Math.max(1, seconds);
    if (pxPerSec >= 26) return 1;
    if (pxPerSec >= 13) return 2;
    if (pxPerSec >= 6) return 5;
    return 10;
  }, [contentW, seconds]);

  return (
    <div
      className="group/strip relative grid shrink-0 touch-none select-none bg-well pt-2 pb-3"
      style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)` }}
      onWheel={onWheel}
      onPointerDown={(e) => scrub(e)}
    >
      <div
        className="group/resize absolute inset-x-0 -top-1 z-20 flex h-2 cursor-row-resize justify-center"
        title="Drag to resize the tracks, double-click to reset"
        onPointerDown={resizeTracks}
        onDoubleClick={() => (setTracksMax(TRACKS_DEFAULT), saveTracksHeight(undefined))}
      >
        <i className="mt-[3px] h-0.5 w-10 rounded-full bg-line opacity-0 transition-opacity group-hover/resize:opacity-100" />
      </div>

      {/* Left labels gutter */}
      <div className="flex flex-col">
        <div className="flex h-[22px] items-center pl-4">
          {(seconds >= 12 || zoom > 1) && (
            <div
              className={cn("flex items-center gap-0.5 rounded-md bg-panel/80 px-1 py-0.5 text-[11px] text-dim transition-opacity", zoom > 1 ? "opacity-100" : "opacity-0 group-hover/strip:opacity-100")}
              onPointerDown={(e) => e.stopPropagation()}
              title="Timeline zoom (Ctrl + scroll)"
            >
              <button onClick={() => applyZoom(zoom / 1.4)} disabled={zoom <= 1} className="grid size-4 place-items-center rounded hover:bg-hover hover:text-text disabled:opacity-40" aria-label="Zoom out timeline">
                <Minus className="size-2.5" />
              </button>
              <button onClick={() => applyZoom(1)} className="px-1 font-semibold tabular-nums hover:text-amber" title="Reset timeline zoom">
                {zoom === 1 ? "Fit" : `${zoom.toFixed(1)}x`}
              </button>
              <button onClick={() => applyZoom(zoom * 1.4)} disabled={zoom >= 8} className="grid size-4 place-items-center rounded hover:bg-hover hover:text-text disabled:opacity-40" aria-label="Zoom in timeline">
                <Plus className="size-2.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex h-2 items-center pl-5 text-[12px] text-dim">Render</div>
        <div className="mt-1.5 h-[clamp(52px,9vh,104px)]" />
        {showChecks && (
          <div className="mt-2 flex h-4 items-start pt-[1px] pl-5 text-[12px] text-dim">
            {general.length ? (
              <Menu>
                <MenuTrigger asChild>
                  <button className="text-left hover:text-text" onPointerDown={(e) => e.stopPropagation()}>
                    Checks <span className="text-amber">+{general.length}</span>
                  </button>
                </MenuTrigger>
                <MenuContent>
                  {general.map((g, i) => (
                    <MenuItem key={i} onSelect={() => onNoteFinding(g)}>
                      <FindingLine f={g} />
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : (
              <span title={checks!.lint === "running" ? "Checking this revision" : checks!.lint === "missing" ? "cutlint is not installed, only the sound is checked" : undefined}>Checks</span>
            )}
          </div>
        )}
      </div>

      {/* Scrollable zoomable timeline canvas */}
      <div
        ref={scroller}
        className={cn("relative min-w-0", zoom > 1 ? "overflow-x-auto" : "overflow-x-hidden")}
        onScroll={syncScrollX}
        onPointerMove={onHoverStrip}
        onPointerLeave={() => setHoverScrub(undefined)}
      >
        <div className="relative" style={{ width: contentW, marginRight: RIGHT_PAD }}>
          {/* Ruler */}
          <div className="relative h-[22px] cursor-ew-resize" onPointerDown={rule} title="Click or drag to scrub. Shift-drag to loop a range. Ctrl-scroll to zoom">
            {Array.from({ length: seconds }, (_, s) =>
              s % rulerStep === 0 || changed.has(s) ? (
                <span key={s} className={cn("absolute top-0.5 text-[12px] font-semibold", changed.has(s) ? "text-amber" : "text-faint")} style={{ left: `calc(${pct(s * 1000)} + 4px)` }}>
                  {String(s).padStart(2, "0")}
                </span>
              ) : null,
            )}
          </div>

          {/* Render cells */}
          <div className="grid h-2 cursor-ew-resize gap-[3px] py-px" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
            {Array.from({ length: seconds }, (_, s) => (
              <i key={s} className={cn("rounded-[2px] transition-colors duration-200", cellState(s), cut.segments[s] === "missing" && "outline outline-1 -outline-offset-1 outline-line")} />
            ))}
          </div>

          {/* Thumbnail strip */}
          <div ref={area} className="relative mt-1.5 grid h-[clamp(52px,9vh,104px)] cursor-ew-resize gap-[3px]" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
            {Array.from({ length: seconds }, (_, s) => (
              <div key={s} className={cn("relative overflow-hidden rounded-[3px] bg-panel", landed.has(s) && "landed")}>
                <Thumb cutId={cut.id} s={s} rev={cut.rev} ready={cut.segments[s] === "ready"} version={version} />
                {changed.has(s) && <div className={cn("pointer-events-none absolute inset-0 z-[1] rounded-[3px]", soundOnly.has(s) ? "shadow-[inset_0_-3px_0_var(--color-teal)]" : "shadow-[inset_0_0_0_2px_var(--color-amber)]")} />}
                {maybe.has(s) && <div className="pointer-events-none absolute inset-0 z-[1] rounded-[3px] shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-amber)_45%,transparent)]" style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--color-amber) 22%, transparent) 6px 8px)" }} />}
              </div>
            ))}
            {loop && <div className="pointer-events-none absolute inset-y-0 bg-amber/12 shadow-[inset_2px_0_0_var(--color-amber),inset_-2px_0_0_var(--color-amber)]" style={{ left: pct(loop.in), width: pct(loop.out - loop.in) }} />}
            {/* Ghost hover line */}
            {hoverScrub && !scrubbing && (
              <div className="pointer-events-none absolute inset-y-0 z-[2] w-px bg-playhead/45" style={{ left: hoverScrub.x }} />
            )}
          </div>

          {/* Checks row */}
          {showChecks && (
            <div className="relative mt-2 mb-[3px] h-4">
              {checks!.lint === "running" && timed.length === 0 && <span className="absolute top-0 left-0 text-[11px] leading-4 text-faint">Checking</span>}
              {checks!.lint !== "running" && timed.length === 0 && <span className="absolute top-0 left-0 text-[11px] leading-4 text-faint">Nothing flagged</span>}
              {timed.map((fd, i) => (
                <Menu key={i}>
                  <MenuTrigger asChild>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      title={fd.message}
                      aria-label={fd.message}
                      className={cn(
                        "absolute top-0.5 size-3 -translate-x-1/2 rotate-45 rounded-[2px] transition-transform hover:scale-125",
                        fd.level === "error" ? "bg-red" : fd.level === "warning" ? "bg-amber" : "bg-faint",
                      )}
                      style={{ left: pct(fd.atMs!) }}
                    />
                  </MenuTrigger>
                  <MenuContent>
                    <div className="max-w-[320px] px-2.5 pt-2 pb-1.5">
                      <FindingLine f={fd} />
                    </div>
                    <MenuSeparator />
                    <MenuItem onSelect={() => (controller.pause(), controller.seek(fd.atMs!))}>Go to {tc(fd.atMs!)}</MenuItem>
                    <MenuItem onSelect={() => onNoteFinding(fd)}>Note this</MenuItem>
                  </MenuContent>
                </Menu>
              ))}
            </div>
          )}

          {/* Cue range bars + Cue pins */}
          <div className="pointer-events-none absolute inset-y-0 right-0 left-0">
            {cues
              .filter((n) => n.end !== undefined && n.end > n.t)
              .map((n) => (
                <div key={`r${n.id}`} className="absolute top-[36px] h-[6px] rounded-full bg-amber/45" style={{ left: pct(n.displayT), width: pct(n.end! - n.t) }} />
              ))}
            {cues.map((n, i) => {
              const draggingThis = pinDrag?.id === n.id;
              const tShown = draggingThis ? pinDrag.ms : n.displayT;
              return (
                <button
                  key={n.id}
                  onPointerDown={(e) => grabPin(e, n)}
                  onPointerEnter={() => setHoveredPin(n.id)}
                  onPointerLeave={() => setHoveredPin((p) => (p === n.id ? undefined : p))}
                  className={cn(
                    "pin-pop pointer-events-auto absolute top-[30px] grid size-[18px] -translate-x-1/2 place-items-center rounded-full text-[10.5px] font-bold transition-transform duration-150 hover:scale-120",
                    n.status === "draft" ? "bg-well text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]" : n.status === "resolved" || n.status === "addressed" || n.status === "wontfix" ? "bg-raised text-soft" : "bg-amber text-amber-ink",
                    selectedNote === n.id && "scale-115 ring-2 ring-playhead",
                    draggingThis && "scale-125 cursor-grabbing ring-2 ring-amber",
                    onMoveNote && n.kind !== "edit" && !draggingThis && "cursor-grab",
                  )}
                  style={{ left: pct(tShown) }}
                  title={onMoveNote && n.kind !== "edit" ? "Click to open, drag to retime" : n.text || tagOf(n.tag)?.sentence || "Marker"}
                >
                  {i + 1}
                  {n.tag && <i className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-well", tagOf(n.tag)?.dot)} />}
                  {draggingThis && (
                    <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-amber px-1.5 py-0.5 text-[10.5px] font-bold text-amber-ink tabular-nums shadow">
                      {tc(tShown)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hover-scrub thumbnail preview card (unclipped above strip) */}
      {hoverScrub && !scrubbing && !hoveredNote && hoverThumb && (
        <div
          className="hover-preview pointer-events-none absolute bottom-[calc(100%+4px)] z-30 -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-raised p-1 shadow-pop"
          style={{ left: LABEL_W + Math.max(66, Math.min(viewportW - 66, hoverScrub.viewX)) }}
        >
          <img src={hoverThumb} alt="" className="h-[78px] w-auto max-w-[144px] rounded-[5px] bg-black object-contain" draggable={false} />
          <div className="mt-0.5 text-center text-[11px] font-semibold text-amber tabular-nums">{tc(hoverScrub.ms)}</div>
        </div>
      )}

      {/* Hovered cue pin mini-card (unclipped above strip) */}
      {hoveredNote && (
        <div
          className="hover-preview pointer-events-none absolute bottom-[calc(100%+4px)] z-30 w-[236px] -translate-x-1/2 rounded-xl border border-line bg-raised/95 p-2.5 text-left shadow-pop backdrop-blur-md"
          style={{ left: LABEL_W + Math.max(120, Math.min(viewportW - 120, (hoveredNote.displayT / duration) * contentW - (scroller.current?.scrollLeft ?? 0))) }}
        >
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <span className="font-bold text-amber">#{cues.indexOf(hoveredNote) + 1}</span>
            <span className="font-semibold text-soft tabular-nums">{tc(hoveredNote.displayT)}</span>
            {hoveredNote.tag && <span className={cn("rounded px-1.5 py-px text-[10.5px] font-semibold", tagOf(hoveredNote.tag)?.chip)}>{tagOf(hoveredNote.tag)?.label}</span>}
          </div>
          <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-text">
            {hoveredNote.text || tagOf(hoveredNote.tag)?.sentence || "Marker, not written yet"}
          </div>
        </div>
      )}

      {/* Full-height GPU-composited Playhead spanning ruler, thumbnails, checks, tracks, and waveform */}
      <div className="pointer-events-none absolute top-2 bottom-3 z-20" style={{ left: LABEL_W, width: viewportW }}>
        <Playhead controller={controller} duration={duration} contentW={contentW} viewportW={viewportW} scroller={scroller} zoom={zoom} scrubbing={scrubbing} />
      </div>

      {/* Tracks — locked 1:1 horizontally with zoomed timeline via syncScrollX */}
      <div
        ref={tracks}
        className="col-span-2 mt-1 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        style={{
          maxHeight: `max(${TRACKS_MIN}px, min(${tracksMax}px, 100vh - ${PLAYER_RESERVE}px))`,
          maskImage: more ? "linear-gradient(to bottom, black calc(100% - 28px), transparent)" : undefined,
        }}
        onScroll={measureMore}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && e.nativeEvent.offsetX >= e.currentTarget.clientWidth) e.stopPropagation();
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr) 10px` }}>
          <div>
            {lanes.map((lane) => (
              <div key={lane.key} className="mb-[3px] flex items-start pt-[3px] pl-5 text-[12px] text-dim" style={{ height: lane.rows.length * 19 - 3 }}>
                {lane.label}
              </div>
            ))}
          </div>
          <div className="overflow-hidden">
            <div ref={tracksInner} style={{ width: contentW }}>
              {lanes.map((lane) => (
                <div key={lane.key} className="relative mb-[3px] cursor-ew-resize" style={{ height: lane.rows.length * 19 - 3 }}>
                  {lane.rows.map((row, ri) =>
                    row.map((it) => {
                      const d = drag?.id === it.id ? drag : undefined;
                      const start = d?.start ?? it.start;
                      const end = d?.end ?? it.end;
                      const sel = selectedLayer === it.id;
                      const label = shortName(it.name);
                      const roomy = ((end - start) / duration) * contentW >= 40;
                      return (
                        <div
                          key={it.id}
                          data-layer={it.id}
                          onPointerDown={(e) => grab(e, it, "move")}
                          title={`${it.name}\n${tc(start)} to ${tc(end)}`}
                          className={cn(
                            "absolute flex h-4 items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] leading-none whitespace-nowrap transition-[filter,box-shadow] duration-100 hover:brightness-110",
                            lane.key === "text" ? "bg-text text-ink" : lane.key === "picture" ? "bg-lane-picture text-lane-picture-text" : lane.key === "graphics" ? "bg-lane-graphics text-soft" : "bg-lane-other text-dim",
                            it.hidden && "opacity-40",
                            sel && "shadow-[0_0_0_2px_var(--color-amber)]",
                            sel && it.editable.timing ? "cursor-grab" : "cursor-pointer",
                          )}
                          style={{ left: pct(start), width: pct(end - start), top: ri * 19 }}
                        >
                          {roomy && <span className="truncate leading-[14px]">{label}</span>}
                          {sel && it.editable.timing && (
                            <>
                              <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-amber" onPointerDown={(e) => grab(e, it, "start")} />
                              <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-amber" onPointerDown={(e) => grab(e, it, "end")} />
                            </>
                          )}
                        </div>
                      );
                    }),
                  )}
                </div>
              ))}
            </div>
          </div>
          <div />
        </div>
      </div>

      {/* Audio Waveform — locked 1:1 horizontally with zoomed timeline */}
      {hasPeaks && (
        <div className="col-span-2 grid" style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr) ${RIGHT_PAD}px` }}>
          <div className="flex items-start pl-5 text-[12px] text-dim">Mix</div>
          <div className="overflow-hidden">
            <div ref={waveInner} style={{ width: contentW }}>
              <Waveform peaks={peaks!} duration={duration} width={contentW} />
            </div>
          </div>
          <div />
        </div>
      )}
    </div>
  );
});

/** GPU-composited playhead updated directly via ref — ZERO React renders during 60fps playback! */
function Playhead({
  controller,
  duration,
  contentW,
  viewportW,
  scroller,
  zoom,
  scrubbing,
}: {
  controller: PlayerController;
  duration: number;
  contentW: number;
  viewportW: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  scrubbing: boolean;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const sync = () => {
      const t = controller.state.time;
      const frac = Math.max(0, Math.min(1, t / Math.max(1, duration)));
      const absPx = frac * contentW;
      const el = scroller.current;
      if (zoom > 1 && controller.state.playing && el) {
        const margin = el.clientWidth * 0.15;
        if (absPx < el.scrollLeft + margin || absPx > el.scrollLeft + el.clientWidth - margin) {
          el.scrollLeft = Math.max(0, absPx - el.clientWidth * 0.35);
        }
      }
      const sl = el?.scrollLeft ?? 0;
      const viewPx = absPx - sl;
      if (lineRef.current) {
        const visible = viewPx >= -2 && viewPx <= viewportW + 2;
        lineRef.current.style.opacity = visible ? "1" : "0";
        lineRef.current.style.transform = `translate3d(${viewPx.toFixed(2)}px, 0, 0)`;
      }
      if (badgeRef.current) {
        badgeRef.current.textContent = tc(t);
        const nearRight = viewPx > viewportW - 76;
        badgeRef.current.style.left = nearRight ? "auto" : "9px";
        badgeRef.current.style.right = nearRight ? "9px" : "auto";
      }
    };
    sync();
    const unsub = controller.subscribe(sync);
    const el = scroller.current;
    el?.addEventListener("scroll", sync, { passive: true });
    return () => {
      unsub();
      el?.removeEventListener("scroll", sync);
    };
  }, [controller, duration, contentW, viewportW, scroller, zoom]);

  return (
    <div ref={lineRef} className="absolute inset-y-0 left-0 w-0.5 bg-playhead shadow-[0_0_6px_rgba(255,255,255,.35),0_0_0_1px_rgba(0,0,0,.35)] will-change-transform">
      <div className="pointer-events-auto absolute -top-1.5 left-1/2 h-[18px] w-[11px] -translate-x-1/2 cursor-ew-resize rounded-[3px] bg-playhead shadow-[0_0_0_1px_rgba(0,0,0,.35)]" />
      <span
        ref={badgeRef}
        className={cn(
          "absolute -top-1.5 rounded-[4px] bg-playhead px-1.5 text-[11.5px] leading-[18px] font-semibold text-ink tabular-nums shadow-[0_0_0_1px_rgba(0,0,0,.35)] transition-opacity duration-100",
          scrubbing ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
    </div>
  );
}

function FindingLine({ f }: { f: Finding }) {
  return (
    <span className="grid gap-0.5 text-[12.5px]">
      <span className={cn("font-semibold", f.level === "error" ? "text-red" : f.level === "warning" ? "text-amber" : "text-dim")}>
        {f.rule}
        {f.level === "allowed" && <span className="font-normal text-dim">, allowed by the agent</span>}
      </span>
      <span className="text-soft">{f.message}</span>
    </span>
  );
}

function Waveform({ peaks, duration, width }: { peaks: Peaks; duration: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 18;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = getComputedStyle(c).color;
    const perSec = (1000 / duration) * width;
    peaks.seconds.forEach((bins, s) => {
      if (!bins) return;
      const bw = perSec / bins.length;
      bins.forEach((v, i) => {
        const amp = (v / 255) * (h - 2);
        ctx.fillRect(s * perSec + i * bw, (h - amp) / 2, Math.max(1, bw - 0.6), Math.max(1, amp));
      });
    });
  }, [peaks, duration, width]);
  return <canvas ref={ref} aria-hidden className="mb-[3px] h-[18px] w-full text-teal/70" />;
}
