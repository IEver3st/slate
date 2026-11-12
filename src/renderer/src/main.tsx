import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import "./styles.css";
import { App } from "./App";
import { installTheme } from "./lib/theme";

for (const key of ["audio", "preferences", "token"]) {
  try {
    const old = localStorage.getItem(`dailies-${key}`);
    if (old !== null && localStorage.getItem(`slate-${key}`) === null) localStorage.setItem(`slate-${key}`, old);
    localStorage.removeItem(`dailies-${key}`);
  } catch {}
}

installTheme();

createRoot(document.getElementById("root")!).render(
  <Tooltip.Provider>
    <App />
  </Tooltip.Provider>,
);
