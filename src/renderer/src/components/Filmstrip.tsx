import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Checks, CutDetail, Finding, Note, PairDiff, Peaks, TrackItem } from "@/lib/api";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { tagOf } from "@/lib/tags";
import { mediaUrl } from "@/lib/api";
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
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!ready) return;
    if (rev === undefined) return;
    void mediaUrl(`/api/cuts/${cutId}/thumb?s=${s}&rev=${rev}&v=${version}-t240`).then(setSrc);
  }, [cutId, s, rev, ready, version]);
  return src ? <img src={src} className="absolute inset-0 size-full object-cover" draggable={false} onError={() => setSrc(undefined)} /> : null;
});

export function Filmstrip({
  cut,
  controller,
  cues,
  selectedNote,
  onSelectNote,
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
  const changed = new Set(diff ? diff.seconds.filter((x) => x.picture === "changed" || x.sound === "changed" || x.picture === "only").map((x) => x.s) : cut.changedSegments.length === seconds && cut.rev === cut.revisions[0]?.n ? [] : cut.changedSegments);
  const maybe = new Set(diff ? diff.seconds.filter((x) => !changed.has(x.s) && (x.picture === "maybe" || x.sound === "maybe")).map((x) => x.s) : []);
  const soundOnly = new Set(diff ? diff.seconds.filter((x) => x.sound === "changed" && x.picture === "same").map((x) => x.s) : []);
  const stale = new Set(cut.movie && cut.movie.rev === cut.rev ? cut.movie.stale : []);
  const lanes = useMemo(() => laneLayout(cut.timeline), [cut.timeline]);
  const area = useRef<HTMLDivElement>(null);
  const [areaW, setAreaW] = useState(1200);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  const scrub = (e: React.PointerEvent, firstMs?: number) => {
    if (e.button !== 0) return;
    const r = area.current!.getBoundingClientRect();
    if (firstMs === undefined && (e.clientX < r.left - 6 || e.clientX > r.right + 20)) return;
    e.preventDefault();
    const wasPlaying = controller.state.playing;
    controller.pause();
    controller.seek(firstMs ?? msAt(e.clientX));
    setScrubbing(true);
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
    if (e.button !== 0) return;
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

  const timed = checks?.findings.filter((f) => f.atMs !== undefined) ?? [];
  const general = checks?.findings.filter((f) => f.atMs === undefined) ?? [];
  const showChecks = !!checks && (checks.lint !== "missing" || checks.findings.length > 0);
  const hasPeaks = !!peaks?.seconds.some(Boolean);

  const version = `${cut.rev}-${cut.movie?.key ?? ""}`;
  const labelW = 84;

  return (
    <div className="relative grid shrink-0 touch-none select-none bg-well pt-2 pb-3" style={{ gridTemplateColumns: `${labelW}px 1fr 20px` }} onPointerDown={(e) => scrub(e)}>
      <div
        className="group/resize absolute inset-x-0 -top-1 z-20 flex h-2 cursor-row-resize justify-center"
        title="Drag to resize the tracks, double-click to reset"
        onPointerDown={resizeTracks}
        onDoubleClick={() => (setTracksMax(TRACKS_DEFAULT), saveTracksHeight(undefined))}
      >
        <i className="mt-[3px] h-0.5 w-10 rounded-full bg-line opacity-0 transition-opacity group-hover/resize:opacity-100" />
      </div>
      <div />
      <div className="relative h-[22px] cursor-text" onPointerDown={rule} title="Click to jump, drag to mark a range">
        {Array.from({ length: seconds }, (_, s) => (
          <span key={s} className={cn("absolute top-0.5 text-[12px] font-semibold", changed.has(s) ? "text-amber" : "text-faint")} style={{ left: `calc(${pct(s * 1000)} + 4px)` }}>
            {String(s).padStart(2, "0")}
          </span>
        ))}
      </div>
      <div />

      <div className="flex items-center pl-5 text-[12px] text-dim">Render</div>
      <div className="grid h-2 cursor-ew-resize gap-[3px] py-px" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
        {Array.from({ length: seconds }, (_, s) => (
          <i key={s} className={cn("rounded-[2px]", cellState(s), cut.segments[s] === "missing" && "outline outline-1 -outline-offset-1 outline-line")} />
        ))}
      </div>
      <div />

      <div />
      <div ref={area} className="relative mt-1.5 grid h-[clamp(52px,9vh,104px)] cursor-ew-resize gap-[3px]" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
        {Array.from({ length: seconds }, (_, s) => (
          <div key={s} className={cn("relative overflow-hidden rounded-[3px] bg-panel", landed.has(s) && "landed")}>
            <Thumb cutId={cut.id} s={s} rev={cut.rev} ready={cut.segments[s] === "ready"} version={version} />
            {changed.has(s) && <div className={cn("pointer-events-none absolute inset-0 z-[1] rounded-[3px]", soundOnly.has(s) ? "shadow-[inset_0_-3px_0_var(--color-teal)]" : "shadow-[inset_0_0_0_2px_var(--color-amber)]")} />}
            {maybe.has(s) && <div className="pointer-events-none absolute inset-0 z-[1] rounded-[3px] shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-amber)_45%,transparent)]" style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--color-amber) 22%, transparent) 6px 8px)" }} />}
          </div>
        ))}
        {loop && <div className="pointer-events-none absolute inset-y-0 bg-amber/10 shadow-[inset_2px_0_0_var(--color-amber),inset_-2px_0_0_var(--color-amber)]" style={{ left: pct(loop.in), width: pct(loop.out - loop.in) }} />}
      </div>
      <div />

      <div className="col-span-3 mt-2 grid" style={{ gridTemplateColumns: `${labelW}px 1fr 20px` }}>
        {showChecks && (
          <div className="contents">
            <div className="flex items-start pt-[1px] pl-5 text-[12px] text-dim">
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
            <div className="relative mb-[3px] h-4">
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
                        "absolute top-0.5 size-3 -translate-x-1/2 rotate-45 rounded-[2px]",
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
            <div />
          </div>
        )}
      </div>

      <div
        ref={tracks}
        className="col-span-3 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        style={{
          maxHeight: `max(${TRACKS_MIN}px, min(${tracksMax}px, 100vh - ${PLAYER_RESERVE}px))`,
          maskImage: more ? "linear-gradient(to bottom, black calc(100% - 28px), transparent)" : undefined,
        }}
        onScroll={measureMore}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && e.nativeEvent.offsetX >= e.currentTarget.clientWidth) e.stopPropagation();
        }}
      >
        <div>
          {lanes.map((lane) => (
            <div key={lane.key} className="grid" style={{ gridTemplateColumns: `${labelW}px 1fr 10px` }}>
              <div className="sticky top-0 flex items-start self-start pt-[3px] pl-5 text-[12px] text-dim">{lane.label}</div>
              <div className="relative mb-[3px] cursor-ew-resize" style={{ height: lane.rows.length * 19 - 3 }}>
                {lane.rows.map((row, ri) =>
                  row.map((it) => {
                    const d = drag?.id === it.id ? drag : undefined;
                    const start = d?.start ?? it.start;
                    const end = d?.end ?? it.end;
                    const sel = selectedLayer === it.id;
                    const label = shortName(it.name);
                    const roomy = ((end - start) / duration) * areaW >= 40;
                    return (
                      <div
                        key={it.id}
                        data-layer={it.id}
                        onPointerDown={(e) => grab(e, it, "move")}
                        title={`${it.name}\n${tc(start)} to ${tc(end)}`}
                        className={cn(
                          "absolute flex h-4 items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] leading-none whitespace-nowrap",
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
              <div />
            </div>
          ))}
        </div>
      </div>

      <div className="col-span-3 grid" style={{ gridTemplateColumns: `${labelW}px 1fr 20px` }}>
        {hasPeaks && (
          <div className="contents">
            <div className="flex items-start pl-5 text-[12px] text-dim">Mix</div>
            <Waveform peaks={peaks!} duration={duration} width={areaW} />
            <div />
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-y-1.5" style={{ left: labelW, right: 20 }}>
        {cues
          .filter((n) => n.end !== undefined && n.end > n.t)
          .map((n) => (
            <div key={`r${n.id}`} className="absolute top-[38px] h-[6px] rounded-full bg-amber/45" style={{ left: pct(n.displayT), width: pct(n.end! - n.t) }} />
          ))}
        <Playhead controller={controller} duration={duration} scrubbing={scrubbing} />
        {cues.map((n, i) => (
          <button
            key={n.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelectNote(n.id)}
            className={cn(
              "pointer-events-auto absolute top-[32px] grid size-[18px] -translate-x-1/2 place-items-center rounded-full text-[10.5px] font-bold",
              n.status === "draft" ? "bg-well text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]" : n.status === "resolved" || n.status === "addressed" || n.status === "wontfix" ? "bg-raised text-soft" : "bg-amber text-amber-ink",
              selectedNote === n.id && "ring-2 ring-playhead",
            )}
            style={{ left: pct(n.displayT) }}
            title={n.text || tagOf(n.tag)?.sentence || "Marker, not written yet"}
          >
            {i + 1}
            {n.tag && <i className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-well", tagOf(n.tag)?.dot)} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function Playhead({ controller, duration, scrubbing }: { controller: PlayerController; duration: number; scrubbing: boolean }) {
  const time = usePlayerSelect(controller, (s) => s.time);
  const x = (Math.min(duration, time) / duration) * 100;
  return (
    <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-playhead shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${x}%` }}>
      <div className="pointer-events-auto absolute -top-1.5 left-1/2 h-[18px] w-[11px] -translate-x-1/2 cursor-ew-resize rounded-[3px] bg-playhead shadow-[0_0_0_1px_rgba(0,0,0,.35)]" />
      {scrubbing && (
        <span className={cn("absolute -top-1.5 rounded-[4px] bg-playhead px-1.5 text-[11.5px] leading-[18px] font-semibold text-ink tabular-nums shadow-[0_0_0_1px_rgba(0,0,0,.35)]", x > 88 ? "right-[9px]" : "left-[9px]")}>{tc(time)}</span>
      )}
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
