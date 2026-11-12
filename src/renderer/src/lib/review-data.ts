import { useEffect, useState } from "react";
import { api, onEvent, type Checks, type PairDiff, type Peaks } from "./api";

function useLive<T>(path: string | undefined, cutId: string, events: string[]) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    setData(undefined);
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void api<T>(path)
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const off = onEvent((e) => {
      if (e.cutId !== cutId || !events.includes(e.type)) return;
      if (e.type === "render" && e.state !== "done") return;
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [path, cutId]);
  return data;
}

export const useChecks = (cutId: string, rev?: number) => useLive<Checks>(rev === undefined ? undefined : `/api/cuts/${cutId}/checks?rev=${rev}`, cutId, ["checks", "render", "revision"]);

export const usePeaks = (cutId: string, rev?: number) => useLive<Peaks>(rev === undefined ? undefined : `/api/cuts/${cutId}/peaks?rev=${rev}`, cutId, ["render", "segments"]);

export const useDiff = (cutId: string, a?: number, b?: number) =>
  useLive<PairDiff>(a === undefined || b === undefined || a === b ? undefined : `/api/cuts/${cutId}/diff?a=${a}&b=${b}`, cutId, ["diff", "render", "segments"]);
