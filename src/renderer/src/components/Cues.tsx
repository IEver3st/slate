import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { MoreHorizontal, Square, ArrowUpRight, PenLine, MapPin, X, CornerDownRight, Crosshair } from "lucide-react";
import type { Annotation, CutDetail, Note, NoteTag, NoteTarget } from "@/lib/api";
import { TAGS, tagOf, sendable, unwritten } from "@/lib/tags";
import { api, mediaUrl } from "@/lib/api";
import { ago, cn, tc } from "@/lib/format";
import { Button, IconButton } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import type { Tool } from "./Sketch";
import { preferences } from "@/lib/preferences";
import { MediaChips } from "./Media";

const statusText: Record<Note["status"], string> = {
  draft: "Draft",
  open: "Sent",
  claimed: "Agent is on it",
  addressed: "Addressed",
  resolved: "Resolved",
  wontfix: "Won't fix",
};

function statusTone(n: Note) {
  if (n.kind === "edit" && n.overwrittenIn && n.status !== "resolved" && n.status !== "wontfix") return "text-red";
  if (n.status === "addressed") return "text-teal";
  if (n.status === "claimed") return "text-teal";
  if (n.status === "draft") return "text-dim";
  if (n.status === "resolved" || n.status === "wontfix") return "text-faint";
  return "text-amber";
}

function MarkedFrame({ path }: { path: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    void mediaUrl(path).then(setSrc);
  }, [path]);
  return src ? <img src={src} className="mt-2 h-32 w-auto rounded-md" draggable={false} /> : null;
}

function CueCard({
  cut,
  note,
  index,
  selected,
  onSelect,
  onSeek,
  agentName,
  toast,
}: {
  cut: CutDetail;
  note: Note;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onSeek: (ms: number) => void;
  agentName?: string;
  toast: (msg: string, tone?: "error") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const done = note.status === "resolved" || note.status === "wontfix";

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  useEffect(() => setText(note.text), [note.text]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const patch = (body: Record<string, unknown>) => api(`/api/cuts/${cut.id}/notes/${note.id}`, { method: "PATCH", body });
  const sendReply = (status?: string) =>
    run(async () => {
      if (!replyText.trim() && !status) return;
      await api(`/api/cuts/${cut.id}/notes/${note.id}/reply`, { body: { text: replyText.trim(), status } });
      setReplyText("");
      setReplying(false);
    });

  const edit = note.kind === "edit";
  const queued = edit && note.applied === false;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn("grid grid-cols-[24px_1fr] gap-x-3 gap-y-1.5 rounded-xl px-3 py-3 transition-colors", selected ? "bg-raised" : "hover:bg-panel/60", done && !selected && "opacity-60")}
    >
      <div
        className={cn(
          "mt-px grid size-6 place-items-center rounded-full text-[12px] font-bold",
          note.status === "draft" ? "text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]" : done || note.status === "addressed" ? "bg-hover text-soft" : "bg-amber text-amber-ink",
        )}
      >
        {index + 1}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <button
          className="font-semibold text-amber hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onSeek(note.displayT);
          }}
        >
          {tc(note.displayT)}
          {note.end !== undefined && note.end > note.t && <span className="font-normal text-dim"> to {tc(note.end + (note.displayT - note.t))}</span>}
        </button>
        {edit && <span className="text-[12.5px] text-soft">Edit</span>}
        {note.tag && <span className={cn("rounded px-1.5 text-[12px] leading-[18px] font-semibold", tagOf(note.tag)?.chip)}>{tagOf(note.tag)?.label}</span>}
        <span className={cn("ml-auto shrink-0 text-[12.5px]", statusTone(note))}>
          {edit && note.overwrittenIn && !done ? `Overwritten in r${note.overwrittenIn}` : queued ? `Waiting for ${agentName ?? "the agent"}` : edit && note.status === "open" ? "Applied" : statusText[note.status]}
        </span>
        <Menu onOpenChange={(o) => !o && setArmed(false)}>
          <MenuTrigger asChild>
            <button className="-my-1 grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-text" aria-label="Note actions" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            {note.status === "draft" && <MenuItem onSelect={() => setEditing(true)}>Edit text</MenuItem>}
            {edit && queued && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/apply`, { body: {} }), "Edit applied")}>Apply now</MenuItem>}
            {edit && note.overwrittenIn && !done && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/apply`, { body: {} }), "Edit re-applied")}>Re-apply edit</MenuItem>}
            {edit && !queued && note.status !== "wontfix" && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/undo`, { body: {} }), "Edit undone")}>Undo edit</MenuItem>}
            {!done && note.status !== "draft" && <MenuItem onSelect={() => void run(() => patch({ status: "resolved" }))}>Resolve</MenuItem>}
            {(done || note.status === "addressed") && <MenuItem onSelect={() => void run(() => patch({ status: "open" }))}>Reopen</MenuItem>}
            <MenuItem onSelect={() => void navigator.clipboard.writeText(note.id)}>Copy note id</MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={(e) => {
                if (preferences().confirmDelete && !armed) {
                  e.preventDefault();
                  setArmed(true);
                  return;
                }
                void run(() => api(`/api/cuts/${cut.id}/notes/${note.id}`, { method: "DELETE" }));
              }}
            >
              {armed ? "Click again to delete" : "Delete"}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="col-start-2 min-w-0">
        {editing ? (
          <textarea
            autoFocus
            data-unsent={text !== note.text || undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run(() => patch({ text })).then(() => setEditing(false));
              }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => {
              if (text !== note.text) void run(() => patch({ text }));
              setEditing(false);
            }}
            className="w-full resize-none rounded-lg bg-ink px-2.5 py-2 outline-none"
            rows={Math.min(6, Math.max(2, Math.ceil(text.length / 38)))}
          />
        ) : (
          <div className="break-words whitespace-pre-wrap" onDoubleClick={() => note.status === "draft" && setEditing(true)}>
            {note.text || <span className="text-dim">{note.tag ? tagOf(note.tag)?.sentence : unwritten(note) ? "Marker, not written yet" : ""}</span>}
          </div>
        )}
        {note.media && note.media.length > 0 && <MediaChips refs={note.media} lib={(r) => (r.lib === "project" ? cut.id : "global")} onOpen={(r) => void window.slate?.reveal(r.file)} />}
        {note.target && <div className="mt-1 truncate text-[12px] text-soft">On {note.target.name}</div>}
        {note.against !== undefined && <div className="mt-1 text-[12px] text-dim">Compared with r{note.against}</div>}
        {note.moved && <div className="mt-1 text-[12px] text-dim">Moved with its layer from {tc(note.t)}</div>}
        {note.anchorGone && <div className="mt-1 text-[12px] text-red">The layer this note was on is gone</div>}
        {note.annotatedFrame && (selected || note.status === "draft") && <MarkedFrame path={note.annotatedFrame} />}
        {note.thread.length > 0 && (
          <div className="mt-2 grid gap-1.5">
            {note.thread.map((t) => (
              <div key={t.id} className="flex gap-2 text-soft">
                <CornerDownRight className="mt-[3px] size-3.5 shrink-0 text-faint" />
                <div className="min-w-0">
                  <span className={cn("mr-1.5 font-semibold", t.author.kind === "agent" ? "text-teal" : "text-text")}>{t.author.name}</span>
                  {t.text}
                  <span className="ml-1.5 text-[12px] text-faint">{ago(t.at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {selected && note.status !== "draft" && !replying && (
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" variant="quiet" onClick={() => setReplying(true)}>
              Reply
            </Button>
            {note.status === "addressed" && (
              <Button size="sm" variant="quiet" onClick={() => void run(() => patch({ status: "resolved" }))}>
                Looks good
              </Button>
            )}
            {(note.status === "addressed" || done) && (
              <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
                Not yet
              </Button>
            )}
          </div>
        )}
        {replying && (
          <div className="mt-2.5 grid gap-2">
            <textarea
              autoFocus
              data-unsent={!!replyText.trim() || undefined}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendReply(note.status === "addressed" || done ? "open" : undefined);
                }
                if (e.key === "Escape") setReplying(false);
              }}
              placeholder={note.status === "addressed" || done ? "What still needs to change?" : "Reply"}
              className="w-full resize-none rounded-lg bg-ink px-2.5 py-2 outline-none placeholder:text-faint"
              rows={2}
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!replyText.trim()} onClick={() => void sendReply(note.status === "addressed" || done ? "open" : undefined)}>
                {note.status === "addressed" || done ? "Reopen" : "Reply"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export type ComposerHandle = { focus: () => void; send: () => void };

export const Cues = forwardRef<
  ComposerHandle,
  {
    cut: CutDetail;
    cues: Note[];
    selected?: string;
    onSelect: (id: string) => void;
    onSeek: (ms: number) => void;
    now: number;
    range?: { in: number; out: number };
    onDismissRange: () => void;
    tool?: Tool;
    onTool: (t?: Tool) => void;
    pending: Annotation[];
    onClearPending: () => void;
    captureMarked: (extra?: Annotation[]) => string | undefined;
    target?: NoteTarget & { measuring?: boolean };
    onClearTarget: () => void;
    against?: number;
    onNextUnwritten: (after?: string) => void;
    onFixCheck: () => void;
    toast: (msg: string, tone?: "error") => void;
  }
>(function Cues({ cut, cues, selected, onSelect, onSeek, now, range, onDismissRange, tool, onTool, pending, onClearPending, captureMarked, target, onClearTarget, against, onNextUnwritten, onFixCheck, toast }, ref) {
  const [text, setText] = useState("");
  const [tag, setTag] = useState<NoteTag | null>();
  const [showDone, setShowDone] = useState(() => preferences().showResolved);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const done = cues.filter((n) => n.status === "resolved" || n.status === "wontfix");
  const visible = showDone ? cues : cues.filter((n) => !done.includes(n));
  const agentName = cut.collaborators.at(-1)?.agent ?? cut.agent?.name;
  const bound = cues.find((n) => n.id === selected && unwritten(n));
  const at = range ? range.in : now;
  const shownTag = tag === null ? undefined : (tag ?? bound?.tag);
  const hasContent = !!(text.trim() || pending.length || target || (bound ? tag !== undefined : tag));
  const sendCount = cues.filter(sendable).length + (hasContent && (!bound || !sendable(bound)) ? 1 : 0);
  const fixes = cues.filter((n) => n.status === "addressed" && n.kind === "note").length;

  useEffect(() => {
    setTag(undefined);
    setText("");
  }, [bound?.id]);

  const reset = () => {
    setText("");
    setTag(undefined);
    onClearPending();
    onClearTarget();
    onTool(undefined);
  };

  const commit = async () => {
    if (!hasContent) return false;
    setBusy(true);
    const targetBody = target ? { layerId: target.layerId, name: target.name, box: target.box } : undefined;
    try {
      if (bound) {
        await api(`/api/cuts/${cut.id}/notes/${bound.id}`, {
          method: "PATCH",
          body: {
            text: text.trim(),
            tag: shownTag ?? null,
            annotations: [...bound.annotations, ...pending],
            annotatedFrame: pending.length ? captureMarked(bound.annotations) : undefined,
            target: targetBody,
          },
        });
        reset();
        onNextUnwritten(bound.id);
        return true;
      }
      const n = await api<Note>(`/api/cuts/${cut.id}/notes`, {
        body: {
          t: Math.round(at),
          end: range ? Math.round(range.out) : undefined,
          rev: cut.rev,
          text: text.trim() || (pending.length && !shownTag && !target ? "See the marked frame" : ""),
          annotations: pending,
          annotatedFrame: pending.length ? captureMarked() : undefined,
          tag: shownTag,
          target: targetBody,
          against,
        },
      });
      reset();
      if (range) onDismissRange();
      onSelect(n.id);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (hasContent) await commit();
    try {
      const r = await api<{ published: number; leftBehind?: number; delivered: string[] }>(`/api/cuts/${cut.id}/publish`, { body: {} });
      const stay = r.leftBehind ?? 0;
      const left = stay ? `. ${stay} unwritten ${stay === 1 ? "marker stays a draft" : "markers stay drafts"}` : "";
      if (!r.published) {
        if (stay) toast(`Nothing to send yet. Write or tag your ${stay === 1 ? "marker" : "markers"} first`);
        return;
      }
      const notes = `${r.published} ${r.published === 1 ? "note" : "notes"}`;
      toast(r.delivered.length ? `Sent ${notes} to ${agentName ?? "the agent"}${left}` : `Sent ${notes}. No agent thread is linked, so they wait in slate_feedback${left}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), send: () => void send() }));

  const tools: { t: Tool; label: string; keys: string; icon: React.ReactNode }[] = [
    { t: "rect", label: "Box", keys: "R", icon: <Square /> },
    { t: "arrow", label: "Arrow", keys: "A", icon: <ArrowUpRight /> },
    { t: "pen", label: "Draw", keys: "D", icon: <PenLine /> },
    { t: "pin", label: "Pin", keys: "P", icon: <MapPin /> },
    { t: "target", label: "Pick the layer", keys: "T", icon: <Crosshair /> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {fixes > 0 && (
          <button className="mx-1 mt-2 mb-1 grid w-[calc(100%-8px)] rounded-xl bg-teal/10 px-3 py-2.5 text-left hover:bg-teal/15" onClick={onFixCheck}>
            <span className="font-semibold text-teal">
              Check {fixes} {fixes === 1 ? "fix" : "fixes"}
            </span>
            <span className="text-[12.5px] text-soft">Marked addressed. Watch each one and say if it looks good.</span>
          </button>
        )}
        {visible.length === 0 && (
          <div className="px-4 pt-8 text-soft">
            <div className="font-semibold text-text">Nothing noted yet</div>
            <p className="mt-1">Press M while it plays to drop a marker, or pause and write what to change. Notes stay drafts until you send them.</p>
          </div>
        )}
        {visible.map((n) => (
          <CueCard key={n.id} cut={cut} note={n} index={cues.indexOf(n)} selected={selected === n.id} onSelect={() => onSelect(n.id)} onSeek={onSeek} agentName={agentName} toast={toast} />
        ))}
        {done.length > 0 && (
          <button className="mx-3 mt-1 text-[12.5px] text-dim hover:text-text" onClick={() => setShowDone(!showDone)}>
            {showDone ? "Hide resolved" : `Show ${done.length} resolved`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 px-4 pt-3 pb-4">
        <div className={cn("rounded-xl bg-ink px-3 pt-2.5 pb-2 focus-within:shadow-[inset_0_0_0_1px_var(--color-line)]", bound && "shadow-[inset_0_0_0_1px_var(--color-amber)] focus-within:shadow-[inset_0_0_0_1px_var(--color-amber)]")}>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]">
            <span className="font-semibold text-amber">{bound ? `Marker ${cues.indexOf(bound) + 1} at ${tc(bound.displayT)}` : range ? `${tc(range.in)} to ${tc(range.out)}` : tc(now)}</span>
            {range && !bound && (
              <button aria-label="Note the frame instead of the range" className="grid size-4 place-items-center self-center rounded text-dim hover:text-text" onClick={onDismissRange}>
                <X className="size-3" />
              </button>
            )}
            {target && (
              <span className="flex min-w-0 items-center gap-1 text-soft">
                <span className="truncate">
                  On {target.name}
                  {target.measuring && <span className="text-dim">, finding it</span>}
                </span>
                <button aria-label="Clear the layer" className="grid size-4 shrink-0 place-items-center rounded text-dim hover:text-text" onClick={onClearTarget}>
                  <X className="size-3" />
                </button>
              </span>
            )}
            {pending.length > 0 && (
              <span className="flex items-center gap-1 text-soft">
                {pending.length} {pending.length === 1 ? "mark" : "marks"}
                <button aria-label="Clear marks" className="grid size-4 place-items-center rounded text-dim hover:text-text" onClick={onClearPending}>
                  <X className="size-3" />
                </button>
              </span>
            )}
            {against !== undefined && !bound && <span className="text-dim">against r{against}</span>}
          </div>
          <textarea
            ref={input}
            data-unsent={hasContent || undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void commit();
              } else if (e.key === "Tab" && !e.shiftKey && !text.trim()) {
                e.preventDefault();
                onNextUnwritten(bound?.id);
              } else if (e.key === "Escape") input.current?.blur();
            }}
            placeholder={bound ? "What's wrong here? Enter saves and moves on" : range ? "Note this range" : "Note this frame"}
            rows={2}
            className="mt-1 w-full resize-none bg-transparent outline-none placeholder:text-faint"
          />
          <div className="flex flex-wrap gap-1 pb-0.5">
            {TAGS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTag(shownTag === t.id ? null : t.id)}
                className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-semibold", shownTag === t.id ? t.chip : "text-dim hover:bg-hover hover:text-soft")}
              >
                {t.label}
                <span className="text-[11px] font-normal text-faint">{t.key}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {tools.map((x) => (
            <IconButton key={x.t} label={x.label} keys={x.keys} active={tool === x.t} onClick={() => onTool(tool === x.t ? undefined : x.t)}>
              {x.icon}
            </IconButton>
          ))}
          <div className="flex-1" />
          <Button variant="quiet" disabled={busy || !hasContent} onClick={() => void commit()}>
            {bound ? "Save" : "Add"}
          </Button>
          <Button
            variant="primary"
            className="min-w-0 !shrink !gap-1"
            title={sendCount && agentName ? `Send ${sendCount} to ${agentName}` : undefined}
            disabled={!sendCount}
            onClick={() => void send()}
          >
            <span className="shrink-0">{sendCount ? `Send ${sendCount}` : "Send"}</span>
            {sendCount > 0 && agentName && <span className="min-w-0 truncate">to {agentName}</span>}
          </Button>
        </div>
      </div>
    </div>
  );
});
