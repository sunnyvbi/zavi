"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

function zipQuery(sessionId: string | null): string {
  return sessionId ? `build_session_id=${encodeURIComponent(sessionId)}` : "app=workspace";
}

type DownloadState = { phase: "idle" } | { phase: "running" } | { phase: "error"; message: string };

function filenameFrom(res: Response): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]+)"/);
  return m?.[1] || "app-code.zip";
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "Could not download the code. Try again.";
}

export function DownloadCodeButton({
  sessionId,
  variant = "panel",
  className,
}: {
  sessionId: string | null;
  variant?: "panel" | "compact";
  className?: string;
}) {
  const [state, setState] = useState<DownloadState>({ phase: "idle" });
  const current = useRef(sessionId);
  current.current = sessionId;
  useEffect(() => setState({ phase: "idle" }), [sessionId]);

  const run = useCallback(async () => {
    const forSession = sessionId;
    setState({ phase: "running" });
    try {
      const res = await apiFetch(`/api/workspace/app-code/zip?${zipQuery(forSession)}`);
      if (current.current !== forSession) return;
      if (!res.ok) {
        setState({ phase: "error", message: await errorMessage(res) });
        return;
      }
      const blob = await res.blob();
      if (current.current !== forSession) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState({ phase: "idle" });
    } catch {
      if (current.current === forSession) {
        setState({ phase: "error", message: "Could not reach Zavi. Check your connection and try again." });
      }
    }
  }, [sessionId]);

  const running = state.phase === "running";
  const icon = running ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
  ) : (
    <Download className="h-3.5 w-3.5" aria-hidden />
  );

  if (variant === "compact") {
    return (
      <span className={`inline-flex items-center gap-2${className ? ` ${className}` : ""}`}>
        {state.phase === "error" && (
          <span role="alert" className="max-w-[220px] truncate text-[12px] text-amber-800" title={state.message}>
            {state.message}
          </span>
        )}
        <button
          type="button"
          onClick={run}
          disabled={running}
          aria-busy={running}
          title="Download the code as a ZIP"
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[12px] font-medium text-inkMuted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-wait disabled:opacity-70"
        >
          {icon}
          {running ? "Preparing…" : "Download"}
        </button>
      </span>
    );
  }

  return (
    <div className={className}>
      <p className="text-[13px] font-semibold text-ink">Download the code</p>
      <p className="mt-0.5 text-[12px] leading-[1.5] text-inkMuted">
        A ZIP of every file in your app, ready to open in any editor. No GitHub needed.
      </p>
      <div className="mt-2.5 flex justify-end">
        <button
          type="button"
          onClick={run}
          disabled={running}
          aria-busy={running}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-ink/20 px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-[#f2f2f2] disabled:cursor-wait disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {icon}
          {running ? "Preparing ZIP…" : "Download ZIP"}
        </button>
      </div>
      {state.phase === "error" && (
        <p
          role="alert"
          className="mt-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900"
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
