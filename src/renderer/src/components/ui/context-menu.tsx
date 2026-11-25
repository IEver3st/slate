import { ContextMenu as C } from "radix-ui";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export const ContextMenu = C.Root;
export const ContextTrigger = C.Trigger;

const panel = "pop-content z-50 min-w-52 max-h-[70vh] overflow-y-auto rounded-xl bg-raised/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,.5)] backdrop-blur-md";
const row = "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors duration-100 data-[disabled]:text-faint data-[highlighted]:bg-hover data-[state=open]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0";

export function ContextContent({ children }: { children: ReactNode }) {
  return (
    <C.Portal>
      <C.Content className={panel}>{children}</C.Content>
    </C.Portal>
  );
}

export function ContextItem({ children, onSelect, danger, disabled, keys }: { children: ReactNode; onSelect?: (e: Event) => void; danger?: boolean; disabled?: boolean; keys?: string }) {
  return (
    <C.Item disabled={disabled} onSelect={onSelect} className={cn(row, danger ? "text-red" : "text-text")}>
      {children}
      {keys && <span className="ml-auto pl-4 text-[12px] text-faint">{keys}</span>}
    </C.Item>
  );
}

export function ContextSub({ label, icon, children, disabled }: { label: string; icon?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <C.Sub>
      <C.SubTrigger disabled={disabled} className={cn(row, "text-text")}>
        {icon}
        {label}
        <ChevronRight className="ml-auto text-dim" />
      </C.SubTrigger>
      <C.Portal>
        <C.SubContent sideOffset={6} className={panel}>
          {children}
        </C.SubContent>
      </C.Portal>
    </C.Sub>
  );
}

export const ContextSeparator = () => <C.Separator className="mx-1 my-1 h-px bg-line" />;
export const ContextLabel = ({ children }: { children: ReactNode }) => <C.Label className="px-2.5 pt-1.5 pb-1 text-[12px] font-semibold text-faint">{children}</C.Label>;
