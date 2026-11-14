import type { Presence } from "../../../preload/api";

type Target = NonNullable<Presence["target"]>;

let lastInput = Date.now();
let targetOf: (() => Target) | undefined;
const active = new Map<string, string>();

export function trackTarget(fn: (() => Target) | undefined) {
  targetOf = fn;
}

export function setActive(key: string, reason: string | undefined) {
  if (reason) active.set(key, reason);
  else active.delete(key);
}

export function installPresence() {
  const touch = () => {
    lastInput = Date.now();
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) window.addEventListener(type, touch, { capture: true, passive: true });
  window.addEventListener("dragstart", () => setActive("drag", "you're dragging something"), true);
  for (const type of ["dragend", "drop"] as const) window.addEventListener(type, () => setActive("drag", undefined), true);
  window.slate?.onPresenceRequest?.(() => ({
    lastInput,
    active: active.values().next().value,
    unsent: document.querySelector("[data-unsent]") ? "you have an unsent cue or reply" : undefined,
    target: targetOf?.(),
  }));
}
