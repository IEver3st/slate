import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, appHome, LEGACY_NAME, legacyHome, legacyShellDir, slateHome } from "../src/home";

type Step = (line: string) => void;

const roaming = () => process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const startMenu = () => join(roaming(), "Microsoft", "Windows", "Start Menu", "Programs");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LEGACY_ID = "dev.ever3st.dailies";
const APP_ID = "dev.ever3st.slate";

function aliveBun(pid: number) {
  if (!pid) return false;
  const p = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return p.stdout.toString().toLowerCase().startsWith('"bun.exe"');
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const under = (file: string, from: string) => file.toLowerCase().startsWith(from.toLowerCase() + "\\");
const moved = (file: string | undefined, from: string, to: string) => (file && under(file, from) ? to + file.slice(from.length) : file);

export function legacyRunning() {
  const query = `(Get-CimInstance Win32_Process -Filter "Name='${LEGACY_NAME}.exe'").ExecutablePath`;
  const p = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const running = p.stdout.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (running.some((exe) => under(exe, legacyShellDir()))) return true;
  const daemon = readJson<{ pid?: number }>(join(legacyHome(), "daemon.json"));
  if (daemon?.pid && aliveBun(daemon.pid)) return true;
  let builder = 0;
  try {
    builder = Number(readFileSync(join(legacyHome(), "releases", ".lock"), "utf8").trim());
  } catch {}
  return aliveBun(builder);
}

export async function legacyStillRunning(patience = 10_000) {
  const until = Date.now() + patience;
  while (legacyRunning()) {
    if (Date.now() > until) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function renameWithPatience(from: string, to: string, patience: number) {
  const until = Date.now() + patience;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (Date.now() > until) throw e;
      await Bun.sleep(500);
    }
  }
}

export const renamedCode = (dir?: string) => !!dir && existsSync(join(dir, "src", "home.ts"));

export function repointReleases(from = legacyHome(), to = slateHome()) {
  const releases = join(to, "releases");
  const current = join(releases, "current.json");
  const c = readJson<{ dir?: string; previous?: string }>(current);
  if (c) {
    const dir = moved(c.dir, from, to);
    const after = moved(c.previous, from, to);
    const previous = renamedCode(after) ? after : undefined;
    if (dir !== c.dir || previous !== c.previous) writeAtomic(current, JSON.stringify({ ...c, dir, previous }, null, 2));
  }
  for (const d of existsSync(releases) ? readdirSync(releases, { withFileTypes: true }) : []) {
    const file = join(releases, d.name, "release.json");
    const r = d.isDirectory() ? readJson<{ dir?: string }>(file) : undefined;
    const dir = moved(r?.dir, from, to);
    if (r && dir !== r.dir) writeAtomic(file, JSON.stringify({ ...r, dir }, null, 2));
  }
}

function leaveMcpShim(from: string) {
  mkdirSync(from, { recursive: true });
  const shim = `import { join } from "node:path";\nimport { pathToFileURL } from "node:url";\n\nawait import(pathToFileURL(join(import.meta.dirname, "..", "${APP_NAME}", "mcp.mjs")).href);\n`;
  writeFileSync(join(from, "mcp.mjs"), shim);
}

export async function moveHome(step: Step) {
  const from = legacyHome();
  const to = slateHome();
  const legacyData = existsSync(join(from, "releases"));
  if (legacyData && existsSync(to)) throw new Error(`Both ${from} and ${to} exist. Move the one that does not hold your library out of the way and run this again.`);
  if (legacyData) {
    if (await legacyStillRunning()) throw new Error(`${LEGACY_NAME} is still running. Quit it from the tray (Quit ${LEGACY_NAME}) and run this again.`);
    try {
      await renameWithPatience(from, to, 20_000);
    } catch (e) {
      throw new Error(`Could not move ${from} to ${to}: ${e instanceof Error ? e.message : e}. Something still has a file open in it; close it and run this again.`);
    }
    step(`Moved ${from} to ${to}`);
  }
  if (!existsSync(to)) return;
  repointReleases(from, to);
  rmSync(join(to, "cache", "slates"), { recursive: true, force: true });
  if (legacyData || existsSync(from)) leaveMcpShim(from);
  for (const [old, next] of [
    [LEGACY_NAME, APP_NAME],
    [`${LEGACY_NAME} Dev`, `${APP_NAME} Dev`],
  ]) {
    const a = join(roaming(), old);
    const b = join(roaming(), next);
    if (!existsSync(a)) continue;
    if (existsSync(b)) {
      step(`Left ${a} in place because ${b} already exists`);
      continue;
    }
    try {
      await renameWithPatience(a, b, 10_000);
      step(`Moved ${a} to ${b}`);
    } catch (e) {
      step(`Could not move ${a} to ${b} (${e instanceof Error ? e.message : e}), so Slate starts with a fresh window profile. Close what holds it and run this again.`);
    }
  }
}

function backup(file: string, content: string) {
  const dir = join(appHome(), "backup");
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/[:\\/]+/g, "_").replace(/^_+/, "");
  const saved = join(dir, `${name}.${Date.now()}.bak`);
  writeFileSync(saved, content);
  return saved;
}

async function rewrite(file: string, change: (raw: string) => string | undefined, step: Step) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await Bun.sleep(250);
    const raw = readFileSync(file, "utf8");
    const next = change(raw);
    if (next === undefined) return undefined;
    if (readFileSync(file, "utf8") !== raw) continue;
    const saved = backup(file, raw);
    writeAtomic(file, next);
    return saved;
  }
  step(`Left ${file} alone because it kept changing while this ran. Rename its dailies MCP server to slate by hand.`);
  return undefined;
}

function claudeConfigs() {
  const home = homedir();
  const dirs = [home, process.env.CLAUDE_CONFIG_DIR, ...readdirSync(home).filter((d) => d.startsWith(".claude")).map((d) => join(home, d))];
  const found = new Map<string, string>();
  for (const d of dirs) {
    const f = d && join(d, ".claude.json");
    if (f && existsSync(f)) found.set(f.toLowerCase(), f);
  }
  return [...found.values()];
}

function renameServer(servers: Record<string, any> | undefined, legacyEntry: string, entry: string) {
  const old = servers?.dailies;
  if (!servers || !old || !Array.isArray(old.args) || !old.args.some((a: unknown) => typeof a === "string" && a.toLowerCase() === legacyEntry.toLowerCase())) return false;
  const next = { ...old, args: old.args.map((a: unknown) => (typeof a === "string" && a.toLowerCase() === legacyEntry.toLowerCase() ? entry : a)) };
  const rebuilt: Record<string, any> = {};
  for (const [k, v] of Object.entries(servers)) {
    if (k === "dailies") {
      if (!servers.slate) rebuilt.slate = next;
    } else rebuilt[k] = v;
  }
  for (const k of Object.keys(servers)) delete servers[k];
  Object.assign(servers, rebuilt);
  return true;
}

export async function moveAgentConfigs(step: Step) {
  const legacyEntry = join(legacyHome(), "mcp.mjs");
  const entry = join(slateHome(), "mcp.mjs");
  const renameInJson = (raw: string) => {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      return undefined;
    }
    let changed = renameServer(j.mcpServers, legacyEntry, entry);
    for (const p of Object.values<any>(j.projects ?? {})) changed = renameServer(p?.mcpServers, legacyEntry, entry) || changed;
    return changed ? JSON.stringify(j, null, 2) : undefined;
  };
  const renameInToml = (raw: string) => {
    const nl = raw.includes("\r\n") ? "\r\n" : "\n";
    const lines = raw.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "[mcp_servers.dailies]");
    if (start < 0 || lines.some((l) => l.trim() === "[mcp_servers.slate]")) return undefined;
    const ownTable = /^\s*\[mcp_servers\.dailies\./;
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l) && !ownTable.test(l));
    if (end < 0) end = lines.length;
    if (!lines.slice(start + 1, end).join(nl).toLowerCase().includes(legacyEntry.toLowerCase())) return undefined;
    const path = new RegExp(legacyEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    lines[start] = "[mcp_servers.slate]";
    for (let i = start + 1; i < end; i++) lines[i] = lines[i].replace(ownTable, (m) => m.replace("dailies", "slate")).replace(path, () => entry);
    return lines.join(nl);
  };
  const codex = join(homedir(), ".codex", "config.toml");
  const files: [string, (raw: string) => string | undefined][] = [...claudeConfigs().map((f) => [f, renameInJson] as [string, typeof renameInJson]), ...(existsSync(codex) ? [[codex, renameInToml] as [string, typeof renameInToml]] : [])];
  for (const [file, change] of files) {
    const saved = await rewrite(file, change, step);
    if (saved) step(`Renamed the dailies MCP server to slate in ${file} (the old file is saved as ${saved})`);
  }
}

export function moveLoginItem(exe: string, step: Step) {
  const q = Bun.spawnSync(["reg", "query", RUN_KEY, "/v", LEGACY_ID], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (q.exitCode !== 0) return;
  const add = Bun.spawnSync(["reg", "add", RUN_KEY, "/v", APP_ID, "/t", "REG_SZ", "/d", `"${exe}" --background`, "/f"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (add.exitCode !== 0) {
    step(`Left the old start-up entry in place because writing the new one failed: ${add.stderr.toString().trim()}`);
    return;
  }
  Bun.spawnSync(["reg", "delete", RUN_KEY, "/v", LEGACY_ID, "/f"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  step(`Start with Windows now opens ${exe}`);
}

export function removeLegacyShell(step: Step) {
  const link = join(startMenu(), `${LEGACY_NAME}.lnk`);
  if (existsSync(link)) {
    rmSync(link, { force: true });
    step(`Removed the ${LEGACY_NAME} Start menu shortcut`);
  }
  const shell = legacyShellDir();
  if (!existsSync(shell)) return;
  if (!existsSync(join(shell, "dailies-install.json"))) {
    step(`Left ${shell} in place: it was not made by this installer`);
    return;
  }
  try {
    rmSync(shell, { recursive: true, force: true, maxRetries: 4 });
    step(`Removed ${shell}`);
  } catch (e) {
    step(`Could not remove ${shell} yet: ${e instanceof Error ? e.message : e}`);
  }
}
