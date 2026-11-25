import { useEffect, useRef, useState, useCallback } from "react";
import { api, onEvent, type ActivityItem, type CutDetail, type CutSummary, type LibraryFile } from "./api";

let cutsCache: CutSummary[] | undefined;
let libraryCache: LibraryFile[] = [];
let activityCache: ActivityItem[] = [];
const cutCache = new Map<string, { data: CutDetail; at: number }>();
const prefetching = new Map<string, Promise<CutDetail | undefined>>();

const cutKey = (cutId: string, rev?: number) => `${cutId}:${rev ?? "latest"}`;

export function cachedCuts(): CutSummary[] {
  return cutsCache ?? [];
}

export function prefetchCut(cutId: string, rev?: number): Promise<CutDetail | undefined> {
  const k = cutKey(cutId, rev);
  const hit = cutCache.get(k);
  if (hit && Date.now() - hit.at < 8000) return Promise.resolve(hit.data);
  let p = prefetching.get(k);
  if (!p) {
    p = api<CutDetail>(`/api/cuts/${cutId}${rev !== undefined ? `?rev=${rev}` : ""}`)
      .then((d) => {
        cutCache.set(k, { data: d, at: Date.now() });
        if (cutCache.size > 24) cutCache.delete(cutCache.keys().next().value!);
        return d;
      })
      .catch(() => undefined)
      .finally(() => prefetching.delete(k));
    prefetching.set(k, p);
  }
  return p;
}

export function useCuts() {
  const [cuts, setCuts] = useState<CutSummary[] | undefined>(() => cutsCache);
  const [library, setLibrary] = useState<LibraryFile[]>(() => libraryCache);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ cuts: CutSummary[] }>("/api/state");
      cutsCache = s.cuts;
      setCuts(s.cuts);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const refreshLibrary = useCallback(async () => {
    try {
      const l = await api<{ files: LibraryFile[] }>("/api/library");
      libraryCache = l.files;
      setLibrary(l.files);
    } catch {}
  }, []);
  useEffect(() => {
    void refresh();
    void refreshLibrary();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello" || e.type === "media") return;
      if (e.type === "library") void refreshLibrary();
      if (e.type === "render" && e.state === "rendering") {
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderTimer = undefined;
            void refresh();
          }, 900);
        }
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 80);
    });
    return () => {
      off();
      clearTimeout(timer);
      clearTimeout(renderTimer);
    };
  }, [refresh, refreshLibrary]);
  return { cuts, library, error, refresh, refreshLibrary };
}

export function useCut(cutId: string, rev?: number) {
  const key = cutKey(cutId, rev);
  const [cut, setCut] = useState<CutDetail | undefined>(() => cutCache.get(key)?.data ?? cutCache.get(cutKey(cutId))?.data);
  const [error, setError] = useState<string>();
  const revRef = useRef(rev);
  revRef.current = rev;
  const refresh = useCallback(async () => {
    const r = revRef.current;
    try {
      const d = await api<CutDetail>(`/api/cuts/${cutId}${r !== undefined ? `?rev=${r}` : ""}`);
      cutCache.set(cutKey(cutId, r), { data: d, at: Date.now() });
      setCut(d);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cutId]);
  useEffect(() => {
    const cached = cutCache.get(cutKey(cutId, rev))?.data;
    if (cached) setCut(cached);
    void refresh();
  }, [cutId, refresh, rev]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello" || e.type === "media") return;
      if (e.cutId && e.cutId !== cutId) return;
      if (e.type === "render" && e.state === "rendering" && Array.isArray(e.span)) {
        const [from, to] = e.span as [number, number];
        const progress = typeof e.progress === "number" ? e.progress : 0;
        const jobRev = typeof e.rev === "number" ? e.rev : undefined;
        setCut((prev) => {
          if (!prev) return prev;
          const idx = prev.jobs.findIndex((j) => j.from === from && j.to === to && (jobRev === undefined || j.rev === jobRev));
          if (idx < 0) return prev;
          const jobs = prev.jobs.slice();
          jobs[idx] = { ...jobs[idx], state: "running", progress };
          return { ...prev, jobs };
        });
        return;
      }
      if (e.type === "agent" && typeof e.name === "string" && typeof e.state === "string") {
        setCut((prev) =>
          prev
            ? {
                ...prev,
                agent: {
                  name: e.name as string,
                  state: e.state as string,
                  text: String(e.text ?? ""),
                  at: new Date().toISOString(),
                  progress: typeof e.progress === "number" ? e.progress : undefined,
                  step: typeof e.step === "string" ? e.step : undefined,
                },
              }
            : prev,
        );
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), e.type === "render" ? 120 : 50);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [cutId, refresh]);
  return { cut, error, refresh };
}

export function useActivity(limit = 80) {
  const [items, setItems] = useState<ActivityItem[]>(() => activityCache);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ items: ActivityItem[] }>(`/api/activity?limit=${limit}`)
        .then((r) => {
          activityCache = r.items;
          if (alive) setItems(r.items);
        })
        .catch(() => {});
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello" || e.type === "render" || e.type === "media") return;
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    });
    return () => {
      alive = false;
      off();
      clearTimeout(timer);
    };
  }, [limit]);
  return items;
}
