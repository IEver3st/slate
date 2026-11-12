import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_NAME = "Slate";
export const LEGACY_NAME = "Dailies";
export const CUT_DIR = ".slate";
export const LEGACY_CUT_DIR = ".dailies";

const local = () => process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

export const slateHome = () => join(local(), APP_NAME);
export const legacyHome = () => join(local(), LEGACY_NAME);
export const shellDir = () => join(local(), "Programs", APP_NAME);
export const legacyShellDir = () => join(local(), "Programs", LEGACY_NAME);

export function appHome() {
  if (process.env.SLATE_HOME) return resolve(process.env.SLATE_HOME);
  return !existsSync(slateHome()) && existsSync(join(legacyHome(), "releases")) ? legacyHome() : slateHome();
}
