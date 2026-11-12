import type { LayerChange, ContextLayer } from "./doc";

export type Author = { kind: "you" | "agent" | "unknown"; name: string };

export type Revision = {
  n: number;
  hash: string;
  at: string;
  author: Author;
  summary?: string;
  changes: LayerChange[];
  changedSegments: number[];
  durationMs: number;
  width: number;
  height: number;
  vkeys: string[];
  akeys: string[];
  fileSize: number;
  mtimeMs: number;
  snapshot?: string;
  addresses?: string[];
  published?: boolean;
  keySig?: string;
  saves?: number;
  firstAt?: string;
  fileId?: string;
};

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

export type NoteStatus = "draft" | "open" | "claimed" | "addressed" | "resolved" | "wontfix";
export type NoteTag = "timing" | "text" | "audio" | "framing" | "remove";
export const NOTE_TAGS: NoteTag[] = ["timing", "text", "audio", "framing", "remove"];
export type NoteTarget = { layerId: number; name: string; box?: { x: number; y: number; w: number; h: number } };

export type ThreadEntry = { id: string; author: Author; text: string; at: string; rev?: number; status?: NoteStatus };

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
  humanAt?: string;
  annotations: Annotation[];
  context: ContextLayer[];
  tag?: NoteTag;
  target?: NoteTarget;
  against?: number;
  frame?: string;
  annotatedFrame?: string;
  suggestion?: Suggestion;
  actions?: unknown[];
  overwrittenIn?: number;
  thread: ThreadEntry[];
};

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

export type SegmentState = "ready" | "queued" | "rendering" | "failed" | "missing";

export type CutSummary = {
  id: string;
  path: string;
  name: string;
  folder: string;
  latest?: { n: number; hash: string; at: string; author: Author; durationMs: number; width: number; height: number; summary?: string; changed: number[]; segments: number };
  recent: { n: number; at: string; author: Author }[];
  openNotes: number;
  draftNotes: number;
  agent?: { name: string; state: string; text: string; at: string };
  approvedRev?: number;
  seenRev?: number;
  render: { ready: number; total: number; rendering: boolean; failed: number };
  poster?: string;
  missing?: boolean;
};
