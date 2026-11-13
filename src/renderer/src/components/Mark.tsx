import { useId, useRef, useSyncExternalStore } from "react";
import fullIcon from "../../../../resources/icon-src/icon.svg";
import smallIconSource from "../../../../resources/icon-src/small.svg?raw";

const REPLAY_GAP_MS = 1200;
let take = 0;
let playedTake = -1;
let lastPlay = -Infinity;
const listeners = new Set<() => void>();

window.slate?.onShown?.(() => {
  if (performance.now() - lastPlay < REPLAY_GAP_MS) return;
  take++;
  for (const notify of listeners) notify();
});

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function useTake() {
  const current = useSyncExternalStore(subscribe, () => take);
  const plays = useRef(false);
  if (current !== playedTake) {
    playedTake = current;
    lastPlay = performance.now();
    plays.current = true;
  }
  return { current, plays: plays.current };
}

function smallIcon(prefix: string, animate: boolean) {
  return smallIconSource
    .replace(/id="([\w-]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([\w-]+)\)/g, `url(#${prefix}$1)`)
    .replace("<svg ", `<svg width="100%" height="100%" class="${animate ? "take" : ""}" `);
}

export function Mark({ size = 22 }: { size?: number }) {
  if (size >= 32) return <img src={fullIcon} width={size} height={size} alt="" draggable={false} className="shrink-0" />;
  return <SmallMark size={size} />;
}

function SmallMark({ size }: { size: number }) {
  const prefix = `mark${useId().replace(/[^\w]/g, "")}`;
  const { current, plays } = useTake();
  return (
    <span
      key={current}
      aria-hidden
      className="block shrink-0"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: smallIcon(prefix, plays) }}
    />
  );
}
