import { app, dialog } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const releases = join(process.env.LOCALAPPDATA, "Slate", "releases");
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const usable = (dir) => dir && existsSync(join(dir, "out", "main", "index.js")) && read(join(dir, "package.json"))?.name === "slate";
const current = read(join(releases, "current.json"));
const dir = [current?.dir, current?.previous].find(usable);
if (dir) {
  await import(pathToFileURL(join(dir, "out", "main", "index.js")).href);
} else {
  await app.whenReady();
  dialog.showErrorBox("Slate", `No production build of Slate was found in ${releases}. Run "bun run deploy" in the Slate repo.`);
  app.exit(1);
}
