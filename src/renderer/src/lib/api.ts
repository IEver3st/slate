export type Author = { kind: "you" | "agent" | "unknown"; name: string };
export type NoteStatus = "draft" | "open" | "claimed" | "addressed" | "resolved" | "wontfix";
export type NoteTag = "timing" | "text" | "audio" | "framing" | "remove";
export type NoteTarget = { layerId: number; name: string; box?: { x: number; y: number; w: number; h: number } };
export type Annotation =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "pen"; points: [number, number][] }
  | { kind: "pin"; x: number; y: number };
export type Suggestion =
  | { kind: "text"; layerId: number; layer: string; from: string; to: string }
  | { kind: "volume"; layerId: number; layer: string; fromDb: number; toDb: number }
  | { kind: "timing"; layerId: number; layer: string; fromMs: [number, number]; toMs: [number, number] }
  | { kind: "hide"; layerId: number; layer: string; hidden: boolean }
  | { kind: "actions"; actions: unknown[]; summary: string };
export type ThreadEntry = { id: string; author: Author; text: string; at: string; rev?: number; status?: NoteStatus };
export type ContextLayer = { id: number; name: string; type: string; path: string[]; text?: string; asset?: string; sourceMs?: number; volume?: number; hidden?: boolean; hiddenBy?: { id: number; name: string } };
export type Note = {
  id: string;
  kind: "note" | "edit";
  rev: number;
  t: number;
  end?: number;
  author: Author;
  text: string;
  status: NoteStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  annotations: Annotation[];
  context: ContextLayer[];
  tag?: NoteTag;
  target?: NoteTarget;
  against?: number;
  frame?: string;
  annotatedFrame?: string;
  suggestion?: Suggestion;
  overwrittenIn?: number;
  applied?: boolean;
  media?: MediaRef[];
  thread: ThreadEntry[];
  displayT: number;
  moved?: boolean;
  anchorGone?: boolean;
};
export type LayerChange = { id: number; name: string; type: string; kind: "added" | "removed" | "changed"; fields?: string[]; detail?: string };
export type RevisionInfo = {
  n: number;
  at: string;
  author: string;
  authorKind: Author["kind"];
  summary: string;
  changes: LayerChange[];
  changedSeconds: number[];
  durationMs: number;
  size: string;
  hasMovie: boolean;
  movieKey?: string;
  published: boolean;
  restorable: boolean;
  exportable?: boolean;
};
export type TrackItem = {
  id: number;
  name: string;
  type: string;
  start: number;
  end: number;
  hidden?: boolean;
  volume?: number;
  text?: string;
  asset?: string;
  children?: number;
  editable: { timing: boolean; text: boolean; volume: boolean };
};
export type SegmentState = "ready" | "queued" | "rendering" | "failed" | "missing";
export type Activity = {
  id: string;
  at: string;
  author: Author;
  kind: "status" | "revision" | "note" | "reply" | "publish" | "approve" | "edit" | "render" | "export" | "open";
  state?: "working" | "ready" | "blocked" | "idle";
  text: string;
  rev?: number;
  noteId?: string;
};
export type AgentPresence = { name: string; state: string; text: string; at: string };
export type CutSummary = {
  id: string;
  path: string;
  name: string;
  folder: string;
  latest?: { n: number; hash: string; at: string; author: Author; durationMs: number; width: number; height: number; summary?: string; changed: number[]; segments: number };
  recent: { n: number; at: string; author: Author }[];
  openNotes: number;
  draftNotes: number;
  agent?: AgentPresence;
  approvedRev?: number;
  seenRev?: number;
  render: { ready: number; total: number; rendering: boolean; failed: number };
  missing?: boolean;
};
export type ExportRecord = { id: string; rev: number; file: string; at: string; bytes: number; ms: number; encoder: string; width?: number; height?: number; exists: boolean };
export type ExportJob = {
  id: string;
  rev: number;
  phase: "waiting" | "starting" | "rendering" | "finishing";
  ahead: number;
  progress: number;
  completed: number;
  total: number;
  rate?: number;
  etaMs?: number;
  reportedAt?: number;
  startedAt?: number;
  queuedAt: number;
  file?: string;
};
export type ExportState = { profile: string; ready: { ok: boolean; reason?: string }; job?: ExportJob; failure?: { rev: number; error: string; at: string }; history: ExportRecord[] };
export type Collaborator = { thread: string; agent: string; at: string; link?: string };
export type CutDetail = CutSummary & {
  rev?: number;
  revisions: RevisionInfo[];
  timeline: TrackItem[];
  segments: SegmentState[];
  changedSegments: number[];
  movie?: { rev: number; key: string; stale: number[]; missing: number[]; complete: boolean };
  jobs: { id: string; rev: number; from: number; to: number; state: string; progress?: number }[];
  renderError?: string;
  storageNotice?: string;
  snapshotBytes: number;
  export?: ExportState;
  notes: Note[];
  activity: Activity[];
  collaborators: Collaborator[];
};
export type Verdict = "same" | "changed" | "maybe" | "only";
export type PairDiff = { old: number; new: number; a: number; b: number; seconds: { s: number; picture: Verdict; sound: Verdict }[]; changes: (LayerChange & { startMs?: number; endMs?: number })[]; pending: number };
export type Finding = { level: "error" | "warning" | "allowed"; rule: string; message: string; atMs?: number; source: "cutlint" | "sound" };
export type Checks = { lint: "ready" | "running" | "missing" | "failed"; sound: "ready" | "waiting"; findings: Finding[] };
export type Peaks = { binMs: number; seconds: (number[] | null)[] };
export type LibraryFile = { path: string; name: string; folder: string; size: number; mtimeMs: number; registered?: boolean; id?: string; durationMs?: number; width?: number; height?: number; group?: string; poster?: boolean };
export type MediaKind = "image" | "video" | "audio";
export type MediaItem = { id: string; lib: string; path: string; file: string; name: string; ext: string; folder: string; kind: MediaKind; size: number; mtimeMs: number; sig: string; width?: number; height?: number; durationMs?: number; animated?: boolean; alpha?: boolean };
export type MediaFolder = { path: string; name: string; count: number };
export type MediaListing = { lib: string; root: string; scope: "global" | "project"; folders: MediaFolder[]; items: MediaItem[] };
export type Placement = { x: number; y: number; w: number; h: number };
export type MediaRef = { lib: "global" | "project"; path: string; file: string; sig?: string; missing?: boolean; name: string; kind: MediaKind; folder: string; width?: number; height?: number; durationMs?: number; placement?: Placement };
export type ActivityItem = Activity & { cutId: string; cut: string };
export type SlateEvent = { type: string; cutId?: string; [k: string]: unknown };
export type AgentClient = { id: string; name: string; version?: string; t3?: boolean; firstAt: string; lastAt: string };
export type SetupState = {
  owner?: string;
  onboardedAt?: string;
  tsrct: { found: boolean; path?: string; version?: string; wanted: string };
  ffmpeg: { found: boolean; path?: string; version?: string; encoder: string };
  bun: { path: string; version: string };
  mcp: { entry: string; exists: boolean };
  release?: { short: string; subject: string };
  t3: boolean;
  appDir: string;
  repo: string;
  roots: string[];
  clients: AgentClient[];
};

let conn: Promise<{ base: string; token: string }> | undefined;
let known: { base: string; token: string } | undefined;

export function connection() {
  conn ??= (async () => {
    if (window.slate) {
      const c = await window.slate.connection();
      return { base: location.origin, token: c.token };
    }
    const u = new URL(location.href);
    const token = u.searchParams.get("token") ?? localStorage.getItem("slate-token") ?? "";
    if (token) localStorage.setItem("slate-token", token);
    return { base: location.origin, token };
  })().then((c) => (known = c));
  return conn;
}

export function media(path: string) {
  if (!known) return undefined;
  return `${known.base}${path}${path.includes("?") ? "&" : "?"}token=${known.token}`;
}

export class ApiError extends Error {}

function reconnect() {
  if (window.slate) conn = undefined;
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }, retry = true): Promise<T> {
  const { base, token } = await connection();
  const r = await fetch(base + path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: { "x-slate-token": token, ...(init?.body ? { "content-type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  if (r.status === 401 && retry && window.slate) {
    reconnect();
    return api<T>(path, init, false);
  }
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new ApiError(data.error ?? `Request failed (${r.status})`);
  return data as T;
}

export async function mediaUrl(path: string) {
  const { base, token } = await connection();
  return `${base}${path}${path.includes("?") ? "&" : "?"}token=${token}`;
}

type Listener = (e: SlateEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

export function onEvent(fn: Listener) {
  listeners.add(fn);
  if (!source) void openStream();
  return () => listeners.delete(fn);
}

async function openStream() {
  const { base, token } = await connection();
  if (source) return;
  source = new EventSource(`${base}/api/events?token=${token}`);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data) as SlateEvent;
    for (const l of listeners) l(e);
  };
  source.onerror = () => {
    source?.close();
    source = undefined;
    reconnect();
    setTimeout(() => {
      if (listeners.size) {
        void openStream();
        for (const l of listeners) l({ type: "reconnect" });
      }
    }, 1500);
  };
}
