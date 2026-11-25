import { useEffect, useRef, useState } from "react";
import type { ContextLayer, Note, PairDiff, Peaks } from "@/lib/api";
import { media } from "@/lib/api";
import type { PlayerController } from "@/lib/player";
import { cn, tc } from "@/lib/format";
import { tagOf } from "@/lib/tags";
import { Button } from "./ui/button";

export function LayerPicker({ at, layers, onPick, onClose }: { at: { x: number; y: number }; layers?: ContextLayer[]; onPick: (l: ContextLayer) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(at.x, window.innerWidth - r.width - 12), y: Math.min(at.y, window.innerHeight - r.height - 12) });
  }, [at, layers]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const usable = layers?.filter((l) => !l.hidden && l.type !== "Audio" && l.type !== "Adjustment");
  return (
    <div ref={ref} className="hover-preview fixed z-50 w-[300px] rounded-xl bg-raised/95 p-1.5 shadow-pop backdrop-blur-md" style={{ left: pos.x, top: pos.y }}>
      <div className="px-2.5 pt-1.5 pb-1 text-[12.5px] text-dim">Which layer is this note about?</div>
      {!usable && <div className="px-2.5 py-2 text-soft">Reading the layers</div>}
      {usable?.length === 0 && <div className="px-2.5 py-2 text-soft">Nothing visible here</div>}
      <div className="max-h-[320px] overflow-y-auto">
        {usable?.map((l) => (
          <button key={l.id} className="grid w-full rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover" onClick={() => onPick(l)}>
            <span className="truncate font-medium">{l.type === "Text" && l.text ? l.text : l.name}</span>
            <span className="truncate text-[12px] text-dim">
              {l.type}
              {l.path.length ? ` in ${l.path.at(-1)}` : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChangeList({ diff, onSeek }: { diff: PairDiff; onSeek: (ms: number) => void }) {
  const picture = diff.seconds.filter((s) => s.picture === "changed" || s.picture === "only").length;
  const sound = diff.seconds.filter((s) => s.sound === "changed" || s.sound === "only").length;
  const unsure = diff.seconds.filter((s) => (s.picture === "maybe" || s.sound === "maybe") && s.picture !== "changed" && s.sound !== "changed").length;
  return (
    <section className="mx-1 mt-2 mb-1 rounded-xl bg-raised/60 px-3 py-3">
      <div className="font-semibold">
        Changed between r{diff.old} and r{diff.new}
      </div>
      <div className="mt-0.5 text-[12.5px] text-soft">
        {picture} {picture === 1 ? "second" : "seconds"} of picture, {sound} of sound
        {unsure > 0 && `, ${unsure} not checked yet`}
      </div>
      <div className="mt-2 grid gap-0.5">
        {diff.changes.length === 0 && <div className="text-[12.5px] text-dim">No layer changed.</div>}
        {diff.changes.map((c) => (
          <button
            key={`${c.id}-${c.kind}`}
            disabled={c.startMs === undefined}
            onClick={() => c.startMs !== undefined && onSeek(c.startMs)}
            className="-mx-1.5 grid rounded-lg px-1.5 py-1 text-left transition-colors enabled:hover:bg-hover"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{c.name}</span>
              {c.startMs !== undefined && <span className="shrink-0 text-[12px] text-amber">{tc(c.startMs)}</span>}
            </span>
            <span className="truncate text-[12px] text-dim">{c.kind === "changed" ? (c.detail ?? c.fields?.join(", ")) : c.kind === "added" ? `Added in r${diff.new}` : `Removed in r${diff.new}`}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Still({ path }: { path?: string }) {
  const src = path ? media(path) : undefined;
  return src ? (
    <img src={src} className="h-[132px] w-auto shrink-0 rounded-md bg-black object-contain" draggable={false} />
  ) : (
    <div className="grid h-[132px] w-[74px] shrink-0 place-items-center rounded-md bg-ink text-center text-[11px] text-faint">No frame kept</div>
  );
}

export function FixCheck({
  note,
  index,
  total,
  latest,
  replying,
  onReplying,
  onResolve,
  onReopen,
  onSkip,
  onExit,
  comparing,
}: {
  comparing?: number;
  note: Note;
  index: number;
  total: number;
  latest?: number;
  replying: boolean;
  onReplying: (on: boolean) => void;
  onResolve: () => void;
  onReopen: (text: string) => void;
  onSkip: () => void;
  onExit: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => setText(""), [note.id]);
  const answer = [...note.thread].reverse().find((t) => t.author.kind === "agent");
  const tag = tagOf(note.tag);
  return (
    <div className="fix-enter pointer-events-auto absolute inset-x-6 bottom-[64px] z-20 mx-auto max-w-[760px] overflow-hidden rounded-2xl border border-line/70 bg-raised/95 shadow-pop backdrop-blur-md">
      <div className="h-[2px] w-full bg-line/60">
        <div className="h-full bg-teal transition-[width] duration-300" style={{ width: `${((index + 1) / Math.max(1, total)) * 100}%` }} />
      </div>
      <div key={note.id} className="rail-swap flex gap-4 p-4">
        <Still path={note.annotatedFrame ?? note.frame} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="font-semibold text-teal">
              Fix {index + 1} of {total}
            </span>
            <span className="text-dim">
              r{note.rev} at {tc(note.t)}, now r{latest} at {tc(note.displayT)}
            </span>
            {tag && <span className={cn("rounded px-1.5 font-semibold", tag.chip)}>{tag.label}</span>}
          </div>
          <div className="mt-1 line-clamp-2 break-words">{note.text || tag?.sentence}</div>
          {note.anchorGone && <div className="mt-0.5 text-[12.5px] text-red">The layer this note was on is gone, so this is the original time.</div>}
          {answer && (
            <div className="mt-1 line-clamp-2 text-[12.5px] text-soft">
              <span className="font-semibold text-teal">{answer.author.name}</span> {answer.text}
            </div>
          )}
          <div className="flex-1" />
          {replying ? (
            <div className="mt-2 flex gap-2">
              <textarea
                autoFocus
                data-unsent={!!text.trim() || undefined}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (text.trim()) onReopen(text.trim());
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onReplying(false);
                  }
                }}
                placeholder="What still needs to change?"
                rows={1}
                className="min-w-0 flex-1 resize-none rounded-lg bg-ink px-2.5 py-1.5 outline-none placeholder:text-faint"
              />
              <Button variant="primary" disabled={!text.trim()} onClick={() => onReopen(text.trim())}>
                Reopen
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button variant="primary" onClick={onResolve}>
                Looks good <kbd className="font-sans text-[11px] opacity-60">Enter</kbd>
              </Button>
              <Button variant="quiet" onClick={() => onReplying(true)}>
                Not yet <kbd className="font-sans text-[11px] opacity-60">R</kbd>
              </Button>
              <Button variant="ghost" onClick={onSkip}>
                Skip <kbd className="font-sans text-[11px] opacity-60">→</kbd>
              </Button>
              <div className="flex-1" />
              {comparing !== undefined && <span className="text-[12px] text-dim">Hold V to see r{comparing}</span>}
              <Button variant="ghost" onClick={onExit}>
                Done
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Zero-React-re-render 60fps audio level meter synced to the cut's precomputed peaks. */
export function AudioMeter({ controller, peaks }: { controller: PlayerController; peaks?: Peaks }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let smooth = 0;
    let hold = 0;
    let holdAt = 0;
    let raf = 0;

    const paint = () => {
      raf = 0;
      const st = controller.state;
      let target = 0;
      if (peaks && st.playing && !st.muted && st.volume > 0) {
        const s = Math.floor(st.time / 1000);
        const bins = peaks.seconds[s];
        if (bins && bins.length) {
          const idx = Math.min(bins.length - 1, Math.floor(((st.time % 1000) / 1000) * bins.length));
          target = (bins[idx] / 255) * st.volume;
        }
      }
      smooth = target > smooth ? smooth + (target - smooth) * 0.55 : smooth * 0.84;
      if (smooth < 0.005) smooth = 0;
      const now = performance.now();
      if (smooth >= hold) {
        hold = smooth;
        holdAt = now;
      } else if (now - holdAt > 650) {
        hold = Math.max(smooth, hold - 0.035);
      }
      const el = fillRef.current;
      if (el) {
        el.style.transform = `scaleX(${smooth.toFixed(3)})`;
        el.style.backgroundColor = smooth > 0.92 ? "var(--color-red)" : smooth > 0.75 ? "var(--color-amber)" : "var(--color-teal)";
      }
      const hEl = holdRef.current;
      if (hEl) {
        hEl.style.opacity = hold > 0.04 ? "1" : "0";
        hEl.style.left = `${Math.min(98, hold * 100).toFixed(1)}%`;
        hEl.style.backgroundColor = hold > 0.92 ? "var(--color-red)" : hold > 0.75 ? "var(--color-amber)" : "var(--color-teal)";
      }
      if (smooth > 0 || hold > 0 || controller.state.playing) raf = requestAnimationFrame(paint);
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const unsub = controller.subscribe(kick);
    kick();
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [controller, peaks]);

  if (!peaks?.seconds.some(Boolean)) return null;
  return (
    <div
      className="relative mr-1 hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-line/80 @min-[700px]:block"
      title="Live audio level meter"
      aria-hidden
    >
      <div ref={fillRef} className="h-full w-full origin-left rounded-full" style={{ transform: "scaleX(0)" }} />
      <div ref={holdRef} className="absolute inset-y-0 w-[2px] rounded-full opacity-0" />
    </div>
  );
}
