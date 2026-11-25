export type SlateEvent =
  | { type: "cuts" }
  | { type: "cut"; cutId: string }
  | { type: "revision"; cutId: string; n: number }
  | { type: "segments"; cutId: string; rev: number; changed: number[] }
  | { type: "render"; cutId: string; rev: number; span: [number, number]; progress: number; state: "rendering" | "done" | "failed"; error?: string }
  | { type: "notes"; cutId: string; noteId?: string }
  | { type: "activity"; cutId: string }
  | { type: "mix"; cutId: string; rev: number }
  | { type: "diff"; cutId: string }
  | { type: "checks"; cutId: string }
  | { type: "export"; cutId: string; cut: string; rev: number; label?: string; state: "queued" | "running" | "done" | "failed" | "cancelled"; progress: number; phase: string; file?: string; bytes?: number; error?: string }
  | { type: "focus"; cutId: string; t?: number; noteId?: string }
  | { type: "agent"; cutId: string; cut: string; name: string; state: string; text: string; progress?: number; step?: string }
  | { type: "library" }
  | { type: "media"; lib: string }
  | { type: "service" }
  | { type: "setup" };

type Listener = (e: SlateEvent) => void;
const listeners = new Set<Listener>();

export function emit(e: SlateEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {}
  }
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
