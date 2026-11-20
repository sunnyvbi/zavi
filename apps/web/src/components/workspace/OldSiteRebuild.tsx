"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import {
  OLD_SITE_FROZEN_FALLBACK,
  REBUILD_DATA_NOTE,
  REBUILD_OLD_SITE_LABEL,
  rebuildBuildHref,
  requestOldSiteRebuild,
} from "@/lib/workspace/oldSiteRebuild";

function goTo(conductorRunId: string): void {
  if (typeof window !== "undefined") window.location.assign(rebuildBuildHref(conductorRunId));
}

export function RebuildOldSiteButton({
  onStarted = goTo,
  showNote = true,
  className = "",
}: {
  onStarted?: (conductorRunId: string) => void;
  showNote?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const outcome = await requestOldSiteRebuild();
    if (outcome.kind === "started") {
      onStarted(outcome.conductorRunId);
      return;
    }
    setBusy(false);
    setStatus(
      outcome.kind === "starting"
        ? "Your new site is already starting. It will show up under Build in a moment."
        : outcome.message,
    );
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`} data-testid="rebuild-old-site">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        aria-busy={busy}
        className="flex h-10 w-fit shrink-0 items-center justify-center rounded-cta bg-ink px-4 text-[14px] font-semibold leading-5 text-cream transition-colors hover:bg-inkSoft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Starting your new site..." : REBUILD_OLD_SITE_LABEL}
      </button>
      {showNote ? <p className="text-[13px] leading-[18px] text-inkMuted">{REBUILD_DATA_NOTE}</p> : null}
      {status ? (
        <p role="status" className="text-[13px] leading-[19px] text-ink">
          {status}
        </p>
      ) : null}
    </div>
  );
}

export function OldSiteFrozenNotice({
  message,
  onStarted,
  className = "",
}: {
  message?: string | null;
  onStarted?: (conductorRunId: string) => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-testid="old-site-frozen-notice"
      className={`flex w-full flex-col gap-3 rounded-[16px] border border-rule bg-cream p-4 font-sans ${className}`}
    >
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-inkMuted" aria-hidden />
        <p className="text-[14px] leading-[21px] text-ink [word-break:break-word]">
          {message?.trim() || OLD_SITE_FROZEN_FALLBACK}
        </p>
      </div>
      <RebuildOldSiteButton onStarted={onStarted} showNote={false} />
    </div>
  );
}
