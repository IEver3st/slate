import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { Search, Film, Palette, Settings, Sparkles, ArrowRight, Bot, Layers, MessageSquare } from "lucide-react";
import { cn } from "@/lib/format";
import { cachedCuts } from "@/lib/store";
import { awaitingReview, cutPoster, isWorking, needsYou } from "@/lib/cuts";
import { THEMES } from "../../../shared/themes";
import { preferences, setPreferences } from "@/lib/preferences";
import { openSettings } from "./Settings";
import { openSetup } from "./Setup";
import { togglePanel } from "./Rail";
import { Img } from "./ui/img";
import type { OpenTarget } from "./Library";

export type PaletteCommand = {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  keys?: string;
  icon?: ReactNode;
  badge?: string;
  badgeTone?: "amber" | "teal" | "dim";
  run: () => void;
};

let isOpen = false;
let dynamicCommands: PaletteCommand[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function openCommandPalette() {
  isOpen = true;
  notify();
}

export function closeCommandPalette() {
  if (!isOpen) return;
  isOpen = false;
  notify();
}

export function toggleCommandPalette() {
  isOpen = !isOpen;
  notify();
}

export function setPaletteCommands(commands: PaletteCommand[]) {
  dynamicCommands = commands;
  notify();
}

function usePaletteState() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => isOpen,
  );
}

function useDynamicCommands() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => dynamicCommands,
  );
}

function scoreMatch(query: string, hay: string): number {
  if (!query) return 1;
  const q = query.toLowerCase().trim();
  const h = hay.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const term of terms) {
    const idx = h.indexOf(term);
    if (idx === 0) total += 100;
    else if (idx > 0 && /[\s\-_/:]/.test(h[idx - 1])) total += 75;
    else if (idx > 0) total += 50;
    else {
      let ti = 0;
      for (let i = 0; i < h.length && ti < term.length; i++) if (h[i] === term[ti]) ti++;
      if (ti < term.length) return 0;
      total += 20;
    }
  }
  return total;
}

export function CommandPalette({ onOpenCut, currentCutId }: { onOpenCut: (t: OpenTarget) => void; currentCutId?: string }) {
  const open = usePaletteState();
  const localCommands = useDynamicCommands();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const allCommands = useMemo<PaletteCommand[]>(() => {
    if (!open) return [];
    const cuts = cachedCuts();
    const cutCommands: PaletteCommand[] = cuts
      .filter((c) => !c.missing && c.id !== currentCutId)
      .map((c) => {
        const badge = c.agent?.state === "blocked" ? "Needs answer" : isWorking(c) ? "Working" : needsYou(c) ? "Needs review" : awaitingReview(c) ? `r${c.latest?.n} new` : c.approvedRev && c.approvedRev === c.latest?.n ? "Approved" : undefined;
        const badgeTone: PaletteCommand["badgeTone"] = c.agent?.state === "blocked" || needsYou(c) ? "amber" : isWorking(c) || c.approvedRev === c.latest?.n ? "teal" : "dim";
        return {
          id: `cut:${c.id}`,
          section: "Switch project",
          title: c.name,
          subtitle: `${c.folder}${c.latest ? ` · r${c.latest.n}` : ""}`,
          keywords: `${c.folder} project cut video switch open ${badge ?? ""}`,
          icon: (
            <span className="relative size-6 shrink-0 overflow-hidden rounded-[5px] bg-well">
              <Img src={cutPoster(c)} />
            </span>
          ),
          badge,
          badgeTone,
          run: () => onOpenCut({ cutId: c.id }),
        };
      });

    const appCommands: PaletteCommand[] = [
      ...(!currentCutId
        ? [
            {
              id: "app:rail",
              section: "Workspace",
              title: preferences().agentsPanel ? "Hide agents panel" : "Show agents panel",
              keys: "Ctrl B",
              keywords: "agents sidebar rail activity",
              icon: <Bot className="size-4 text-teal" />,
              run: () => togglePanel(),
            },
          ]
        : []),
      {
        id: "app:setup",
        section: "Workspace",
        title: "Connect an agent",
        subtitle: "Setup check & MCP prompt",
        keywords: "agent mcp claude codex t3 setup connect",
        icon: <Sparkles className="size-4 text-amber" />,
        run: () => openSetup(),
      },
      {
        id: "app:settings",
        section: "Workspace",
        title: "Open Settings",
        keys: "Ctrl ,",
        keywords: "preferences config options",
        icon: <Settings className="size-4 text-soft" />,
        run: () => openSettings(),
      },
      {
        id: "app:shortcuts",
        section: "Workspace",
        title: "Keyboard shortcuts",
        keys: "?",
        keywords: "hotkeys keys help",
        icon: <Layers className="size-4 text-soft" />,
        run: () => openSettings("keyboard"),
      },
      ...THEMES.map((t) => ({
        id: `theme:${t.id}`,
        section: "Theme",
        title: `Theme: ${t.name}`,
        subtitle: t.blurb,
        keywords: `appearance color dark light mode ${t.id}`,
        icon: <Palette className="size-4 text-soft" />,
        badge: preferences().theme === t.id ? "Active" : undefined,
        badgeTone: "teal" as const,
        run: () => void setPreferences({ theme: t.id }),
      })),
    ];

    return [...localCommands, ...cutCommands, ...appCommands];
  }, [open, localCommands, currentCutId, onOpenCut]);

  const filtered = useMemo(() => {
    const query = q.trim();
    const list = allCommands
      .map((cmd) => ({ cmd, score: scoreMatch(query, `${cmd.title} ${cmd.subtitle ?? ""} ${cmd.section} ${cmd.keywords ?? ""}`) }))
      .filter((x) => x.score > 0);
    if (query) list.sort((a, b) => b.score - a.score);
    return list.slice(0, 40).map((x) => x.cmd);
  }, [allCommands, q]);

  useEffect(() => {
    setIdx((i) => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const exec = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    closeCommandPalette();
    cmd.run();
  };

  const grouped = useMemo(() => {
    const groups: { section: string; items: { cmd: PaletteCommand; flatIdx: number }[] }[] = [];
    const bySection = new Map<string, { cmd: PaletteCommand; flatIdx: number }[]>();
    filtered.forEach((cmd, flatIdx) => {
      let arr = bySection.get(cmd.section);
      if (!arr) {
        arr = [];
        bySection.set(cmd.section, arr);
        groups.push({ section: cmd.section, items: arr });
      }
      arr.push({ cmd, flatIdx });
    });
    return groups;
  }, [filtered]);

  return (
    <D.Root open={open} onOpenChange={(o) => !o && closeCommandPalette()}>
      <D.Portal>
        <D.Overlay className="cmd-overlay no-drag fixed inset-0 z-50 bg-[#050b0c]/60 backdrop-blur-[3px]" />
        <D.Content
          aria-describedby={undefined}
          className="cmd-panel no-drag fixed top-[min(16vh,140px)] left-1/2 z-50 flex max-h-[min(68vh,560px)] w-[min(580px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line/80 bg-panel/95 shadow-[0_30px_90px_rgba(0,0,0,.65)] backdrop-blur-xl outline-none"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line/70 px-4">
            <Search className="size-4 shrink-0 text-amber" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  exec(filtered[idx]);
                }
              }}
              placeholder="Jump to a project, revision, cue, or action..."
              className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-text outline-none placeholder:text-faint"
            />
            <kbd className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-dim">Esc</kbd>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.length === 0 && <div className="px-4 py-10 text-center text-soft">No matching commands for “{q.trim()}”.</div>}
            {grouped.map((g) => (
              <div key={g.section} className="mb-2 last:mb-0">
                <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold tracking-wide text-faint uppercase">{g.section}</div>
                {g.items.map(({ cmd, flatIdx }) => {
                  const active = flatIdx === idx;
                  return (
                    <button
                      key={cmd.id}
                      data-cmd-idx={flatIdx}
                      onMouseEnter={() => setIdx(flatIdx)}
                      onClick={() => exec(cmd)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-100",
                        active ? "bg-raised text-text" : "text-soft hover:bg-raised/60",
                      )}
                    >
                      <span className="grid size-6 shrink-0 place-items-center text-soft">
                        {cmd.icon ?? <ArrowRight className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text">{cmd.title}</span>
                        {cmd.subtitle && <span className="block truncate text-[12px] text-dim">{cmd.subtitle}</span>}
                      </span>
                      {cmd.badge && (
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold",
                            cmd.badgeTone === "amber" ? "bg-amber/15 text-amber" : cmd.badgeTone === "teal" ? "bg-teal/15 text-teal" : "bg-ink text-dim",
                          )}
                        >
                          {cmd.badge}
                        </span>
                      )}
                      {cmd.keys && <kbd className="shrink-0 rounded-md bg-ink px-1.5 py-0.5 font-sans text-[11.5px] font-semibold text-soft">{cmd.keys}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-line/60 bg-well/60 px-4 py-2 text-[11.5px] text-dim">
            <span className="flex items-center gap-3">
              <span>
                <kbd className="rounded bg-raised px-1 py-px text-[10.5px] text-soft">↑↓</kbd> navigate
              </span>
              <span>
                <kbd className="rounded bg-raised px-1 py-px text-[10.5px] text-soft">Enter</kbd> run
              </span>
            </span>
            <span>Ctrl K anywhere</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export { Film, MessageSquare };
