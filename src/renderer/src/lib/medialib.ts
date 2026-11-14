import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, connection, media, onEvent, type MediaItem, type MediaListing } from "./api";
import { setActive } from "./presence";

export const DRAG_TYPE = "application/x-slate-media";
export const MEDIA_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mkv|m4v|mp3|wav|ogg|m4a|flac|aac|opus)$/i;

export type DragItem = { lib: string; path: string; name: string; kind: MediaItem["kind"]; aspect?: number; thumb?: string; folder?: true };

let dragging: DragItem[] | undefined;
export const currentDrag = () => dragging;
export function startDrag(e: React.DragEvent, items: MediaItem[]) {
  dragging = items.map((it) => ({ lib: it.lib, path: it.path, name: it.name, kind: it.kind, aspect: aspectOf(it), thumb: thumbUrl(it) }));
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
  e.dataTransfer.effectAllowed = "copyMove";
}
export function startFolderDrag(e: React.DragEvent, lib: string, folder: { path: string; name: string }) {
  dragging = [{ lib, path: folder.path, name: folder.name, kind: "image", folder: true }];
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
  e.dataTransfer.effectAllowed = "copyMove";
}
export function endDrag() {
  dragging = undefined;
}
export function readDrag(dt: DataTransfer): DragItem[] | undefined {
  const raw = dt.getData(DRAG_TYPE);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DragItem[];
  } catch {
    return undefined;
  }
}
export const isInternal = (dt: DataTransfer) => dt.types.includes(DRAG_TYPE);
export const isExternal = (dt: DataTransfer) => !isInternal(dt) && (dt.types.includes("Files") || dt.types.includes("text/uri-list") || dt.types.includes("text/html"));

export const aspectOf = (it: { width?: number; height?: number; kind: string }) => (it.kind === "audio" ? 2 : it.width && it.height ? it.width / it.height : 1);

export function thumbUrl(it: MediaItem) {
  if (it.kind === "audio") return undefined;
  return media(`/api/media/thumb?lib=${encodeURIComponent(it.lib)}&path=${encodeURIComponent(it.path)}&v=${it.sig}-${it.width ?? 0}`);
}
export function fileUrl(it: { lib: string; path: string }) {
  return media(`/api/media/file?lib=${encodeURIComponent(it.lib)}&path=${encodeURIComponent(it.path)}`);
}

export function useMedia(lib: string | undefined) {
  const [data, setData] = useState<MediaListing>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!lib) return;
    try {
      setData(await api<MediaListing>(`/api/media?lib=${encodeURIComponent(lib)}`));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lib]);
  useEffect(() => {
    setData(undefined);
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if ((e.type === "media" && e.lib === lib) || e.type === "reconnect") {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 120);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [lib, refresh]);
  return { data, error, refresh };
}

export function usePeaks(it: MediaItem | undefined) {
  const [peaks, setPeaks] = useState<number[]>();
  useEffect(() => {
    if (!it || it.kind !== "audio") return;
    let alive = true;
    api<{ peaks: number[] }>(`/api/media/peaks?lib=${encodeURIComponent(it.lib)}&path=${encodeURIComponent(it.path)}`)
      .then((r) => alive && setPeaks(r.peaks))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [it?.lib, it?.path, it?.sig]);
  return peaks;
}

type Playing = { id: string; progress: number } | undefined;
let playing: Playing;
let audio: HTMLAudioElement | undefined;
const playListeners = new Set<() => void>();
const notify = () => playListeners.forEach((l) => l());
let raf = 0;
function tick() {
  if (!audio || !playing) return;
  playing = { ...playing, progress: audio.duration ? audio.currentTime / audio.duration : 0 };
  notify();
  raf = requestAnimationFrame(tick);
}
export function togglePlay(it: MediaItem) {
  if (playing?.id === it.id) return stopPlay();
  stopPlay();
  const url = fileUrl(it);
  if (!url) return;
  audio = new Audio(url);
  audio.volume = 0.8;
  audio.onended = stopPlay;
  playing = { id: it.id, progress: 0 };
  setActive("preview", "a sound is playing");
  notify();
  void audio.play().catch(stopPlay);
  raf = requestAnimationFrame(tick);
}
export function stopPlay() {
  setActive("preview", undefined);
  cancelAnimationFrame(raf);
  audio?.pause();
  audio = undefined;
  if (playing) {
    playing = undefined;
    notify();
  }
}
export function usePlaying() {
  return useSyncExternalStore(
    (l) => {
      playListeners.add(l);
      return () => playListeners.delete(l);
    },
    () => playing,
  );
}

const firstImg = (html: string) => {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m && /^https?:/i.test(m[1]) ? m[1].replace(/&amp;/g, "&") : undefined;
};

export type AddResult = { added: string[]; skipped: number };

async function upload(lib: string, folder: string, file: Blob, name: string): Promise<string[]> {
  const { base, token } = await connection();
  const r = await fetch(`${base}/api/media/upload?lib=${encodeURIComponent(lib)}&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "x-slate-token": token, "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Upload failed (${r.status})`);
  return data.added ?? [];
}

export async function addPaths(lib: string, folder: string, paths: string[]): Promise<AddResult> {
  const r = await api<{ added: string[]; skipped: string[] }>("/api/media/import", { body: { lib, folder, paths } });
  return { added: r.added, skipped: r.skipped.length };
}

export async function addUrl(lib: string, folder: string, url: string): Promise<AddResult> {
  const r = await api<{ added: string[] }>("/api/media/url", { body: { lib, folder, url } });
  return { added: r.added, skipped: 0 };
}

export async function addTransfer(lib: string, folder: string, dt: DataTransfer | null): Promise<AddResult | undefined> {
  if (!dt) return undefined;
  const files = [...dt.files];
  const paths = files.map((f) => window.slate?.pathForFile?.(f)).filter((p): p is string => !!p);
  if (paths.length) return addPaths(lib, folder, paths);
  const html = dt.getData("text/html");
  const uri = dt.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  const text = dt.getData("text/plain").trim();
  const link = (html && firstImg(html)) || uri || (/^https?:\/\/\S+$/i.test(text) ? text : undefined);
  if (link) {
    try {
      return await addUrl(lib, folder, link);
    } catch (e) {
      if (!files.length) throw e;
    }
  }
  if (files.length) {
    const added: string[] = [];
    let skipped = 0;
    for (const f of files) {
      if (!/^(image|video|audio)\//.test(f.type) && !MEDIA_EXT.test(f.name)) {
        skipped++;
        continue;
      }
      added.push(...(await upload(lib, folder, f, f.name && f.name !== "image.png" ? f.name : "Pasted")));
    }
    return { added, skipped };
  }
  return undefined;
}

export const mediaApi = {
  folder: (lib: string, parent: string, name: string) => api<{ path: string }>("/api/media/folder", { body: { lib, parent, name } }),
  rename: (lib: string, path: string, name: string) => api<{ path: string }>("/api/media/rename", { body: { lib, path, name } }),
  move: (items: { lib: string; path: string }[], to: { lib: string; folder: string }, copy = false) => api<{ paths: string[] }>("/api/media/move", { body: { items, to, copy } }),
  recycle: (lib: string, paths: string[]) => api<{ recycled: number }>("/api/media/recycle", { body: { lib, paths } }),
};

export function addedText(r: AddResult, where: string) {
  const n = r.added.length;
  const what = n === 1 ? `Added ${r.added[0].split("/").pop()!.replace(/\.[^.]+$/, "")}` : `Added ${n} files`;
  const skip = r.skipped ? `. Skipped ${r.skipped} that ${r.skipped === 1 ? "isn't" : "aren't"} an image, video or sound` : "";
  return n ? `${what} to ${where}${skip}` : `Nothing added${skip}`;
}

export function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
