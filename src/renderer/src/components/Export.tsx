import { useEffect, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { api, type CutDetail, type ExportJob, type ExportPreset, type ExportPresetId, type ExportRecord } from "@/lib/api";
import { ago, cn, megabytes } from "@/lib/format";
import { Button, Tip } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";

const WIDTH = "w-[162px]";
const PRESET_KEY = "slate-export-preset";

const DEFAULT_PRESETS: ExportPreset[] = [
  { id: "4k60", resolution: "4k", fps: 60, label: "4K60", detail: "3840×2160, 60 fps master" },
  { id: "1080p60", resolution: "1080p", fps: 60, label: "1080p60", detail: "1920×1080, 60 fps standard" },
  { id: "1080p30", resolution: "1080p", fps: 30, label: "1080p30", detail: "1920×1080, 30 fps compact" },
  { id: "720p60", resolution: "720p", fps: 60, label: "720p60", detail: "1280×720, 60 fps fast draft" },
];

function savedPreset(): ExportPresetId {
  try {
    const v = localStorage.getItem(PRESET_KEY) as ExportPresetId | null;
    if (v && DEFAULT_PRESETS.some((p) => p.id === v)) return v;
  } catch {}
  return "4k60";
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function remaining(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s left`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")} left`;
}

function useLiveProgress(job: ExportJob | undefined) {
  const [now, setNow] = useState(Date.now());
  const moving = job?.phase === "rendering" && !!job.rate && !!job.reportedAt;
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [moving]);
  if (!job) return { progress: 0, etaMs: undefined };
  if (!moving || !job.total) return { progress: job.progress, etaMs: job.etaMs };
  const since = Math.max(0, now - job.reportedAt!) / 1000;
  const frames = Math.min(job.completed + job.rate! * since, job.completed + job.rate! * 6, job.total * 0.99);
  const etaMs = job.etaMs !== undefined ? Math.max(1000, job.etaMs - since * 1000) : ((job.total - frames) / job.rate!) * 1000;
  return { progress: Math.max(job.progress, frames / job.total), etaMs };
}

function Running({ cut, job, onCancel }: { cut: CutDetail; job: ExportJob; onCancel: () => void }) {
  const { progress, etaMs } = useLiveProgress(job);
  const pct = Math.floor(progress * 100);
  const presetLabel = job.label ?? "4K60";
  const label =
    job.phase === "waiting" ? `Queued r${job.rev}` : job.phase === "starting" ? `Starting r${job.rev}` : job.phase === "finishing" ? `Finishing r${job.rev}` : `Exporting r${job.rev}`;
  const tip =
    job.phase === "waiting"
      ? `Waiting for ${job.ahead === 1 ? "another export" : `${job.ahead} other exports`} to finish`
      : job.phase === "starting"
        ? `Loading ${cut.name} r${job.rev} for a ${presetLabel} render`
        : job.phase === "finishing"
          ? "Writing the file"
          : `${presetLabel} · ${job.completed} of ${job.total} frames${etaMs !== undefined ? `, about ${remaining(etaMs)}` : ""}`;
  return (
    <Tip label={tip} side="bottom">
      <div className={cn("no-drag relative flex h-8 shrink-0 items-center overflow-hidden rounded-lg bg-raised", WIDTH)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        {job.phase === "starting" || job.phase === "waiting" ? (
          <div className={cn("absolute inset-0 opacity-25", job.phase === "starting" && "rendering-cell")} />
        ) : (
          <div className="progress-shimmer absolute inset-y-0 left-0 overflow-hidden bg-amber/25 transition-[width] duration-200 ease-linear" style={{ width: `${Math.max(2, progress * 100)}%` }} />
        )}
        <span className="relative min-w-0 flex-1 truncate pl-3 text-[13.5px] font-semibold">{label}</span>
        {job.phase === "rendering" && <span className="relative pr-1 text-[12.5px] font-semibold text-amber tabular-nums">{pct}%</span>}
        <button
          onClick={onCancel}
          aria-label="Cancel export"
          className="relative mr-1 grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-text"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </Tip>
  );
}

function Done({ record, presets, onReveal, onExport, fresh }: { record: ExportRecord; presets: ExportPreset[]; onReveal: () => void; onExport: (preset: ExportPresetId) => void; fresh: boolean }) {
  const detail = `${record.label ?? "4K60"}, ${megabytes(record.bytes)}, ${ago(record.at)}`;
  return (
    <div className={cn("no-drag flex h-8 shrink-0 items-center rounded-lg bg-raised", WIDTH, fresh && "landed")}>
      <Tip label={`${fileName(record.file)}, ${detail}`} side="bottom">
        <button onClick={onReveal} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-3 text-left transition-colors hover:bg-hover">
          <span className="truncate text-[13.5px] font-semibold whitespace-nowrap">r{record.rev} exported</span>
        </button>
      </Tip>
      <span className="h-4 w-px bg-line" />
      <Menu>
        <MenuTrigger asChild>
          <button aria-label="Export options" className="grid h-full w-7 shrink-0 place-items-center rounded-r-lg text-dim transition-colors hover:bg-hover hover:text-text">
            <ChevronDown className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <div className="px-2.5 pt-1.5 pb-1 text-[12.5px] text-dim">
            {fileName(record.file)}
            <br />
            {record.width && record.height ? `${record.width}×${record.height}, ` : ""}
            {detail}
          </div>
          <MenuSeparator />
          <MenuItem onSelect={onReveal}>Show in Explorer</MenuItem>
          <MenuItem onSelect={() => void navigator.clipboard.writeText(record.file)}>Copy file path</MenuItem>
          <MenuSeparator />
          {presets.map((p) => (
            <MenuItem key={p.id} onSelect={() => onExport(p.id)}>
              <span className="flex-1">Export r{record.rev} ({p.label})</span>
              <span className="text-[11.5px] text-dim">{p.detail.split(",")[0]}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

export function ExportControl({ cut, viewing, toast }: { cut: CutDetail; viewing: number | undefined; toast: (text: string, tone?: "error") => void }) {
  const state = cut.export;
  const presets = state?.presets?.length ? state.presets : DEFAULT_PRESETS;
  const [preset, setPreset] = useState<ExportPresetId>(savedPreset);
  const [fresh, setFresh] = useState<string>();
  const [starting, setStarting] = useState(false);
  const lastDone = state?.history.find((r) => r.rev === viewing && r.exists);
  useEffect(() => {
    if (!lastDone || Date.now() - Date.parse(lastDone.at) > 4000) return;
    setFresh(lastDone.id);
    const t = setTimeout(() => setFresh(undefined), 1200);
    return () => clearTimeout(t);
  }, [lastDone?.id]);
  if (!state || viewing === undefined) return null;

  const activePreset = presets.find((p) => p.id === preset) ?? presets[0];

  const start = async (chosen: ExportPresetId = preset) => {
    setPreset(chosen);
    try {
      localStorage.setItem(PRESET_KEY, chosen);
    } catch {}
    setStarting(true);
    try {
      await api(`/api/cuts/${cut.id}/export`, { body: { rev: viewing, preset: chosen } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    try {
      await api(`/api/cuts/${cut.id}/export/cancel`, { body: {} });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const reveal = (file: string) => {
    if (window.slate) void window.slate.reveal(file);
    else void navigator.clipboard.writeText(file).then(() => toast("Copied the file path"));
  };

  if (state.job) return <Running cut={cut} job={state.job} onCancel={() => void cancel()} />;
  if (lastDone) return <Done record={lastDone} presets={presets} fresh={fresh === lastDone.id} onReveal={() => reveal(lastDone.file)} onExport={(p) => void start(p)} />;

  const rev = cut.revisions.find((r) => r.n === viewing);
  const blocked = !state.ready.ok ? state.ready.reason : rev && rev.exportable === false ? `r${viewing} is no longer kept on disk, so it cannot be exported` : undefined;
  const failed = state.failure?.rev === viewing ? state.failure : undefined;
  const deleted = state.history.find((r) => r.rev === viewing && !r.exists);
  const tip =
    blocked ??
    (failed
      ? `Last try failed: ${failed.error}`
      : deleted
        ? `The last export of r${viewing} was moved or deleted. Render it again (${activePreset.detail}).`
        : `Render r${viewing} (${activePreset.detail}) into the project folder`);
  return (
    <div className={cn("no-drag inline-flex h-8 shrink-0 items-center rounded-lg", failed && !blocked ? "bg-raised" : "bg-raised", WIDTH)}>
      <Tip label={tip} side="bottom">
        <Button
          variant={failed && !blocked ? "danger" : "quiet"}
          disabled={!!blocked || starting}
          onClick={() => void start(preset)}
          className="h-full min-w-0 flex-1 rounded-r-none px-2.5"
        >
          {failed ? "Retry export" : `Export ${activePreset.label}`}
        </Button>
      </Tip>
      <span className="h-4 w-px bg-line" />
      <Menu>
        <MenuTrigger asChild>
          <button
            disabled={!!blocked || starting}
            aria-label="Choose export preset"
            className="grid h-full w-7 shrink-0 place-items-center rounded-r-lg text-dim transition-colors hover:bg-hover hover:text-text disabled:text-faint"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] font-semibold text-dim">Export preset</div>
          {presets.map((p) => (
            <MenuItem key={p.id} onSelect={() => void start(p.id)}>
              <span className="grid size-4 place-items-center text-amber">{p.id === preset && <Check className="size-3.5" strokeWidth={2.5} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{p.label}</span>
                <span className="block text-[11.5px] text-dim">{p.detail}</span>
              </span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}
