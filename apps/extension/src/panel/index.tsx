
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CrashScreen, describe } from "./components/CrashScreen";
import "./styles.css";

let root: Root | null = null;

function paintCrash(error: unknown): void {
  const host = document.getElementById("root");
  if (!host) return;
  try {
    root ??= createRoot(host);
    root.render(<CrashScreen error={error} onReload={() => location.reload()} />);
    return;
  } catch {
  }
  host.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "zv-crash";
  const title = document.createElement("h1");
  title.className = "zv-crash-title";
  title.textContent = "Zavi hit an error and stopped";
  const lead = document.createElement("p");
  lead.className = "zv-crash-lead";
  lead.textContent =
    "This is a bug in Zavi, not something you did. Close and reopen the panel. If it keeps happening, send the detail below.";
  const pre = document.createElement("pre");
  pre.className = "zv-crash-detail";
  pre.textContent = describe(error);
  wrap.append(title, lead, pre);
  host.append(wrap);
}

window.addEventListener("error", (e) => {
  console.error("[zavi:panel] uncaught error", e.error ?? e.message);
  paintCrash(e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[zavi:panel] unhandled rejection", e.reason);
  paintCrash(e.reason);
});

try {
  const host = document.getElementById("root");
  if (!host) throw new Error("panel root missing");
  root = createRoot(host);
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (error) {
  console.error("[zavi:panel] failed to start", error);
  paintCrash(error);
}
