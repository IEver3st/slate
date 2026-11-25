import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { appHome, legacyShellDir, shellDir } from "../src/home";

const REPO = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const APP_DIR = appHome();
const T3_CLI = process.env.T3CODE_CLI_PATH ?? join(homedir(), ".t3", "bin", "t3.cmd");
const IN_T3 = !!process.env.T3CODE_THREAD_ID;

function ownerName(): string | undefined {
  try {
    const name = JSON.parse(readFileSync(join(APP_DIR, "settings.json"), "utf8")).owner;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

const OWNER = ownerName();
const WHO = OWNER ?? "the user";
const WHOSE = OWNER ? `${OWNER}'s` : "the user's";

type DaemonInfo = { port: number; token: string };

class SlateError extends Error {}

function readInfo(): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(join(appHome(), "daemon.json"), "utf8"));
    return info.port && info.token ? { port: info.port, token: info.token } : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(info: DaemonInfo | undefined): Promise<boolean> {
  if (!info) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-slate-token": info.token }, signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j.app === "slate" && j.authed === true;
  } catch {
    return false;
  }
}

function launchCommand(): { commandLine: string; cwd: string } {
  const packaged = [
    process.env.SLATE_APP,
    join(shellDir(), "Slate.exe"),
    join(legacyShellDir(), "Dailies.exe"),
    join(REPO, "dist", "win-unpacked", "Slate.exe"),
  ].find((p): p is string => !!p && existsSync(p));
  if (packaged) return { commandLine: `"${packaged}" --background`, cwd: dirname(packaged) };
  const electron = join(REPO, "node_modules", "electron", "dist", "electron.exe");
  if (existsSync(electron) && existsSync(join(REPO, "out", "main", "index.js"))) return { commandLine: `"${electron}" "${REPO}" --background`, cwd: REPO };
  return { commandLine: `"${process.execPath}" "${join(REPO, "daemon", "main.ts")}"`, cwd: REPO };
}

async function launchOutsideJob() {
  const { commandLine, cwd } = launchCommand();
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${cwd.replace(/'/g, "''")}' }; $r.ReturnValue`;
  const p = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (out.trim() !== "0") throw new SlateError(`could not start Slate (${commandLine}): ${(err || out).trim()}`);
}

let starting: Promise<DaemonInfo> | undefined;
async function daemon(): Promise<DaemonInfo> {
  const info = readInfo();
  if (await healthy(info)) return info!;
  starting ??= (async () => {
    await launchOutsideJob();
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      await Bun.sleep(400);
      const next = readInfo();
      if (await healthy(next)) return next!;
    }
    throw new SlateError("Slate did not come up within 45 s. Start it from the Start menu or run `bun daemon/main.ts` in the Slate repo.");
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

let clientId = "";
function clientHeader() {
  if (clientId) return clientId;
  const c = server.server.getClientVersion();
  return c?.name ? `${c.name}/${c.version ?? ""}` : "";
}

async function send(path: string, body?: Record<string, unknown>) {
  const info = await daemon();
  return fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-slate-token": info.token, "content-type": "application/json", "x-slate-client": clientHeader(), "x-slate-t3": IN_T3 ? "1" : "0" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(70_000),
  });
}

async function call(path: string, body?: Record<string, unknown>): Promise<any> {
  let r: Response;
  try {
    r = await send(path, body);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== "ECONNREFUSED" && path !== "/api/agent/wait") throw e;
    const until = Date.now() + 30_000;
    while (Date.now() < until && !(await healthy(readInfo()))) await Bun.sleep(1000);
    r = await send(path, body);
  }
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!r.ok) throw new SlateError(data?.error ?? `Slate returned ${r.status}`);
  return data;
}

type Thread = { id?: string; title?: string; link?: string };
let threadInfo: Promise<Thread> | undefined;
function thread(): Promise<Thread> {
  threadInfo ??= (async () => {
    const id = process.env.T3CODE_THREAD_ID;
    if (!id || !existsSync(T3_CLI)) return { id };
    try {
      const m = /^\s*"([^"]+\.exe)"\s+"([^"]+\.m?js)"\s+%\*/im.exec(readFileSync(T3_CLI, "utf8"));
      if (!m) return { id };
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_CLI_PATH: T3_CLI, T3CODE_HOME: process.env.T3CODE_HOME ?? join(homedir(), ".t3"), T3CODE_DESKTOP_CLI_LAUNCHER: "1" };
      const p = Bun.spawn([m[1], m[2], "thread", "show", id, "--json"], { stdout: "pipe", stderr: "ignore", env, windowsHide: true });
      const timer = setTimeout(() => p.kill(), 8000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      const t = JSON.parse(out).thread;
      return { id, title: t?.title, link: t?.link };
    } catch {
      return { id };
    }
  })();
  return threadInfo;
}

async function agentName(explicit?: string) {
  if (explicit?.trim()) return explicit.trim().slice(0, 60);
  if (process.env.SLATE_AGENT) return process.env.SLATE_AGENT;
  const t = await thread();
  if (t.title) return t.title.length > 48 ? `${t.title.slice(0, 47).trimEnd()}...` : t.title;
  return "Agent";
}

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...text({ error: msg }), isError: true };
  }
}

const cut = z.string().describe("The cut: its .tsrct path or the id returned by slate_open.");
const agent = z.string().optional().describe("Your display name in Slate. Defaults to your T3 thread's title.");

const wake = IN_T3
  ? `When you end your turn, Slate messages your T3 thread when ${WHO} sends notes or approves; slate_wait is only for staying in the loop within a turn.`
  : `Slate cannot wake this session. When you hand a revision over, end your turn and ask ${WHO} to message you after sending notes, or stay in the loop with slate_wait while you iterate together.`;

const server = new McpServer(
  { name: "slate", version: "0.1.0" },
  {
    instructions: [
      `Slate is ${WHOSE} review room for Tesseract (.tsrct) videos. It renders every saved revision of a cut with hardware playback, and ${WHO} leaves timestamped notes, frame drawings and direct edits there. Use it whenever you make or revise a .tsrct video ${WHO} will watch, instead of exporting drafts.`,
      `Loop: slate_open the .tsrct when you start (${WHO} sees it live; read any open notes or direct messages first), slate_status while you work (include optional progress 0..1 and step), edit and save the project with the tsrct CLI as usual, then slate_publish with a one-line summary and the ids of the notes you addressed. Read feedback with slate_feedback, look at its frame and markedFrame PNGs, and answer notes with slate_reply (supports single or batch replies).`,
      `Edits ${WHO} made in Slate are already in the .tsrct: if the project is built from a generator script or config, fold them into it before rebuilding, or the rebuild reverts them. Never edit the .slate folder next to a cut. Use slate_frame or slate_contact_sheet (multi-frame grid with timecodes) instead of \`tsrct preview\`, and use slate_inspect to read timeline layers, automated cutlint/clipping checks, and revision diffs without unpacking the archive. slate_check reports what Slate can see on this PC.`,
      `${WHO} keeps memes, stickers, sound effects and clips in Slate's media library, per project and global. When a note has media, or a video needs a reaction, sticker or sound, look there with slate_media before searching the web; save finds worth keeping with slate_media_add.`,
      wake,
    ].join("\n\n"),
  },
);

server.registerTool(
  "slate_open",
  {
    title: "Open a cut in Slate",
    description: `Register a .tsrct with Slate${IN_T3 ? `, link it to your T3 thread so ${WHOSE} notes reach you` : ""}, show it in the app and start rendering. Call this when you begin work on a video.`,
    inputSchema: { path: z.string().describe("Absolute path to the .tsrct file."), message: z.string().optional().describe("What you are about to do, shown in the activity feed."), agent },
  },
  ({ path, message, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      const r = await call("/api/agent/open", { path: resolve(path), message, agent: await agentName(name), thread: t.id, threadLink: t.link });
      return text({
        ...r,
        next: r.openNotes
          ? `There are ${r.openNotes} open notes. Read them with slate_feedback before editing.`
          : "Work on the cut, then call slate_publish with a summary when the .tsrct is saved.",
        threadLinked: !!t.id,
      });
    }),
);

server.registerTool(
  "slate_status",
  {
    title: "Post your status",
    description: `Tell ${WHO} what you are doing on a cut. state working queues their direct edits instead of writing the file under you; ready means a revision is worth watching; blocked means you need them (they can answer you right inside Slate). Optional progress (0 to 1) and step show a live progress bar.`,
    inputSchema: {
      cut,
      state: z.enum(["working", "ready", "blocked", "idle"]),
      message: z.string().describe("One short line, e.g. 'retiming the hook to the beat'."),
      progress: z.number().min(0).max(1).optional().describe("Optional progress fraction from 0 to 1."),
      step: z.string().optional().describe("Optional short step badge, e.g. '3/5' or 'audio'."),
      agent,
    },
  },
  ({ cut, state, message, progress, step, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      return text(await call("/api/agent/status", { cut, state, message, progress, step, agent: await agentName(name), thread: t.id, threadLink: t.link }));
    }),
);

server.registerTool(
  "slate_publish",
  {
    title: "Publish a revision",
    description: "Call after you saved or committed the .tsrct, even if Slate already picked the save up. It credits the newest unpublished revision to you with your summary, renders only the changed seconds, and marks the listed notes addressed. A warning means nothing new was on disk.",
    inputSchema: {
      cut,
      summary: z.string().describe("One line on what changed, e.g. 'Hook caption shortened, music -3 dB'."),
      addresses: z.array(z.string()).optional().describe("Ids of the notes this revision addresses."),
      agent,
    },
  },
  ({ cut, summary, addresses, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      return text(await call("/api/agent/publish", { cut, summary, addresses, agent: await agentName(name), thread: t.id, threadLink: t.link }));
    }),
);

server.registerTool(
  "slate_feedback",
  {
    title: `Read ${WHOSE} feedback`,
    description:
      `Notes and direct edits on a cut: time, text, the layers visible at that moment, the frame ${WHO} looked at and their drawing on it (PNG paths you can read), a tag (timing, text, audio, framing, remove), the layer the note targets, the revision ${WHO} was comparing against, structured suggestions and exact engine actions. Default is what still needs action.`,
    inputSchema: {
      cut,
      status: z.enum(["actionable", "all", "open", "claimed", "addressed", "resolved", "wontfix"]).optional(),
      since: z.string().optional().describe("ISO time; only notes updated after it."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ cut, status, since }) => guarded(async () => text(await call("/api/agent/feedback", { cut, status, since, agent: await agentName() }))),
);

server.registerTool(
  "slate_wait",
  {
    title: "Wait for feedback",
    description: `Block up to 50 s until ${WHO} sends notes, replies or approves. Use it only while you are actively iterating together; otherwise end your turn.`,
    inputSchema: { cut, since: z.string().optional().describe("ISO time from your last wait or feedback call."), timeoutSec: z.number().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  },
  ({ cut, since, timeoutSec }) => guarded(async () => text(await call("/api/agent/wait", { cut, since, timeoutSec: timeoutSec ?? 45, agent: await agentName() }))),
);

server.registerTool(
  "slate_reply",
  {
    title: "Reply to one or more notes",
    description: "Answer a note in its thread, or batch-reply to multiple notes at once via replies. status claimed = you are on it; addressed = done (prefer slate_publish addresses for changes); wontfix = explain why not.",
    inputSchema: {
      cut,
      note: z.string().optional().describe("Note id for a single reply."),
      text: z.string().optional().describe("Reply text for a single reply."),
      status: z.enum(["claimed", "addressed", "wontfix"]).optional(),
      replies: z
        .array(
          z.object({
            note: z.string(),
            text: z.string(),
            status: z.enum(["claimed", "addressed", "wontfix"]).optional(),
          }),
        )
        .optional()
        .describe("Batch multiple note replies in one call."),
      agent,
    },
  },
  ({ cut, note, text: body, status, replies, agent: name }) =>
    guarded(async () => text(await call("/api/agent/reply", { cut, note, text: body, status, replies, agent: await agentName(name) }))),
);

server.registerTool(
  "slate_frame",
  {
    title: "Get a rendered frame",
    description: "PNG path of a frame of the cut as Slate rendered it. Fast from the render cache; exact=true renders that single frame with the CLI at full quality. Use this instead of `tsrct preview`.",
    inputSchema: { cut, t: z.number().describe("Time in ms."), revision: z.number().int().optional(), exact: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  ({ cut, t, revision, exact }) => guarded(async () => text(await call("/api/agent/frame", { cut, t, revision, exact, agent: await agentName() }))),
);

server.registerTool(
  "slate_contact_sheet",
  {
    title: "Get a multi-frame contact sheet",
    description: "Stitched PNG grid of rendered frames across a cut or time range with burned-in timecodes, so you can visually check pacing, transitions, and framing in one image read.",
    inputSchema: {
      cut,
      revision: z.number().int().optional(),
      times: z.array(z.number()).max(16).optional().describe("Explicit timestamps in ms (up to 16)."),
      fromMs: z.number().optional().describe("Start time in ms when sampling evenly (default 0)."),
      toMs: z.number().optional().describe("End time in ms when sampling evenly (default cut duration)."),
      count: z.number().int().min(2).max(16).optional().describe("Number of evenly spaced frames (default 6)."),
      cols: z.number().int().min(1).max(6).optional().describe("Columns in the grid."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ cut, revision, times, fromMs, toMs, count, cols }) =>
    guarded(async () => text(await call("/api/agent/sheet", { cut, revision, times, fromMs, toMs, count, cols, agent: await agentName() }))),
);

server.registerTool(
  "slate_inspect",
  {
    title: "Inspect layers, checks and diff",
    description: "Inspect a cut's timeline layers, optional visible layers at time t, automated cutlint/audio-clipping checks, and optional revision diff — in one fast call without unpacking the .tsrct.",
    inputSchema: {
      cut,
      revision: z.number().int().optional().describe("Revision number (default latest)."),
      t: z.number().optional().describe("Optional time in ms to list visible layers at that frame."),
      compareWith: z.number().int().optional().describe("Optional earlier revision number to diff against."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ cut, revision, t, compareWith }) => guarded(async () => text(await call("/api/agent/inspect", { cut, revision, t, compareWith, agent: await agentName() }))),
);

server.registerTool(
  "slate_revisions",
  {
    title: "List revisions",
    description: `Every revision of a cut with author, summary, changed layers and changed seconds, plus the revision ${WHO} approved.`,
    inputSchema: { cut },
    annotations: { readOnlyHint: true },
  },
  ({ cut }) => guarded(async () => text(await call("/api/agent/revisions", { cut, agent: await agentName() }))),
);

const cutRef = (c?: string) => (c ? (c.toLowerCase().endsWith(".tsrct") ? resolve(c) : c) : undefined);

server.registerTool(
  "slate_media",
  {
    title: "Find media in the library",
    description: `${WHOSE} media library: memes, stickers, reaction clips, sound effects and music saved for one project or for every project. Returns absolute file paths, folders, kind, size, duration, whether it is animated or transparent, and how to package each kind into a .tsrct.`,
    inputSchema: {
      cut: cut.optional().describe("The cut whose project media to include. Omit to search only the global library."),
      scope: z.enum(["all", "project", "global"]).optional().describe("Default all: the project's media and the global library."),
      query: z.string().optional().describe("Words that must all appear in the name or folder, e.g. 'vine boom'."),
      folder: z.string().optional().describe("Only this folder and its subfolders, e.g. 'Sound effects'."),
      kind: z.enum(["image", "video", "audio"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  ({ cut, scope, query, folder, kind }) => guarded(async () => text(await call("/api/media/find", { cut: cutRef(cut), scope: cut ? scope : "global", query, folder, kind }))),
);

server.registerTool(
  "slate_media_add",
  {
    title: "Save media to the library",
    description: `Copy a local file or folder, or download a link, into ${WHOSE} media library so it shows up in Slate. Page links (Giphy, Tenor, Imgur and similar) work: Slate takes the page's video or image.`,
    inputSchema: {
      path: z.string().optional().describe("Absolute path of an image, video, sound, or a folder of them."),
      url: z.string().optional().describe("A direct media link or a page that shows one."),
      scope: z.enum(["project", "global"]).describe("project keeps it with one cut; global makes it available to every project."),
      cut: cut.optional().describe("Required for scope project."),
      folder: z.string().optional().describe("Folder inside the library, created if missing, e.g. 'Reactions/Cats'."),
      name: z.string().optional().describe("Name to save it under, without the extension."),
    },
  },
  ({ path, url, scope, cut, folder, name }) => guarded(async () => text(await call("/api/media/add", { path: path ? resolve(path) : undefined, url, scope, cut: cutRef(cut), folder, name }))),
);

type Setup = {
  owner?: string;
  tsrct: { found: boolean; path?: string; version?: string; wanted: string };
  ffmpeg: { found: boolean; path?: string; version?: string; encoder: string };
  mcp: { entry: string; exists: boolean };
  release?: { short: string; subject: string };
  t3: boolean;
};
type CheckItem = { item: string; state: "ok" | "missing" | "warn" | "info"; detail: string; fix?: string };

const older = (a: string, b: string) => {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

function checkItems(s: Setup, port: number): CheckItem[] {
  const v = s.tsrct.wanted;
  const tesseractFix = `Install Tesseract CLI ${v}: download tesseract-${v}-windows-x86_64.zip and its .sha256 from https://github.com/mirage-hq/tesseract/releases/tag/v${v}, compare the first word of the .sha256 file with (Get-FileHash <zip> -Algorithm SHA256).Hash, Expand-Archive the zip and run its install.ps1 with powershell -ExecutionPolicy Bypass -File. Slate picks it up within a few seconds.`;
  return [
    { item: "Slate", state: "ok", detail: `running on 127.0.0.1:${port}${s.release ? `, release ${s.release.short}` : ", development build"}` },
    !s.tsrct.found
      ? { item: "Tesseract CLI", state: "missing", detail: "not found", fix: tesseractFix }
      : s.tsrct.version && older(s.tsrct.version, v)
        ? { item: "Tesseract CLI", state: "warn", detail: `${s.tsrct.version} is older than ${v}, the version Slate is tested with`, fix: tesseractFix }
        : { item: "Tesseract CLI", state: "ok", detail: `${s.tsrct.version ?? "found"} at ${s.tsrct.path}` },
    s.ffmpeg.found
      ? { item: "ffmpeg", state: "ok", detail: `${s.ffmpeg.version ?? "found"}, encoder ${s.ffmpeg.encoder}` }
      : { item: "ffmpeg", state: "missing", detail: "not found", fix: "winget install --id Gyan.FFmpeg -e. Slate picks it up within a few seconds." },
    s.mcp.exists
      ? { item: "MCP entry", state: "ok", detail: s.mcp.entry }
      : { item: "MCP entry", state: "missing", detail: `${s.mcp.entry} does not exist`, fix: "Install the production app: run bun scripts/install-windows.ts in the Slate clone." },
    s.owner
      ? { item: "Your name", state: "ok", detail: `agents call you ${s.owner}` }
      : { item: "Your name", state: "missing", detail: "not set", fix: 'Run this check again with --owner "<first name>", or type it in Slate.' },
    {
      item: "Note delivery",
      state: "info",
      detail: s.t3 ? "T3 Code found: Slate messages the agent's T3 thread when notes are sent" : "T3 Code not found: agents pick up notes when you tell them, or while they wait with slate_wait",
    },
  ];
}

async function check() {
  const info = await daemon();
  const s: Setup = await call("/api/setup");
  const items = checkItems(s, info.port);
  return { ready: items.every((i) => i.state === "ok" || i.state === "info"), items };
}

server.registerTool(
  "slate_check",
  {
    title: "Check the Slate setup",
    description: "What Slate can see on this PC: the render service, Tesseract CLI, ffmpeg, the MCP entry, the reviewer's name and how notes reach agents, with a fix for anything missing.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => guarded(async () => text(await check())),
);

if (process.argv.includes("--check")) {
  const args = process.argv.slice(2);
  const ownerArg = args.indexOf("--owner");
  clientId = "slate-check/0.1.0";
  try {
    if (ownerArg >= 0 && args[ownerArg + 1]?.trim()) await call("/api/settings", { owner: args[ownerArg + 1] });
    const result = await check();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      const mark = { ok: "ok  ", missing: "MISS", warn: "WARN", info: "info" };
      const pad = Math.max(...result.items.map((i) => i.item.length));
      console.log("Slate setup check");
      for (const i of result.items) {
        console.log(`  ${mark[i.state]}  ${i.item.padEnd(pad)}  ${i.detail}`);
        if (i.fix) console.log(`        ${" ".repeat(pad)}  fix: ${i.fix}`);
      }
      console.log(result.ready ? "Ready. Start a new agent session to load the slate_* tools." : "Fix the items above, then run this check again.");
    }
    process.exit(result.ready ? 0 : 1);
  } catch (e) {
    console.log(`Slate is not reachable: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`Open Slate from the Start menu and run this again. Logs: ${join(APP_DIR, "daemon.log")}`);
    process.exit(2);
  }
} else {
  await server.connect(new StdioServerTransport());
}
