import { Tabs as R } from "radix-ui";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/format";

export const Tabs = R.Root;
export const TabsContent = R.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number }>();

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!active) return;
      const lr = el.getBoundingClientRect();
      const ar = active.getBoundingClientRect();
      setBar({ left: ar.left - lr.left, width: ar.width });
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(el, { subtree: true, attributes: true, attributeFilter: ["data-state"], childList: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  return (
    <R.List ref={listRef} className={cn("relative flex gap-5 px-5", className)}>
      {children}
      {bar && (
        <span
          aria-hidden
          className="tab-indicator pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-amber"
          style={{ width: bar.width, transform: `translate3d(${bar.left}px, 0, 0)` }}
        />
      )}
    </R.List>
  );
}

export function Tab({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <R.Trigger
      value={value}
      className="relative py-3 font-medium text-dim transition-colors duration-150 hover:text-soft data-[state=active]:text-text"
    >
      {children}
      {count ? <span className="ml-1.5 text-faint tabular-nums">{count}</span> : null}
    </R.Trigger>
  );
}
