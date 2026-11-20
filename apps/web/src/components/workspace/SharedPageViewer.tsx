"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { SharePageControls, useSharedPageActions, type SharedPage } from "./SharedPageCard";

type Loaded = { page: SharedPage; html: string };

export function SharedPageViewer({ pageId }: { pageId: string }) {
  const [state, setState] = useState<Loaded | "missing" | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/workspace/shared-pages/${encodeURIComponent(pageId)}`);
        if (cancelled) return;
        if (res.status === 404) return setState("missing");
        if (!res.ok) return setState("error");
        setState((await res.json()) as Loaded);
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (state === null) {
    return <div className="flex h-screen items-center justify-center bg-cream text-base text-inkMuted">Loading page…</div>;
  }
  if (state === "missing" || state === "error") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-cream px-4 text-center">
        <p className="text-base text-ink">
          {state === "missing"
            ? "This page doesn't exist, or it belongs to a different workspace."
            : "The page couldn't be loaded. Refresh to try again."}
        </p>
        <a href="/workspace" className="text-base font-medium text-ink underline underline-offset-2">
          Back to workspace
        </a>
      </div>
    );
  }
  return <LoadedPage loaded={state} />;
}

export async function embedderBlocksFrameNavigation(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
    const csp = res.headers.get("content-security-policy") ?? "";
    return /(^|[;,])\s*frame-src\s+'none'\s*([;,]|$)/i.test(csp);
  } catch {
    return false;
  }
}

function LoadedPage({ loaded }: { loaded: Loaded }) {
  const actions = useSharedPageActions(loaded.page);
  const [scripts, setScripts] = useState<boolean | null>(null);
  useEffect(() => {
    document.title = `${loaded.page.title} · Zavi`;
  }, [loaded.page.title]);
  useEffect(() => {
    let cancelled = false;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const loadedHere = !!nav && new URL(nav.name).pathname === window.location.pathname;
    void (loadedHere ? embedderBlocksFrameNavigation(window.location.href) : Promise.resolve(false)).then((ok) => {
      if (!cancelled) setScripts(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="flex h-screen flex-col bg-cream">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-creamDeep px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <a href="/workspace" className="text-xs text-inkMuted hover:text-ink">
            ← Workspace
          </a>
          <h1 className="truncate text-base font-medium text-ink">{loaded.page.title}</h1>
        </div>
        <SharePageControls actions={actions} />
      </header>
      {scripts === false && (
        <p className="border-b border-creamDeep px-4 py-1.5 text-xs text-inkMuted">
          Interactive parts of this page are turned off here. The public link shows the full page.
        </p>
      )}
      {scripts !== null && (
        <iframe
          title={loaded.page.title}
          sandbox={scripts ? "allow-scripts" : ""}
          srcDoc={loaded.html}
          className="w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
