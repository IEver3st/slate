import { useLayoutEffect, useState } from "react";

export function useWidth<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, width] as const;
}

export function justify<T extends { aspect: number }>(items: T[], width: number, target: number, gap: number) {
  const out: { items: T[]; h: number }[] = [];
  let row: T[] = [];
  let sum = 0;
  for (const it of items) {
    row.push(it);
    sum += it.aspect;
    if (sum * target + gap * (row.length - 1) >= width) {
      out.push({
        items: row,
        h: Math.floor((width - gap * (row.length - 1) - row.length) / sum),
      });
      row = [];
      sum = 0;
    }
  }
  if (row.length) out.push({ items: row, h: target });
  return out;
}
