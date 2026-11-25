import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { justify, useWidth } from "@/lib/layout";
import { ArrowLeft, ArrowUpDown, Check, FolderOpen, Search, Settings as Gear, X } from "lucide-react";
import { api, media, type CutSummary, type LibraryFile } from "@/lib/api";
import { prefetchCut, useActivity, useCuts } from "@/lib/store";
import { ago, cn, plural } from "@/lib/format";
import { Button, IconButton } from "./ui/button";
import { Img, Blank } from "./ui/img";
import { Heading } from "./ui/heading";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/menu";
import { AgentsPresence, Rail, togglePanel, usePanelShown } from "./Rail";
import { awaitingReview, cutPoster, isWorking, needsYou } from "@/lib/cuts";
import { Mark } from "./Mark";
import { UpdatePill } from "./UpdatePill";
import { openSettings } from "./Settings";
import { openCommandPalette } from "./CommandPalette";
import { usePreference } from "@/lib/preferences";
import { MediaShelf } from "./Media";

export type OpenTarget = {
  cutId: string;
  rev?: number;
  t?: number;
  tab?: string;
};

const STACK_MIN = 10;
const SCRUB_FRAMES = 48;

type LibraryFilter = "all" | "needs" | "working" | "approved";
type LibrarySort = "recent" | "name" | "duration";

function short(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function RemoveButton({ onRemove, className }: { onRemove: () => void; className?: string }) {
  const confirm = usePreference("confirmRemove");
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed)
    return (
      <button onClick={onRemove} onBlur={() => setArmed(false)} autoFocus className={cn("no-drag h-7 rounded-lg bg-raised px-2.5 text-[12.5px] font-semibold text-red hover:bg-hover", className)}>
        Remove
      </button>
    );
  return (
    <IconButton
      label="Remove from Slate"
      onClick={() => (confirm ? setArmed(true) : onRemove())}
      className={cn("size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-4", className)}
    >
      <X />
    </IconButton>
  );
}

type WallItem = {
  key: string;
  aspect: number;
  name: string;
  at: number;
  durationMs: number;
  group: string;
  cut?: CutSummary;
  file?: LibraryFile;
  stack?: WallItem[];
  fallback?: string;
};

function filePoster(f: LibraryFile) {
  return f.poster === false ? undefined : media(`/api/library/poster?path=${encodeURIComponent(f.path)}&v=${Math.round(f.mtimeMs)}-${f.size}`);
}

function itemPoster(it: WallItem) {
  if (it.cut) return cutPoster(it.cut);
  if (it.file) return filePoster(it.file);
  return undefined;
}

function Meta({ it }: { it: WallItem }) {
  if (it.stack) return <span className="text-faint">{plural(it.stack.length, "project")}, {ago(new Date(it.at).toISOString())}</span>;
  if (it.file) {
    const f = it.file;
    return <span className="text-faint">{[f.durationMs ? short(f.durationMs) : undefined, ago(new Date(f.mtimeMs).toISOString())].filter(Boolean).join(", ")}</span>;
  }
  const c = it.cut!;
  const l = c.latest;
  if (c.missing) return <span className="text-red">File moved or deleted</span>;
  if (c.render.failed) return <span className="text-red">Some seconds failed to render</span>;
  if (c.agent?.state === "blocked") return <span className="text-amber">Waiting on your answer</span>;
  if (isWorking(c))
    return (
      <span className="text-soft">
        <i className="mr-2 inline-block size-[7px] rounded-full bg-teal align-middle motion-safe:animate-pulse" />
        {c.agent?.step ? `Working · ${c.agent.step}` : "Agent working"}
      </span>
    );
  if (c.render.rendering && c.render.total) return <span className="text-soft">Rendering {c.render.ready} of {c.render.total} s</span>;
  if (!l) return <span className="text-faint">Reading project</span>;
  if (c.draftNotes > 0) return <span className="text-amber">{plural(c.draftNotes, "note")} not sent</span>;
  if (awaitingReview(c))
    return (
      <span className="text-dim">
        <b className="font-semibold text-amber">r{l.n}</b> {ago(l.at)}
      </span>
    );
  if (c.approvedRev === l.n)
    return (
      <span className="text-dim">
        <Check className="mr-1 inline size-3.5 align-[-2px] text-teal" strokeWidth={2.5} />
        Approved r{l.n}, {ago(l.at)}
      </span>
    );
  return (
    <span className="text-dim">
      r{l.n}, {ago(l.at)}
    </span>
  );
}

function Badges({ cut }: { cut: CutSummary }) {
  if (!cut.draftNotes && !cut.openNotes) return null;
  return (
    <div className="pointer-events-none absolute top-2 left-2 flex gap-1">
      {cut.draftNotes > 0 && <span className="rounded-full bg-amber px-2 text-[12px] leading-[20px] font-bold text-amber-ink shadow-sm">{cut.draftNotes}</span>}
      {cut.openNotes > 0 && <span className="rounded-full bg-ink/85 px-2 text-[12px] leading-[20px] font-semibold text-soft backdrop-blur-sm">{cut.openNotes}</span>}
    </div>
  );
}

function badgeLabel(cut: CutSummary) {
  const parts = [cut.draftNotes ? `${plural(cut.draftNotes, "note")} not sent` : "", cut.openNotes ? `${plural(cut.openNotes, "open note")} with the agent` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Lazy, throttled scrub previewer — avoids firing 48 concurrent requests on casual hover! */
function useScrub(cut: CutSummary | undefined) {
  const l = cut?.latest;
  const frames = l && l.segments > 1 ? Math.min(l.segments, SCRUB_FRAMES) : 0;
  const [at, setAt] = useState<{ i: number; moved: boolean }>();
  const warmed = useRef(new Set<number>());
  const warmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const second = (i: number) => Math.floor((i * l!.segments) / frames);
  const src = (s: number) => media(`/api/cuts/${cut!.id}/thumb?rev=${l!.n}&h=${l!.hash}&s=${s}&size=poster${cut!.render.rendering ? `&r=${cut!.render.ready}` : ""}`);

  useEffect(() => {
    return () => {
      clearTimeout(warmTimer.current);
      clearTimeout(prefetchTimer.current);
    };
  }, []);

  const preload = (i: number) => {
    if (i < 0 || i >= frames || warmed.current.has(i)) return;
    warmed.current.add(i);
    const url = src(second(i));
    if (url) new Image().src = url;
  };

  if (!frames)
    return {
      frames: 0,
      handlers: cut
        ? {
            onPointerEnter() {
              clearTimeout(prefetchTimer.current);
              prefetchTimer.current = setTimeout(() => void prefetchCut(cut.id), 80);
            },
            onPointerLeave() {
              clearTimeout(prefetchTimer.current);
            },
          }
        : {},
    } as const;

  return {
    frames,
    at,
    second: at ? second(at.i) : undefined,
    src: at ? src(second(at.i)) : undefined,
    durationMs: l!.durationMs,
    handlers: {
      onPointerEnter() {
        clearTimeout(prefetchTimer.current);
        prefetchTimer.current = setTimeout(() => void prefetchCut(cut!.id), 80);
        clearTimeout(warmTimer.current);
        // Wait 120ms so casual pass-throughs don't spike ffmpeg; warm 8 coarse keyframes first
        warmTimer.current = setTimeout(() => {
          const step = Math.max(1, Math.floor(frames / 8));
          for (let i = 0; i < frames; i += step) preload(i);
        }, 120);
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.min(frames - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * frames)));
        setAt((p) => (p?.i === i ? p : { i, moved: !!p }));
        preload(i);
        preload(i + 1);
        preload(i - 1);
      },
      onPointerLeave() {
        clearTimeout(warmTimer.current);
        clearTimeout(prefetchTimer.current);
        setAt(undefined);
      },
    },
  } as const;
}

function Tile({ it, w, h, large, busy, onPick, onRemove }: { it: WallItem; w: number; h: number; large?: boolean; busy?: boolean; onPick: (t?: number) => void; onRemove: () => void }) {
  const scrub = useScrub(it.stack ? undefined : it.cut);
  const blocked = it.cut?.agent?.state === "blocked" ? it.cut.agent.text : undefined;
  const [posterShown, setPosterShown] = useState(false);
  const rendering = it.cut && it.cut.render.rendering && it.cut.render.total > 0;
  const renderPct = rendering ? Math.round((it.cut!.render.ready / it.cut!.render.total) * 100) : 0;
  const agentPct = it.cut && isWorking(it.cut) && typeof it.cut.agent?.progress === "number" ? Math.round(it.cut.agent.progress * 100) : undefined;

  return (
    <div className="group relative shrink-0" style={{ width: w }}>
      <button
        onClick={() => onPick(scrub.frames && scrub.at?.moved ? scrub.second! * 1000 : undefined)}
        disabled={busy}
        className="block w-full rounded-[12px] text-left transition-transform duration-150 active:scale-[0.985]"
        title={it.file?.path ?? it.cut?.path}
        {...scrub.handlers}
      >
        <div
          className={cn(
            "relative overflow-hidden rounded-[12px] bg-panel ring-1 ring-transparent transition-[box-shadow,border-color] duration-200 group-hover:ring-line",
            it.cut && needsYou(it.cut) && "ring-amber/35 group-hover:ring-amber/70",
          )}
          style={{ height: h }}
        >
          {it.stack ? (
            <div className="tile-poster absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[2px]">
              {it.stack.slice(0, 4).map((x) => (
                <div key={x.key} className="relative overflow-hidden bg-well">
                  <Img src={itemPoster(x)} />
                </div>
              ))}
            </div>
          ) : (
            <div className={cn("absolute inset-0", !(scrub.frames > 0 && scrub.src) && "tile-poster")}>
              <Blank />
              {it.fallback && !posterShown && <Img src={it.fallback} />}
              <Img src={itemPoster(it)} onReady={() => setPosterShown(true)} />
            </div>
          )}
          {scrub.frames > 0 && scrub.src && (
            <>
              <img
                src={scrub.src}
                draggable={false}
                onLoad={(e) => (e.currentTarget.style.visibility = "visible")}
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                className="absolute inset-0 size-full object-cover"
              />
              <span className="absolute bottom-3 left-2.5 rounded-md bg-ink/85 px-1.5 text-[12px] leading-[20px] font-semibold backdrop-blur-sm">
                {short(scrub.second! * 1000)} of {short(scrub.durationMs)}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
                <span className="block h-full bg-amber" style={{ width: `${((scrub.at!.i + 1) / scrub.frames) * 100}%` }} />
              </span>
            </>
          )}
          {!(scrub.frames > 0 && scrub.src) && (rendering || agentPct !== undefined) && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-ink/70">
              <span
                className={cn("progress-shimmer relative block h-full overflow-hidden transition-[width] duration-300", rendering ? "bg-amber" : "bg-teal")}
                style={{ width: `${Math.max(5, rendering ? renderPct : agentPct!)}%` }}
              />
            </span>
          )}
          {busy && <div className="absolute inset-0 grid place-items-center bg-ink/70 text-[13px] font-semibold backdrop-blur-[2px]">Opening</div>}
          {it.cut && (
            <span title={badgeLabel(it.cut)}>
              <Badges cut={it.cut} />
            </span>
          )}
        </div>
        <div className={cn("truncate leading-snug font-semibold text-text", large ? "mt-2.5 text-[14.5px]" : "mt-2 text-[13.5px]")}>{it.name}</div>
        <div className={cn("truncate leading-snug", large ? "text-[13px]" : "text-[12.5px]")}>
          <Meta it={it} />
        </div>
        {large && blocked && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-soft">{blocked}</p>}
      </button>
      {it.cut && <RemoveButton onRemove={onRemove} className="absolute top-1.5 right-1.5 bg-ink/80 backdrop-blur-sm" />}
    </div>
  );
}

function Wall({ items, large, busy, onPick, onRemove }: { items: WallItem[]; large?: boolean; busy?: string; onPick: (it: WallItem, t?: number) => void; onRemove: (c: CutSummary) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gap = large ? 22 : 16;
  const target = large ? (width > 1500 ? 400 : 340) : width > 1700 ? 250 : 214;
  const laid = useMemo(() => (width ? justify(items, width, target, gap) : []), [items, width, target, gap]);
  return (
    <div ref={ref} className={cn("grid", large ? "gap-y-7" : "gap-y-6")}>
      {laid.map((row, i) => (
        <div key={i} className="flex items-start" style={{ gap }}>
          {row.items.map((it) => (
            <Tile
              key={it.key}
              it={it}
              large={large}
              w={Math.floor(row.h * it.aspect)}
              h={row.h}
              busy={busy === it.key}
              onPick={(t) => onPick(it, t)}
              onRemove={() => it.cut && onRemove(it.cut)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10">
      {title}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

export function Library({ onOpen }: { onOpen: (t: OpenTarget) => void }) {
  const { cuts, library, error, refresh, refreshLibrary } = useCuts();
  const activity = useActivity();
  const [busy, setBusy] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [folder, setFolder] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (name: string, folder: string) => terms.every((t) => `${name} ${folder}`.toLowerCase().includes(t));

  const all = useMemo(
    () =>
      (cuts ?? []).map((c) => ({
        ...c,
        recent: c.recent ?? [],
        latest: c.latest && {
          ...c.latest,
          changed: c.latest.changed ?? [],
          segments: c.latest.segments ?? Math.max(1, Math.ceil(c.latest.durationMs / 1000)),
        },
      })),
    [cuts],
  );

  const filterCounts = useMemo(() => {
    let needs = 0, working = 0, approved = 0;
    for (const c of all) {
      if (c.missing) continue;
      if (needsYou(c)) needs++;
      if (isWorking(c)) working++;
      if (c.approvedRev && c.approvedRev === c.latest?.n) approved++;
    }
    return { needs, working, approved };
  }, [all]);

  const files = useMemo(() => new Map(library.map((f) => [f.path.toLowerCase(), f])), [library]);
  const toItem = (c: CutSummary): WallItem => ({
    fallback: files.has(c.path.toLowerCase()) ? filePoster(files.get(c.path.toLowerCase())!) : undefined,
    key: c.id,
    aspect: c.latest ? c.latest.width / c.latest.height : 9 / 16,
    name: c.name,
    at: Date.parse(c.latest?.at ?? "") || 0,
    durationMs: c.latest?.durationMs ?? 0,
    group: c.folder,
    cut: c,
  });

  const urgency = (c: CutSummary) => (c.agent?.state === "blocked" ? 0 : c.draftNotes > 0 ? 1 : isWorking(c) ? 2 : 3);
  const fresh = useMemo(
    () =>
      filter !== "all"
        ? []
        : all
            .filter((c) => !c.missing && (needsYou(c) || isWorking(c)) && matches(c.name, c.folder))
            .sort((a, b) => urgency(a) - urgency(b) || (b.latest?.at ?? "").localeCompare(a.latest?.at ?? ""))
            .map(toItem),
    [all, q, files, filter],
  );
  const freshIds = new Set(fresh.map((i) => i.key));
  const known = new Set(all.map((c) => c.id));

  const wall = useMemo<WallItem[]>(() => {
    const comparator = (a: WallItem, b: WallItem) =>
      sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : sort === "duration" ? b.durationMs - a.durationMs || b.at - a.at : b.at - a.at;

    const cutPasses = (c: CutSummary) => {
      if (filter === "needs") return needsYou(c);
      if (filter === "working") return isWorking(c);
      if (filter === "approved") return !c.missing && !!c.approvedRev && c.approvedRev === c.latest?.n;
      return true;
    };

    const fromCuts = all.filter((c) => cutPasses(c) && (folder || filter !== "all" || !freshIds.has(c.id)) && matches(c.name, c.folder)).map(toItem);
    const fromFiles: WallItem[] =
      filter !== "all"
        ? []
        : library
            .filter((f) => !(f.registered || (f.id && known.has(f.id))) && matches(f.name, `${f.folder} ${f.group ?? ""}`))
            .map((f) => ({
              key: f.path,
              aspect: f.width && f.height ? f.width / f.height : 9 / 16,
              name: f.name,
              at: f.mtimeMs,
              durationMs: f.durationMs ?? 0,
              group: f.group || f.folder,
              file: f,
            }));
    const items = [...fromCuts, ...fromFiles].sort(comparator);
    if (folder) return items.filter((i) => i.group === folder);
    if (terms.length || filter !== "all" || sort !== "recent") return items;
    const counts = new Map<string, number>();
    for (const i of fromFiles) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    const stacks = new Map<string, WallItem[]>();
    const out: WallItem[] = [];
    for (const i of items) {
      if (!i.cut && (counts.get(i.group) ?? 0) >= STACK_MIN) stacks.set(i.group, [...(stacks.get(i.group) ?? []), i]);
      else out.push(i);
    }
    for (const [g, list] of stacks)
      out.push({
        key: `stack:${g}`,
        aspect: 4 / 5,
        name: g,
        at: list[0].at,
        durationMs: 0,
        group: g,
        stack: list,
      });
    return out.sort(comparator);
  }, [all, library, q, folder, fresh, filter, sort]);

  async function openFile(path: string) {
    setBusy(path);
    setOpenError(undefined);
    try {
      const c = await api<CutSummary>("/api/cuts/open", { body: { path } });
      await refresh();
      void refreshLibrary();
      onOpen({ cutId: c.id });
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function pick() {
    const files = (await window.slate?.openFile()) ?? [];
    for (const f of files) await openFile(f);
  }

  async function remove(id: string) {
    await api(`/api/cuts/${id}/close`, { body: {} });
    void refresh();
    void refreshLibrary();
  }

  function choose(it: WallItem, t?: number) {
    if (it.stack) return setFolder(it.group);
    if (it.cut) return onOpen({ cutId: it.cut.id, t });
    void openFile(it.file!.path);
  }

  const panel = usePanelShown(all, activity);
  const nothing = cuts && cuts.length === 0 && library.length === 0;
  const showFresh = !folder && fresh.length > 0;
  const total = wall.reduce((n, i) => n + (i.stack?.length ?? 1), 0);
  const sortLabel = sort === "recent" ? "Recent" : sort === "name" ? "Name" : "Duration";

  return (
    <div className="view-enter flex h-full flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 pr-[150px] pl-5">
        <Mark />
        <span className="font-semibold">Slate</span>
        <UpdatePill />
        <div className="flex-1" />
        <label className="no-drag flex h-[34px] w-[320px] items-center gap-2 rounded-[9px] bg-panel px-3 text-faint transition-shadow focus-within:text-soft focus-within:ring-2 focus-within:ring-amber/60">
          <Search className="size-[15px] shrink-0" />
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search projects and media"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
          />
          {q ? (
            <button onClick={() => setQ("")} aria-label="Clear search" className="grid size-5 place-items-center rounded text-dim hover:text-text">
              <X className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={openCommandPalette}
              title="Open command palette (Ctrl K)"
              className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-dim transition-colors hover:bg-hover hover:text-text"
            >
              Ctrl K
            </button>
          )}
        </label>
        <Button onClick={pick}>
          <FolderOpen className="size-4" />
          Open project
        </Button>
        <AgentsPresence cuts={all} activity={activity} />
        <IconButton label="Settings" keys="Ctrl ," side="bottom" onClick={() => openSettings()}>
          <Gear />
        </IconButton>
      </header>
      <div className={cn("rail-grid grid min-h-0 flex-1 grid-cols-1 [--rail-open:340px] 2xl:[--rail-open:380px]", panel ? "lg:grid-cols-[minmax(0,1fr)_var(--rail-open)]" : "lg:grid-cols-[minmax(0,1fr)_0px]")}>
        <main className="min-h-0 overflow-y-auto px-8 pt-4 pb-12">
          {error && <div className="mb-4 rounded-lg bg-panel px-4 py-3 text-red">{error}</div>}
          {openError && <div className="mb-4 rounded-lg bg-panel px-4 py-3 text-red">{openError}</div>}
          {!nothing && all.length > 0 && !folder && (
            <div className="mb-6 flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "all", label: "All", count: all.length },
                  { id: "needs", label: "Needs you", count: filterCounts.needs },
                  { id: "working", label: "Working", count: filterCounts.working },
                  { id: "approved", label: "Approved", count: filterCounts.approved },
                ] as const
              )
                .filter((p) => p.id === "all" || p.count > 0 || filter === p.id)
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setFilter(p.id)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[12.5px] font-semibold transition-colors",
                      filter === p.id ? "bg-raised text-text" : "text-dim hover:bg-panel hover:text-soft",
                    )}
                  >
                    {p.label}
                    {p.count > 0 && p.id !== "all" && (
                      <span className={cn("ml-1.5 tabular-nums", p.id === "needs" ? "text-amber" : p.id === "working" ? "text-teal" : "text-faint")}>{p.count}</span>
                    )}
                  </button>
                ))}
              <div className="flex-1" />
              <Menu>
                <MenuTrigger asChild>
                  <button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-dim transition-colors hover:bg-panel hover:text-text">
                    <ArrowUpDown className="size-3.5" />
                    {sortLabel}
                  </button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setSort("recent")}>Most recent</MenuItem>
                  <MenuItem onSelect={() => setSort("name")}>Name (A–Z)</MenuItem>
                  <MenuItem onSelect={() => setSort("duration")}>Longest first</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          )}
          {nothing && (
            <div className="mx-auto mt-24 max-w-md text-center">
              <div className="text-[17px] font-semibold">No projects yet</div>
              <p className="mt-2 text-soft">Agents add their cut here when they call slate_open. You can also open any .tsrct yourself.</p>
              <Button variant="primary" className="mt-5" onClick={pick}>
                <FolderOpen className="size-4" />
                Open project
              </Button>
            </div>
          )}
          {showFresh && (
            <Section title={<Heading count={fresh.length}>New revisions</Heading>}>
              <Wall items={fresh} large busy={busy} onPick={choose} onRemove={(c) => void remove(c.id)} />
            </Section>
          )}
          {(wall.length > 0 || folder) && (
            <Section
              title={
                folder ? (
                  <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setFolder(undefined)} className="-ml-2.5">
                      <ArrowLeft className="size-4" />
                      All projects
                    </Button>
                    <Heading count={wall.length}>{folder}</Heading>
                  </div>
                ) : (
                  <Heading count={total}>{filter !== "all" ? (filter === "needs" ? "Needs you" : filter === "working" ? "Agents working" : "Approved") : showFresh ? "All projects" : "Projects"}</Heading>
                )
              }
            >
              <Wall items={wall} busy={busy} onPick={choose} onRemove={(c) => void remove(c.id)} />
            </Section>
          )}
          {(terms.length > 0 || filter !== "all") && !fresh.length && !wall.length && (
            <p className="mt-16 mb-10 text-center text-soft">
              {terms.length ? `No projects match “${q.trim()}”.` : "No projects in this view yet."}
            </p>
          )}
          {!folder && filter === "all" && <MediaShelf q={q} />}
        </main>
        <Rail cuts={all} activity={activity} onOpen={onOpen} />
      </div>
    </div>
  );
}
