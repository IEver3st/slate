import { useEffect, useRef, useState } from "react";
import type { Resume } from "../../preload/api";
import { Library, type OpenTarget } from "./components/Library";
import { Review } from "./components/Review";
import { connection } from "./lib/api";
import { SettingsHost } from "./components/Settings";
import { SetupHost } from "./components/Setup";
import { CommandPalette } from "./components/CommandPalette";

export function App() {
  const [target, setTarget] = useState<OpenTarget | undefined>(() => {
    const id = new URL(location.href).searchParams.get("cut");
    return id ? { cutId: id } : undefined;
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [updated, setUpdated] = useState<Resume>();

  useEffect(() => {
    connection()
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void window.slate?.takeResume?.().then((r) => {
      if (r?.target) setTarget(r.target);
      if (r?.to) setUpdated(r);
    });
    void window.slate?.takeNavigation().then((id) => id && setTarget({ cutId: id }));
    return window.slate?.onNavigate((id) => setTarget({ cutId: id }));
  }, []);

  if (error) {
    return (
      <div className="grid h-full place-items-center p-10">
        <div className="max-w-md">
          <div className="text-[17px] font-semibold">Slate could not reach its render service</div>
          <p className="mt-2 text-soft">{error}</p>
        </div>
      </div>
    );
  }
  if (!ready) return <div className="drag h-12" />;
  return (
    <>
      {target ? (
        <Review key={`${target.cutId}-${target.rev}-${target.t}`} cutId={target.cutId} start={target} onBack={() => setTarget(undefined)} onOpenCut={setTarget} />
      ) : (
        <Library onOpen={setTarget} />
      )}
      <CommandPalette onOpenCut={setTarget} currentCutId={target?.cutId} />
      <SettingsHost />
      <SetupHost />
      {updated && <UpdatedNotice update={updated} onDone={() => setUpdated(undefined)} />}
    </>
  );
}

function UpdatedNotice({ update, onDone }: { update: Resume; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current(), 9000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <button onClick={onDone} className="toast-in pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl bg-raised px-4 py-2.5 text-left shadow-[0_10px_40px_rgba(0,0,0,.5)]">
        <span className="shrink-0 font-semibold text-amber">Updated to {update.to}</span>
        <span className="truncate text-soft">{update.subject}</span>
      </button>
    </div>
  );
}
