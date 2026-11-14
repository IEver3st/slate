import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("slate", {
  initialTheme: ipcRenderer.sendSync("slate:initialTheme"),
  connection: () => ipcRenderer.invoke("slate:connection"),
  takeNavigation: () => ipcRenderer.invoke("slate:takeNavigation"),
  takeResume: () => ipcRenderer.invoke("slate:takeResume"),
  onPresenceRequest: (fn: () => unknown) => {
    const handler = (_e: unknown, id: number) => ipcRenderer.send("slate:presence", id, fn());
    ipcRenderer.on("slate:presenceRequest", handler);
    return () => ipcRenderer.off("slate:presenceRequest", handler);
  },
  openFile: () => ipcRenderer.invoke("slate:openFile"),
  openMedia: () => ipcRenderer.invoke("slate:openMedia"),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || undefined;
    } catch {
      return undefined;
    }
  },
  reveal: (path: string) => ipcRenderer.invoke("slate:reveal", path),
  openExternal: (url: string) => ipcRenderer.invoke("slate:openExternal", url),
  updateState: () => ipcRenderer.invoke("slate:updateState"),
  applyUpdate: () => ipcRenderer.invoke("slate:applyUpdate"),
  checkUpdates: () => ipcRenderer.invoke("slate:checkUpdates"),
  rollback: () => ipcRenderer.invoke("slate:rollback"),
  settings: () => ipcRenderer.invoke("slate:settings"),
  setPreferences: (patch: unknown) => ipcRenderer.invoke("slate:setPreferences", patch),
  setStartWithWindows: (on: boolean) => ipcRenderer.invoke("slate:setStartWithWindows", on),
  pickFolder: () => ipcRenderer.invoke("slate:pickFolder"),
  openFolder: (path: string) => ipcRenderer.invoke("slate:openFolder", path),
  openLog: (which: string) => ipcRenderer.invoke("slate:openLog", which),
  onSettings: (fn: (s: unknown) => void) => {
    const handler = (_e: unknown, s: unknown) => fn(s);
    ipcRenderer.on("slate:settings", handler);
    return () => ipcRenderer.off("slate:settings", handler);
  },
  onOpenSettings: (fn: (page?: string) => void) => {
    const handler = (_e: unknown, page?: string) => fn(page);
    ipcRenderer.on("slate:openSettings", handler);
    return () => ipcRenderer.off("slate:openSettings", handler);
  },
  onUpdate: (fn: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown) => fn(state);
    ipcRenderer.on("slate:update", handler);
    return () => ipcRenderer.off("slate:update", handler);
  },
  onNavigate: (fn: (cutId: string) => void) => {
    const handler = (_e: unknown, cutId: string) => fn(cutId);
    ipcRenderer.on("slate:navigate", handler);
    return () => ipcRenderer.off("slate:navigate", handler);
  },
  onShown: (fn: () => void) => {
    const handler = () => fn();
    ipcRenderer.on("slate:shown", handler);
    return () => ipcRenderer.off("slate:shown", handler);
  },
});
