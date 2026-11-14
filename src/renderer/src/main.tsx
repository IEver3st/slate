import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import "./styles.css";
import { App } from "./App";
import { installTheme } from "./lib/theme";
import { installPresence } from "./lib/presence";

for (const key of ["audio", "preferences", "token"]) {
  try {
    const old = localStorage.getItem(`dailies-${key}`);
    if (old !== null && localStorage.getItem(`slate-${key}`) === null) localStorage.setItem(`slate-${key}`, old);
    localStorage.removeItem(`dailies-${key}`);
  } catch {}
}

installTheme();
installPresence();

for (const type of ["dragover", "drop"] as const) window.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <Tooltip.Provider>
    <App />
  </Tooltip.Provider>,
);
