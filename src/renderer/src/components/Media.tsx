import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, Copy, FolderInput, FolderOpen, FolderPlus, ImagePlus, Link2, MoreHorizontal, Music, Pause, Pencil, Play, Search, Trash2, X, Clapperboard } from "lucide-react";
import type { MediaFolder, MediaItem, MediaListing, MediaRef } from "@/lib/api";
import { cn, plural, tc } from "@/lib/format";
import {
  startFolderDrag, addPaths, addTransfer, addUrl, addedText, endDrag, fileUrl, isExternal, isInternal, mediaApi, readDrag, save, startDrag, store, thumbUrl, togglePlay, useMedia, usePeaks, usePlaying, stopPlay, aspectOf,
} from "@/lib/medialib";
import { justify, useWidth } from "@/lib/layout";
import { Button, IconButton } from "./ui/button";
import { Heading } from "./ui/heading";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextSub, ContextTrigger, ContextLabel } from "./ui/context-menu";

export type Toast = (text: string, tone?: "error", action?: { label: string; run: () => void }) => void;
type Lib = { id: string; label: string; listing?: MediaListing };
type Renaming = { lib: string; path: string; folder?: boolean };

function seconds(ms?: number) {
  if (!ms) return undefined;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

function metaLine(it: MediaItem) {
  const size = it.size >= 1e6 ? `${(it.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(it.size / 1e3))} KB`;
  return [it.ext.toUpperCase(), it.width && it.height ? `${it.width}×${it.height}` : undefined, seconds(it.durationMs), size].filter(Boolean).join(", ");
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^./, (c) => c.toUpperCase());

function MediaThumb({ it, hoverPlay, className }: { it: MediaItem; hoverPlay?: boolean; className?: string }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState<string>();
  const fit = it.alpha ? "object-contain p-[6%]" : "object-cover";
  if (it.kind === "audio")
    return (
      <div className={cn("grid size-full place-items-center text-dim", className)}>
        <Music className="size-1/3 max-h-6 max-w-6" />
      </div>
    );
  const src = thumbUrl(it);
  return (
    <div className={cn("relative size-full", className)} onPointerEnter={() => hoverPlay && setHover(true)} onPointerLeave={() => setHover(false)}>
      {failed !== src && src ? (
        <img src={src} draggable={false} loading="lazy" decoding="async" onError={() => setFailed(src)} className={cn("absolute inset-0 size-full", fit)} />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-faint">
          <Clapperboard className="size-5" />
        </div>
      )}
      {hover && it.ext === "gif" && <img src={fileUrl(it)} draggable={false} className={cn("absolute inset-0 size-full", fit)} />}
      {hover && it.kind === "video" && <video src={fileUrl(it)} muted autoPlay loop playsInline className={cn("absolute inset-0 size-full", fit)} />}
    </div>
  );
}

function Waveform({ peaks, progress, className }: { peaks?: number[]; progress?: number; className?: string }) {
  const bars = peaks ?? Array.from({ length: 48 }, () => 0.08);
  const step = 100 / bars.length;
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className={className} aria-hidden>
      {bars.map((v, i) => {
        const h = Math.max(1.2, v * 19);
        const played = progress !== undefined && i / bars.length < progress;
        return <rect key={i} x={i * step + step * 0.18} y={10 - h / 2} width={step * 0.64} height={h} rx={0.4} className={played ? "fill-amber" : progress !== undefined ? "fill-soft" : "fill-dim"} />;
      })}
    </svg>
  );
}

function RenameInput({ initial, onDone, className }: { initial: string; onDone: (name?: string) => void; className?: string }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name && name.trim() && name.trim() !== initial ? name.trim() : undefined);
  };
  return (
    <input
      autoFocus
      value={v}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        if (e.key === "Escape") finish();
      }}
      onBlur={() => finish(v)}
      className={cn("min-w-0 rounded-md bg-ink px-1.5 text-text outline-none ring-2 ring-amber/60", className)}
    />
  );
}

function uniqueFolderName(listing: MediaListing | undefined, parent: string) {
  const taken = new Set((listing?.folders ?? []).map((f) => f.path.toLowerCase()));
  const at = (n: string) => (parent ? `${parent}/${n}` : n).toLowerCase();
  let name = "New folder";
  for (let i = 2; taken.has(at(name)); i++) name = `New folder ${i}`;
  return name;
}

type Actions = {
  libs: Lib[];
  toast: Toast;
  rename: (r: Renaming) => void;
  cue?: (it: MediaItem) => void;
  cueLabel?: string;
};

function absPath(lib: Lib | undefined, rel: string) {
  return lib?.listing ? `${lib.listing.root}\\${rel.split("/").join("\\")}` : undefined;
}

function MoveTargets({ it, actions, copy }: { it: { lib: string; path: string; folder: string }; actions: Actions; copy?: boolean }) {
  const run = async (lib: string, folder: string) => {
    try {
      await mediaApi.move([{ lib: it.lib, path: it.path }], { lib, folder }, copy);
      const label = actions.libs.find((l) => l.id === lib)?.label ?? "the library";
      actions.toast(`${copy ? "Copied" : "Moved"} to ${folder ? folder.split("/").pop() : label}`);
    } catch (e) {
      actions.toast(errorText(e), "error");
    }
  };
  return (
    <>
      {actions.libs.map((l) => {
        const same = l.id === it.lib;
        if (copy && same) return null;
        return (
          <div key={l.id}>
            {actions.libs.length > 1 && <ContextLabel>{l.label}</ContextLabel>}
            <ContextItem disabled={same && !copy && it.folder === ""} onSelect={() => void run(l.id, "")}>
              Top level
            </ContextItem>
            {(l.listing?.folders ?? [])
              .filter((f) => !(same && (f.path === it.path || f.path.startsWith(it.path + "/"))))
              .map((f) => (
                <ContextItem key={f.path} disabled={same && !copy && f.path === it.folder} onSelect={() => void run(l.id, f.path)}>
                  <span style={{ paddingLeft: (f.path.split("/").length - 1) * 12 }}>{f.name}</span>
                </ContextItem>
              ))}
          </div>
        );
      })}
    </>
  );
}

function ItemMenu({ it, actions }: { it: MediaItem; actions: Actions }) {
  const others = actions.libs.filter((l) => l.id !== it.lib);
  return (
    <ContextContent>
      {actions.cue && (
        <>
          <ContextItem onSelect={() => actions.cue!(it)} keys="Enter">
            <Clapperboard />
            {actions.cueLabel}
          </ContextItem>
          <ContextSeparator />
        </>
      )}
      <ContextItem onSelect={() => actions.rename({ lib: it.lib, path: it.path })} keys="F2">
        <Pencil />
        Rename
      </ContextItem>
      <ContextSub label="Move to" icon={<FolderInput />}>
        <MoveTargets it={it} actions={actions} />
      </ContextSub>
      {others.length > 0 && (
        <ContextSub label="Copy to" icon={<Copy />}>
          <MoveTargets it={it} actions={actions} copy />
        </ContextSub>
      )}
      <ContextSeparator />
      <ContextItem onSelect={() => void window.slate?.reveal(it.file)}>
        <FolderOpen />
        Show in Explorer
      </ContextItem>
      <ContextItem onSelect={() => void navigator.clipboard.writeText(it.file).then(() => actions.toast("Copied the file path"))}>
        <Link2 />
        Copy path
      </ContextItem>
      <ContextSeparator />
      <ContextItem danger onSelect={() => void recycle(it.lib, [it.path], it.name, actions.toast)} keys="Del">
        <Trash2 />
        Move to Recycle Bin
      </ContextItem>
    </ContextContent>
  );
}

async function recycle(lib: string, paths: string[], name: string, toast: Toast) {
  try {
    await mediaApi.recycle(lib, paths);
    toast(`Moved ${name} to the Recycle Bin`);
  } catch (e) {
    toast(errorText(e), "error");
  }
}

async function newFolder(lib: Lib, parent: string, actions: Pick<Actions, "toast" | "rename">) {
  try {
    const r = await mediaApi.folder(lib.id, parent, uniqueFolderName(lib.listing, parent));
    actions.rename({ lib: lib.id, path: r.path, folder: true });
  } catch (e) {
    actions.toast(errorText(e), "error");
  }
}

async function pickFiles(lib: string, folder: string, where: string, toast: Toast) {
  const files = (await window.slate?.openMedia?.()) ?? [];
  if (!files.length) return;
  try {
    toast(addedText(await addPaths(lib, folder, files), where));
  } catch (e) {
    toast(errorText(e), "error");
  }
}

async function addLink(lib: string, folder: string, where: string, toast: Toast) {
  const text = (await navigator.clipboard.readText().catch(() => "")).trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return toast("Copy a link to an image, GIF, video or sound first, then choose Add link from clipboard", "error");
  toast("Downloading");
  try {
    toast(addedText(await addUrl(lib, folder, text), where));
  } catch (e) {
    toast(errorText(e), "error");
  }
}

function useDropZone(onDrop: (e: DragEvent) => void, accept: (e: DragEvent) => boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return {
    over,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!accept(e)) return;
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!accept(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isInternal(e.dataTransfer) && !e.ctrlKey ? "move" : "copy";
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        depth.current = 0;
        setOver(false);
        if (!accept(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(e);
      },
    },
  };
}

async function dropInto(e: DragEvent, lib: string, folder: string, where: string, toast: Toast) {
  const dt = e.dataTransfer;
  const internal = readDrag(dt);
  try {
    if (internal) {
      const copy = e.ctrlKey || internal.some((i) => i.lib !== lib);
      const moved = internal.filter((i) => copy || !(i.lib === lib && (i.path.includes("/") ? i.path.slice(0, i.path.lastIndexOf("/")) : "") === folder));
      if (!moved.length) return;
      await mediaApi.move(moved.map((i) => ({ lib: i.lib, path: i.path })), { lib, folder }, copy);
      toast(`${copy ? "Copied" : "Moved"} ${moved.length === 1 ? moved[0].name : plural(moved.length, "file")} to ${where}`);
      return;
    }
    const r = await addTransfer(lib, folder, dt);
    if (r) toast(addedText(r, where));
  } catch (err) {
    toast(errorText(err), "error");
  }
}

function usePaste(enabled: boolean, onPaste: (dt: DataTransfer) => void) {
  const fn = useRef(onPaste);
  fn.current = onPaste;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: ClipboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (!e.clipboardData) return;
      const has = e.clipboardData.files.length || /^https?:\/\/\S+$/i.test(e.clipboardData.getData("text/plain").trim()) || /<img/i.test(e.clipboardData.getData("text/html"));
      if (!has) return;
      e.preventDefault();
      fn.current(e.clipboardData);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [enabled]);
}

function sectionsOf(listing: MediaListing | undefined, terms: string[]) {
  const items = (listing?.items ?? []).filter((i) => terms.every((t) => `${i.name} ${i.folder}`.toLowerCase().includes(t)));
  const byFolder = new Map<string, MediaItem[]>();
  for (const i of items) byFolder.set(i.folder, [...(byFolder.get(i.folder) ?? []), i]);
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  for (const list of byFolder.values()) list.sort((a, b) => (a.kind === "audio" ? 1 : 0) - (b.kind === "audio" ? 1 : 0) || cmp(a.name, b.name));
  const folders = [...(listing?.folders ?? [])].sort((a, b) => cmp(a.path, b.path));
  return { items, root: byFolder.get("") ?? [], folders: folders.map((f) => ({ folder: f, items: byFolder.get(f.path) ?? [] })) };
}

function PanelTile({ it, selected, actions, onSelect, renaming }: { it: MediaItem; selected: boolean; actions: Actions; onSelect: () => void; renaming: boolean }) {
  const badge = it.kind === "video" ? seconds(it.durationMs) : it.animated ? "GIF" : undefined;
  return (
    <ContextMenu onOpenChange={(o) => o && onSelect()}>
      <ContextTrigger asChild>
        <button
          draggable={!renaming}
          onDragStart={(e) => startDrag(e, [it])}
          onDragEnd={endDrag}
          onClick={onSelect}
          onDoubleClick={() => actions.cue?.(it)}
          title={it.name}
          className={cn("group relative aspect-square overflow-hidden rounded-lg bg-well outline-none", selected ? "ring-2 ring-amber" : "focus-visible:ring-2 focus-visible:ring-amber/60")}
        >
          <MediaThumb it={it} hoverPlay />
          {badge && <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-ink/85 px-1 text-[10.5px] leading-[16px] font-semibold text-soft">{badge}</span>}
          <span className="pointer-events-none absolute inset-x-1 top-1 truncate rounded bg-ink/85 px-1 text-left text-[11px] leading-[17px] font-medium opacity-0 group-hover:opacity-100">{it.name}</span>
        </button>
      </ContextTrigger>
      <ItemMenu it={it} actions={actions} />
    </ContextMenu>
  );
}

function AudioRow({ it, selected, actions, onSelect, renaming, onRenamed }: { it: MediaItem; selected: boolean; actions: Actions; onSelect: () => void; renaming: boolean; onRenamed: (name?: string) => void }) {
  const peaks = usePeaks(it);
  const playing = usePlaying();
  const mine = playing?.id === it.id;
  return (
    <ContextMenu onOpenChange={(o) => o && onSelect()}>
      <ContextTrigger asChild>
        <div
          draggable={!renaming}
          onDragStart={(e) => startDrag(e, [it])}
          onDragEnd={endDrag}
          onClick={onSelect}
          onDoubleClick={() => actions.cue?.(it)}
          className={cn("group flex h-9 cursor-default items-center gap-2 rounded-lg pr-2 pl-0.5", selected ? "bg-raised shadow-[inset_0_0_0_1px_var(--color-amber)]" : "hover:bg-raised/70")}
        >
          <button
            aria-label={mine ? `Stop ${it.name}` : `Play ${it.name}`}
            onClick={(e) => {
              e.stopPropagation();
              togglePlay(it);
            }}
            className={cn("grid size-8 shrink-0 place-items-center rounded-md hover:bg-hover [&_svg]:size-[15px]", mine ? "text-amber" : "text-soft")}
          >
            {mine ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
          </button>
          {renaming ? <RenameInput initial={it.name} onDone={onRenamed} className="h-6 w-[45%]" /> : <span className="w-[45%] min-w-0 truncate">{it.name}</span>}
          <Waveform peaks={peaks} progress={mine ? playing.progress : undefined} className="h-5 min-w-0 flex-1" />
          <span className="w-10 shrink-0 text-right text-[12px] text-faint">{seconds(it.durationMs) ?? ""}</span>
        </div>
      </ContextTrigger>
      <ItemMenu it={it} actions={actions} />
    </ContextMenu>
  );
}

function FolderHeader({
  lib,
  folder,
  collapsed,
  onToggle,
  actions,
  renaming,
  onRenamed,
}: {
  lib: Lib;
  folder: MediaFolder;
  collapsed: boolean;
  onToggle: () => void;
  actions: Actions;
  renaming: boolean;
  onRenamed: (name?: string) => void;
}) {
  const depth = folder.path.split("/").length - 1;
  const where = folder.name;
  const drop = useDropZone((e) => void dropInto(e, lib.id, folder.path, where, actions.toast), (e) => isInternal(e.dataTransfer) || isExternal(e.dataTransfer));
  const menu = (
    <>
      <ContextItem onSelect={() => void pickFiles(lib.id, folder.path, where, actions.toast)}>
        <ImagePlus />
        Add files here
      </ContextItem>
      <ContextItem onSelect={() => void newFolder(lib, folder.path, actions)}>
        <FolderPlus />
        New folder inside
      </ContextItem>
      <ContextItem onSelect={() => actions.rename({ lib: lib.id, path: folder.path, folder: true })}>
        <Pencil />
        Rename
      </ContextItem>
      <ContextSub label="Move to" icon={<FolderInput />}>
        <MoveTargets it={{ lib: lib.id, path: folder.path, folder: folder.path.includes("/") ? folder.path.slice(0, folder.path.lastIndexOf("/")) : "" }} actions={actions} />
      </ContextSub>
      <ContextSeparator />
      <ContextItem onSelect={() => void window.slate?.openFolder?.(absPath(lib, folder.path) ?? "")}>
        <FolderOpen />
        Show in Explorer
      </ContextItem>
      <ContextSeparator />
      <ContextItem danger onSelect={() => void recycle(lib.id, [folder.path], folder.name, actions.toast)}>
        <Trash2 />
        Move to Recycle Bin
      </ContextItem>
    </>
  );
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <div
          {...drop.props}
          draggable={!renaming}
          onDragStart={(e) => startFolderDrag(e, lib.id, folder)}
          onDragEnd={endDrag}
          className={cn("group mt-2 flex h-8 items-center gap-1 rounded-lg pr-1", drop.over ? "bg-amber/15 text-amber" : "hover:bg-raised/60")}
          style={{ paddingLeft: depth * 14 }}
        >
          <button onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left font-semibold" aria-expanded={!collapsed}>
            <ChevronRight className={cn("size-4 shrink-0 text-dim motion-safe:transition-transform", !collapsed && "rotate-90")} />
            {renaming ? <RenameInput initial={folder.name} onDone={onRenamed} className="h-6 flex-1" /> : <span className="truncate">{folder.name}</span>}
            <span className="shrink-0 text-[12.5px] font-medium text-faint">{folder.count || ""}</span>
          </button>
          <Menu>
            <MenuTrigger asChild>
              <button aria-label={`${folder.name} options`} className="grid size-7 place-items-center rounded-md text-dim opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100 data-[state=open]:opacity-100">
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => void pickFiles(lib.id, folder.path, where, actions.toast)}>
                <ImagePlus />
                Add files here
              </MenuItem>
              <MenuItem onSelect={() => void newFolder(lib, folder.path, actions)}>
                <FolderPlus />
                New folder inside
              </MenuItem>
              <MenuItem onSelect={() => actions.rename({ lib: lib.id, path: folder.path, folder: true })}>
                <Pencil />
                Rename
              </MenuItem>
              <MenuItem onSelect={() => void window.slate?.openFolder?.(absPath(lib, folder.path) ?? "")}>
                <FolderOpen />
                Show in Explorer
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => void recycle(lib.id, [folder.path], folder.name, actions.toast)}>
                <Trash2 />
                Move to Recycle Bin
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </ContextTrigger>
      <ContextContent>{menu}</ContextContent>
    </ContextMenu>
  );
}

function ScopeButton({ lib, active, count, onClick, toast }: { lib: Lib; active: boolean; count?: number; onClick: () => void; toast: Toast }) {
  const drop = useDropZone((e) => void dropInto(e, lib.id, "", lib.label === "Global" ? "Global" : "this project", toast), (e) => !active && (isInternal(e.dataTransfer) || isExternal(e.dataTransfer)));
  return (
    <button
      {...drop.props}
      onClick={onClick}
      className={cn("rounded-md px-2.5 py-1 font-semibold whitespace-nowrap", active ? "bg-raised text-text" : drop.over ? "bg-amber/20 text-amber" : "text-dim hover:text-text")}
    >
      {lib.label}
      {count ? <span className="ml-1.5 font-medium text-faint">{count}</span> : null}
    </button>
  );
}

export function MediaPanel({ cutId, cueLabel, onCue, toast }: { cutId: string; cueLabel: string; onCue: (it: MediaItem) => void; toast: Toast }) {
  const project = useMedia(cutId);
  const global = useMedia("global");
  const [scope, setScope] = useState<"project" | "global">(() => store("slate-media-scope", "project"));
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string>();
  const [renaming, setRenaming] = useState<Renaming>();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => store("slate-media-collapsed", {}));
  const libs: Lib[] = [
    { id: cutId, label: "This project", listing: project.data },
    { id: "global", label: "Global", listing: global.data },
  ];
  const lib = scope === "project" ? libs[0] : libs[1];
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const view = useMemo(() => sectionsOf(lib.listing, terms), [lib.listing, q]);
  const sel = lib.listing?.items.find((i) => i.id === selected);
  const where = scope === "project" ? "this project" : "Global";

  useEffect(() => save("slate-media-scope", scope), [scope]);
  useEffect(() => stopPlay, []);
  useEffect(() => save("slate-media-collapsed", collapsed), [collapsed]);

  const actions: Actions = { libs, toast, rename: setRenaming, cue: onCue, cueLabel };
  const collapsedKey = (path: string) => `${lib.id === "global" ? "global" : "project"}:${path}`;
  const hiddenBy = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (collapsed[collapsedKey(parts.slice(0, i).join("/"))]) return true;
    return false;
  };

  const finishRename = async (name?: string) => {
    const r = renaming;
    setRenaming(undefined);
    if (!r || !name) return;
    try {
      const out = await mediaApi.rename(r.lib, r.path, name);
      if (!r.folder) setSelected(`${r.lib}:${out.path}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const panelDrop = useDropZone((e) => void dropInto(e, lib.id, "", where, toast), (e) => isExternal(e.dataTransfer));
  usePaste(true, (dt) => {
    addTransfer(lib.id, sel?.folder ?? "", dt)
      .then((r) => r && toast(addedText(r, sel?.folder ? sel.folder.split("/").pop()! : where)))
      .catch((e) => toast(errorText(e), "error"));
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (!sel || e.target instanceof HTMLInputElement) return;
    const map: Record<string, () => void> = {
      Enter: () => onCue(sel),
      F2: () => setRenaming({ lib: sel.lib, path: sel.path }),
      Delete: () => void recycle(sel.lib, [sel.path], sel.name, toast),
      Escape: () => setSelected(undefined),
    };
    if (map[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      map[e.key]();
    }
  };

  const listItems = (items: MediaItem[]) => {
    const visual = items.filter((i) => i.kind !== "audio");
    const audio = items.filter((i) => i.kind === "audio");
    return (
      <>
        {visual.length > 0 && (
          <div className="grid grid-cols-4 gap-1.5 py-1">
            {visual.map((it) => (
              <PanelTile key={it.id} it={it} selected={selected === it.id} actions={actions} onSelect={() => setSelected(it.id)} renaming={renaming?.path === it.path && renaming.lib === it.lib} />
            ))}
          </div>
        )}
        {audio.length > 0 && (
          <div className="grid gap-0.5 py-1">
            {audio.map((it) => (
              <AudioRow
                key={it.id}
                it={it}
                selected={selected === it.id}
                actions={actions}
                onSelect={() => setSelected(it.id)}
                renaming={renaming?.path === it.path && renaming.lib === it.lib && !renaming.folder}
                onRenamed={(n) => void finishRename(n)}
              />
            ))}
          </div>
        )}
      </>
    );
  };

  const empty = lib.listing && lib.listing.items.length === 0 && lib.listing.folders.length === 0;
  const loading = !lib.listing && !(scope === "project" ? project.error : global.error);

  return (
    <div {...panelDrop.props} onKeyDown={onKey} className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="flex gap-0.5 rounded-lg bg-ink p-[3px]">
          {libs.map((l) => (
            <ScopeButton key={l.id} lib={l} active={l === lib} count={l.listing?.items.length} onClick={() => (setScope(l === libs[0] ? "project" : "global"), setSelected(undefined))} toast={toast} />
          ))}
        </div>
        <div className="flex-1" />
        <IconButton label="New folder" onClick={() => void newFolder(lib, "", actions)}>
          <FolderPlus />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Add media">
              <ImagePlus />
            </IconButton>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => void pickFiles(lib.id, "", where, toast)}>
              <ImagePlus />
              Add files
            </MenuItem>
            <MenuItem onSelect={() => void addLink(lib.id, "", where, toast)}>
              <Link2 />
              Add link from clipboard
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => lib.listing && void window.slate?.openFolder?.(lib.listing.root)} disabled={!lib.listing || lib.listing.items.length + lib.listing.folders.length === 0}>
              <FolderOpen />
              Show in Explorer
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="px-4 pt-2.5 pb-1">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-ink px-2.5 text-faint focus-within:text-soft focus-within:ring-2 focus-within:ring-amber/60">
          <Search className="size-[14px] shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setQ(""), e.currentTarget.blur())}
            placeholder={scope === "project" ? "Search this project's media" : "Search global media"}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search" className="grid size-5 place-items-center rounded text-dim hover:text-text">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" onClick={(e) => e.target === e.currentTarget && setSelected(undefined)}>
        {loading && <p className="px-2 pt-6 text-dim">Reading the library</p>}
        {(scope === "project" ? project.error : global.error) && <p className="px-2 pt-6 text-red">{scope === "project" ? project.error : global.error}</p>}
        {empty && (
          <div className="px-2 pt-6 text-soft">
            <div className="font-semibold text-text">{scope === "project" ? "No media for this project yet" : "Your global library is empty"}</div>
            <p className="mt-1">
              {scope === "project"
                ? "Drop memes, stickers, clips or sounds here, or paste one with Ctrl V. Drag any of them onto the frame to ask for it at that moment."
                : "Media here is there for every project. Drop files in, paste with Ctrl V, or add a link to a GIF."}
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => void pickFiles(lib.id, "", where, toast)}>
                <ImagePlus className="size-4" />
                Add files
              </Button>
              <Button variant="ghost" onClick={() => void newFolder(lib, "", actions)}>
                <FolderPlus className="size-4" />
                New folder
              </Button>
            </div>
          </div>
        )}
        {lib.listing && terms.length > 0 && view.items.length === 0 && <p className="px-2 pt-6 text-soft">Nothing matches “{q.trim()}”.</p>}
        {view.root.length > 0 && <div className="px-1">{listItems(view.root)}</div>}
        {view.folders.map(({ folder, items }) => {
          if (terms.length && !items.length) return null;
          if (!terms.length && hiddenBy(folder.path)) return null;
          const shut = !terms.length && !!collapsed[collapsedKey(folder.path)];
          const isRenaming = renaming?.folder && renaming.lib === lib.id && renaming.path === folder.path;
          return (
            <section key={folder.path}>
              <FolderHeader
                lib={lib}
                folder={folder}
                collapsed={shut}
                onToggle={() => setCollapsed((c) => ({ ...c, [collapsedKey(folder.path)]: !shut }))}
                actions={actions}
                renaming={!!isRenaming}
                onRenamed={(n) => void finishRename(n)}
              />
              {!shut && (
                <div className="px-1" style={{ paddingLeft: (folder.path.split("/").length - 1) * 14 + 4 }}>
                  {items.length ? listItems(items) : !view.folders.some((f) => f.folder.path.startsWith(folder.path + "/")) && <p className="py-1 pl-6 text-[12.5px] text-faint">Empty. Drop files on the folder name.</p>}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {sel && (
        <div className="mx-4 mb-4 flex items-center gap-3 rounded-xl bg-ink p-2.5">
          <div className="relative size-11 shrink-0 overflow-hidden rounded-md bg-well">
            <MediaThumb it={sel} />
          </div>
          <div className="min-w-0 flex-1">
            {renaming && !renaming.folder && renaming.path === sel.path && sel.kind !== "audio" ? (
              <RenameInput initial={sel.name} onDone={(n) => void finishRename(n)} className="h-6 w-full" />
            ) : (
              <button onDoubleClick={() => setRenaming({ lib: sel.lib, path: sel.path })} title="Double-click to rename" className="block w-full truncate text-left font-semibold">
                {sel.name}
              </button>
            )}
            <div className="truncate text-[12.5px] text-dim">{metaLine(sel)}</div>
          </div>
          <Button variant="primary" onClick={() => onCue(sel)} className="min-w-0 !shrink">
            <span className="truncate">{cueLabel}</span>
          </Button>
        </div>
      )}
      {panelDrop.over && (
        <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-xl bg-ink/90 shadow-[inset_0_0_0_2px_var(--color-amber)]">
          <div className="text-center">
            <ImagePlus className="mx-auto size-6 text-amber" />
            <div className="mt-2 font-semibold">Add to {where}</div>
            <div className="text-[12.5px] text-dim">Drop on a folder name to put it there</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function MediaChips({ refs, lib, onOpen }: { refs: MediaRef[]; lib: (r: MediaRef) => string; onOpen?: (r: MediaRef) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {refs.map((r) => {
        const it = { ...r, lib: lib(r), id: `${lib(r)}:${r.path}`, ext: (r.file.split(".").pop() ?? "").toLowerCase(), size: 0, mtimeMs: 0, sig: r.sig ?? "ref" } as MediaItem;
        return (
          <button
            key={it.id}
            disabled={r.missing}
            onClick={(e) => {
              e.stopPropagation();
              if (r.kind === "audio") togglePlay(it);
              else onOpen?.(r);
            }}
            title={r.file}
            className="flex h-8 max-w-full items-center gap-2 rounded-lg bg-ink pr-2.5 pl-1 text-[12.5px] enabled:hover:bg-hover disabled:opacity-60"
          >
            <span className="relative size-6 shrink-0 overflow-hidden rounded bg-well">
              <MediaThumb it={it} />
            </span>
            <span className="truncate font-medium">{r.name}</span>
            {r.missing && <span className="shrink-0 text-faint">Missing</span>}
          </button>
        );
      })}
    </div>
  );
}

function ShelfTile({ it, w, h, actions, renaming, onRenamed, onOpen }: { it: MediaItem; w: number; h: number; actions: Actions; renaming: boolean; onRenamed: (n?: string) => void; onOpen: () => void }) {
  const peaks = usePeaks(it);
  const playing = usePlaying();
  const mine = playing?.id === it.id;
  return (
    <div className="group relative shrink-0" style={{ width: w }}>
      <ContextMenu>
        <ContextTrigger asChild>
          <button
            draggable={!renaming}
            onDragStart={(e) => startDrag(e, [it])}
            onDragEnd={endDrag}
            onClick={() => (it.kind === "audio" ? togglePlay(it) : onOpen())}
            className="block w-full rounded-[10px] text-left"
            title={it.file}
          >
            <div className="relative overflow-hidden rounded-[10px] bg-panel" style={{ height: h }}>
              {it.kind === "audio" ? (
                <div className="absolute inset-0 flex items-center gap-2.5 px-3">
                  <span className={cn("grid size-9 shrink-0 place-items-center rounded-full bg-ink [&_svg]:size-4", mine ? "text-amber" : "text-soft")}>{mine ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</span>
                  <Waveform peaks={peaks} progress={mine ? playing.progress : undefined} className="h-1/3 min-w-0 flex-1" />
                </div>
              ) : (
                <MediaThumb it={it} hoverPlay className="bg-well" />
              )}
              {it.animated && <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink/85 px-1.5 text-[11px] leading-[18px] font-semibold text-soft">GIF</span>}
              {it.kind === "video" && it.durationMs && <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink/85 px-1.5 text-[11px] leading-[18px] font-semibold text-soft">{seconds(it.durationMs)}</span>}
            </div>
          </button>
        </ContextTrigger>
        <ItemMenu it={it} actions={actions} />
      </ContextMenu>
      {renaming ? <RenameInput initial={it.name} onDone={onRenamed} className="mt-1.5 h-6 w-full text-[13px]" /> : <div className="mt-1.5 truncate text-[13px] font-semibold">{it.name}</div>}
      <div className="truncate text-[12px] text-faint">{[it.folder.split("/").pop(), seconds(it.durationMs)].filter(Boolean).join(", ") || it.ext.toUpperCase()}</div>
    </div>
  );
}

function Preview({ it, onClose }: { it: MediaItem; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/90 p-10" onClick={onClose}>
      <div className="flex max-h-full max-w-full flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {it.kind === "video" ? (
          <video ref={(v) => void v?.play().catch(() => {})} src={fileUrl(it)} poster={thumbUrl(it)} controls loop className="max-h-[78vh] max-w-[86vw] rounded-xl bg-well" />
        ) : (
          <img src={fileUrl(it)} className="max-h-[78vh] max-w-[86vw] rounded-xl bg-well object-contain" draggable={false} />
        )}
        <div className="mt-4 flex items-center gap-3">
          <span className="font-semibold">{it.name}</span>
          <span className="text-dim">{metaLine(it)}</span>
          <IconButton label="Show in Explorer" onClick={() => void window.slate?.reveal(it.file)}>
            <FolderOpen />
          </IconButton>
          <IconButton label="Close" keys="Esc" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

const SHELF_LIMIT = 48;

export function MediaShelf({ q, onLib }: { q: string; onLib?: (l: MediaListing | undefined) => void }) {
  const global = useMedia("global");
  const [folder, setFolder] = useState<string>(() => store("slate-shelf-folder", ""));
  const [all, setAll] = useState(false);
  const [note, setNote] = useState<{ text: string; tone?: "error" }>();
  const [renaming, setRenaming] = useState<Renaming>();
  const [preview, setPreview] = useState<MediaItem>();
  const [ref, width] = useWidth<HTMLDivElement>();
  const lib: Lib = { id: "global", label: "Global", listing: global.data };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast: Toast = (text, tone) => {
    setNote({ text, tone });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(undefined), tone === "error" ? 7000 : 3800);
  };
  const actions: Actions = { libs: [lib], toast, rename: setRenaming };
  const listing = global.data;
  const known = !folder || listing?.folders.some((f) => f.path === folder);
  const current = known ? folder : "";
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

  useEffect(() => save("slate-shelf-folder", folder), [folder]);
  useEffect(() => stopPlay, []);
  useEffect(() => onLib?.(listing), [listing]);

  const items = useMemo(() => {
    const list = (listing?.items ?? [])
      .filter((i) => !current || i.folder === current || i.folder.startsWith(current + "/"))
      .filter((i) => terms.every((t) => `${i.name} ${i.folder}`.toLowerCase().includes(t)));
    return list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }, [listing, current, q]);
  const shown = all || terms.length ? items : items.slice(0, SHELF_LIMIT);
  const laid = useMemo(() => (width ? justify(shown.map((it) => ({ it, aspect: Math.min(2.4, Math.max(0.5, aspectOf(it))) })), width, width > 1500 ? 170 : 150, 14) : []), [shown, width]);
  const where = current ? current.split("/").pop()! : "Global";
  const drop = useDropZone((e) => void dropInto(e, "global", current, where, toast), (e) => isExternal(e.dataTransfer) || isInternal(e.dataTransfer));
  usePaste(true, (dt) => {
    addTransfer("global", current, dt)
      .then((r) => r && toast(addedText(r, where)))
      .catch((e) => toast(errorText(e), "error"));
  });

  const finishRename = async (name?: string) => {
    const r = renaming;
    setRenaming(undefined);
    if (!r || !name) return;
    try {
      const out = await mediaApi.rename(r.lib, r.path, name);
      if (r.folder && r.path === current) setFolder(out.path);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  if (terms.length && !items.length) return <div ref={ref} />;
  const chips = listing?.folders ?? [];

  return (
    <section className="mb-10" {...drop.props}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Heading count={listing?.items.length}>Media</Heading>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {[{ path: "", name: "All" } as MediaFolder, ...chips].map((f) => {
            const depth = f.path ? f.path.split("/").length - 1 : 0;
            const isRenaming = renaming?.folder && renaming.path === f.path;
            return (
              <FolderChip
                key={f.path || "all"}
                folder={f}
                depth={depth}
                active={current === f.path}
                onClick={() => (setFolder(f.path), setAll(false))}
                renaming={!!isRenaming}
                onRenamed={(n) => void finishRename(n)}
                actions={actions}
                lib={lib}
              />
            );
          })}
          <IconButton label="New folder" className="size-7 [&_svg]:size-4" onClick={() => void newFolder(lib, current, actions)}>
            <FolderPlus />
          </IconButton>
        </div>
        <div className="flex-1" />
        {note && <span className={cn("truncate text-[13px]", note.tone === "error" ? "text-red" : "text-soft")}>{note.text}</span>}
        <Button size="sm" onClick={() => void pickFiles("global", current, where, toast)}>
          <ImagePlus className="size-4" />
          Add media
        </Button>
      </div>
      <div ref={ref} className={cn("relative mt-3.5 rounded-xl", drop.over && "bg-amber/[0.06] shadow-[0_0_0_2px_var(--color-amber)]")}>
        {listing && !items.length && !terms.length && (
          <button
            onClick={() => void pickFiles("global", current, where, toast)}
            className="grid h-32 w-full place-items-center rounded-xl bg-panel text-center text-soft hover:text-text"
          >
            <span>
              <span className="block font-semibold text-text">{current ? `${where} is empty` : "Keep your memes, stickers and sounds here"}</span>
              <span className="mt-1 block text-[13px]">Drop files or a GIF link anywhere on this section, or paste with Ctrl V. Every project and agent can use them.</span>
            </span>
          </button>
        )}
        <div className="grid gap-y-5">
          {laid.map((row, i) => (
            <div key={i} className="flex items-start gap-[14px]">
              {row.items.map(({ it, aspect }) => (
                <ShelfTile
                  key={it.id}
                  it={it}
                  w={Math.floor(row.h * aspect)}
                  h={row.h}
                  actions={actions}
                  renaming={!renaming?.folder && renaming?.path === it.path}
                  onRenamed={(n) => void finishRename(n)}
                  onOpen={() => setPreview(it)}
                />
              ))}
            </div>
          ))}
        </div>
        {!all && !terms.length && items.length > SHELF_LIMIT && (
          <Button variant="ghost" size="sm" className="mt-4 -ml-2.5" onClick={() => setAll(true)}>
            Show all {items.length}
          </Button>
        )}
      </div>
      {preview && <Preview it={preview} onClose={() => setPreview(undefined)} />}
    </section>
  );
}

function FolderChip({ folder, depth, active, onClick, renaming, onRenamed, actions, lib }: { folder: MediaFolder; depth: number; active: boolean; onClick: () => void; renaming: boolean; onRenamed: (n?: string) => void; actions: Actions; lib: Lib }) {
  const drop = useDropZone((e) => void dropInto(e, lib.id, folder.path, folder.path ? folder.name : "Global", actions.toast), (e) => isInternal(e.dataTransfer) || isExternal(e.dataTransfer));
  const label: ReactNode = (
    <>
      {depth > 0 && <span className="text-faint">{folder.path.split("/").slice(0, -1).join(" / ")} / </span>}
      {folder.name}
    </>
  );
  if (renaming) return <RenameInput initial={folder.name} onDone={onRenamed} className="h-7 w-36 text-[12.5px]" />;
  const chip = (
    <button
      {...drop.props}
      onClick={onClick}
      className={cn("h-7 rounded-lg px-2.5 text-[12.5px] font-semibold whitespace-nowrap", active ? "bg-raised text-text" : drop.over ? "bg-amber/20 text-amber" : "text-dim hover:bg-raised/60 hover:text-text")}
    >
      {label}
    </button>
  );
  if (!folder.path) return chip;
  return (
    <ContextMenu>
      <ContextTrigger asChild>{chip}</ContextTrigger>
      <ContextContent>
        <ContextItem onSelect={() => void pickFiles(lib.id, folder.path, folder.name, actions.toast)}>
          <ImagePlus />
          Add files here
        </ContextItem>
        <ContextItem onSelect={() => void newFolder(lib, folder.path, actions)}>
          <FolderPlus />
          New folder inside
        </ContextItem>
        <ContextItem onSelect={() => actions.rename({ lib: lib.id, path: folder.path, folder: true })}>
          <Pencil />
          Rename
        </ContextItem>
        <ContextItem onSelect={() => void window.slate?.openFolder?.(absPath(lib, folder.path) ?? "")}>
          <FolderOpen />
          Show in Explorer
        </ContextItem>
        <ContextSeparator />
        <ContextItem danger onSelect={() => void recycle(lib.id, [folder.path], folder.name, actions.toast)}>
          <Trash2 />
          Move to Recycle Bin
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}

