import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packager } from "@electron/packager";
import { appHome, shellDir, slateHome } from "../src/home";
import { legacyStillRunning, moveAgentConfigs, moveHome, moveLoginItem, removeLegacyShell, renamedCode, repointReleases } from "./migrate";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SOURCE = resolve(option("--from-release") ?? join(import.meta.dir, ".."));
const TARGET = shellDir();
const STAGE = `${TARGET}.staging`;
const OLD = `${TARGET}.old`;
const MARKER = "slate-install.json";
const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pid: number) {
  const until = Date.now() + 60_000;
  while (alive(pid) && Date.now() < until) await Bun.sleep(250);
}

async function swapInto(shell: string, target: string, patience: number) {
  const until = Date.now() + patience;
  for (;;) {
    try {
      if (existsSync(target)) {
        rmSync(OLD, { recursive: true, force: true });
        renameSync(target, OLD);
      }
      renameSync(shell, target);
      break;
    } catch (e) {
      if (existsSync(OLD) && !existsSync(target)) renameSync(OLD, target);
      if (Date.now() > until) {
        rmSync(STAGE, { recursive: true, force: true });
        fail(`Could not replace ${target}: Slate may be running from it, or a virus scan still holds a file. Quit Slate from the tray and run this again; it finishes what is left.`);
      }
      await Bun.sleep(500);
    }
  }
  for (const leftover of [STAGE, OLD]) {
    try {
      rmSync(leftover, { recursive: true, force: true });
    } catch {}
  }
}

async function installShell() {
  const electronPkg = join(SOURCE, "node_modules", "electron", "package.json");
  if (!existsSync(electronPkg)) fail(`Electron is missing from ${SOURCE}. Run bun install first.`);
  if (existsSync(TARGET) && !existsSync(join(TARGET, MARKER))) fail(`${TARGET} exists and was not made by this installer. Move it away first.`);
  const electronVersion: string = JSON.parse(readFileSync(electronPkg, "utf8")).version;
  rmSync(STAGE, { recursive: true, force: true });
  let shell: string | undefined;
  try {
    [shell] = await packager({
      dir: join(SOURCE, "shell"),
      out: STAGE,
      tmpdir: false,
      platform: "win32",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      electronVersion,
      name: "Slate",
      executableName: "Slate",
      appVersion: pkg.version,
      buildVersion: `${pkg.version}.0`,
      appCopyright: "Copyright (C) Ever3st",
      icon: join(SOURCE, "resources", "icon.ico"),
      win32metadata: { CompanyName: "Ever3st", FileDescription: "Slate", ProductName: "Slate", InternalName: "Slate", OriginalFilename: "Slate.exe" },
    });
  } catch (e) {
    rmSync(STAGE, { recursive: true, force: true });
    fail(`Packaging the Slate app shell failed: ${e instanceof Error ? e.message : e}`);
  }
  if (!shell) {
    rmSync(STAGE, { recursive: true, force: true });
    fail("Packaging the Slate app shell produced nothing.");
  }
  writeFileSync(join(shell, MARKER), JSON.stringify({ electron: electronVersion, version: pkg.version, installedFrom: SOURCE, installedAt: new Date().toISOString() }, null, 2));
  return { electronVersion, shell };
}

if (process.platform !== "win32") fail("This installer is for Windows.");

process.chdir(process.env.LOCALAPPDATA!);
const step = (line: string) => console.log(line);
const waitPid = Number(option("--wait-pid") ?? 0);
const abort = (message: string): never => {
  rmSync(STAGE, { recursive: true, force: true });
  fail(message);
};
if (!waitPid && (await legacyStillRunning())) fail("Dailies is still running. Quit it from the tray (Quit Dailies) and run this again. Nothing was changed.");
const { electronVersion, shell } = await installShell();
if (waitPid) await waitFor(waitPid);

const alreadyMoved = existsSync(slateHome());
if (alreadyMoved) repointReleases();
const untouched = alreadyMoved ? "" : " Nothing was moved.";
const { readCurrent, update } = await import("./release");
if (!flag("--from-release") && (!renamedCode(readCurrent()?.dir) || flag("--update"))) {
  console.log("Building the production release from GitHub main...");
  const result = update();
  if (result.status === "failed") abort(`Building the production release failed at ${result.step}.${untouched}\n${result.error}`);
}
if (!flag("--from-release") && !renamedCode(readCurrent()?.dir)) abort(`GitHub main does not have the Slate code yet. Push main and run this again.${untouched}`);
try {
  await moveHome(step);
} catch (e) {
  abort(e instanceof Error ? e.message : String(e));
}
await swapInto(shell, TARGET, waitPid ? 30_000 : 10_000);

const exe = join(TARGET, "Slate.exe");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const register = Bun.spawnSync([exe, "--register"], { stdout: "pipe", stderr: "pipe", env });
if (register.exitCode !== 0) fail(`Installed, but registering the Start menu shortcut failed: ${register.stderr.toString().trim()}. Run this again to finish.`);

moveLoginItem(exe, step);
removeLegacyShell(step);
await moveAgentConfigs(step);

const currentFile = join(appHome(), "releases", "current.json");
const current = existsSync(currentFile) ? JSON.parse(readFileSync(currentFile, "utf8")) : undefined;
console.log(`Installed Slate (Electron ${electronVersion}) to ${exe}`);
if (current) console.log(`Production release: ${current.short} ${current.subject}`);
if (flag("--launch")) {
  const commandLine = `"${exe}"${flag("--background") ? " --background" : ""}`;
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${TARGET.replace(/'/g, "''")}' }; $r.ReturnValue`;
  const launched = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (launched.stdout.toString().trim() !== "0") fail(`Installed, but launching Slate failed: ${launched.stderr.toString().trim()}`);
} else {
  console.log("Start menu: Slate. Quit any running Slate and open it from there to get the Slate icon in the taskbar.");
}
