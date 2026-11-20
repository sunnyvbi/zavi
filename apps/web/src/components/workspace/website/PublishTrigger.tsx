"use client";

import { useId } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { buildPublishesOnRequest, type BuildPublishStatus } from "@/lib/workspace/buildPublish";

export const PUBLISHING_TITLE =
  "Your app is being published to your address. You can publish changes once it's live.";
export const RETRY_PUBLISH_TITLE =
  "Publishing didn't finish. Retry to put your app on your address.";
export const PUBLISH_WAITS_TITLE = "Publish opens once your site is built.";

const PILL =
  "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-[#0e0f11] px-4 text-[13px] font-semibold text-white transition-colors";

export type PublishTriggerMode = "publish" | "publishing" | "retry" | "waiting";

export function siteAwaitingFirstBuild(
  site: { liveUrl: string | null; status?: string } | null | undefined,
  appReady: boolean | undefined,
  publishStatus?: BuildPublishStatus,
): boolean {
  if (!site || site.liveUrl || appReady === true) return false;
  if (site.status === "live" || site.status === "paused" || site.status === "waking") return false;
  return publishStatus !== "live";
}

export function siteNeverPublished(
  site: { liveUrl: string | null; status?: string } | null | undefined,
): boolean {
  if (!site || site.liveUrl) return false;
  return site.status !== "live" && site.status !== "paused" && site.status !== "waking";
}

export function sitePublishOnRequest(
  publishOnRequest: boolean,
  site: { liveUrl: string | null; status?: string } | null | undefined,
  runStatus: string | null | undefined,
  stages: ReadonlyArray<{ stage: string }> = [],
): "ready" | "building" | null {
  if (!siteNeverPublished(site) || !buildPublishesOnRequest(stages, publishOnRequest)) return null;
  return runStatus === "done" ? "ready" : "building";
}

export function publishTriggerMode(
  appReady: boolean | undefined,
  publishStatus: BuildPublishStatus | undefined,
  canRetry: boolean,
  waitsForApp = false,
  onRequestReady = false,
): PublishTriggerMode {
  if (publishStatus === "publishing") return "publishing";
  if (onRequestReady) return "publish";
  if (appReady === true && publishStatus === "failed" && canRetry) return "retry";
  if (waitsForApp) return "waiting";
  return "publish";
}

export function PublishTrigger({
  mode,
  open,
  onToggle,
  onRetry,
  retrying,
  retryError,
  progressInPopover = false,
}: {
  mode: PublishTriggerMode;
  open: boolean;
  onToggle: () => void;
  onRetry: () => void;
  retrying: boolean;
  retryError: string | null;
  progressInPopover?: boolean;
}) {
  const reasonId = useId();
  if (mode === "waiting") {
    return (
      <span className="group relative inline-flex">
        <button
          type="button"
          aria-disabled="true"
          aria-describedby={reasonId}
          onClick={(e) => e.preventDefault()}
          className={`${PILL} cursor-not-allowed opacity-50`}
        >
          Publish
        </button>
        <span
          id={reasonId}
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full z-30 mt-2 hidden w-max max-w-[240px] rounded-lg bg-ink px-2.5 py-1.5 text-[12px] leading-4 text-cream shadow-sm group-focus-within:block group-hover:block"
        >
          {PUBLISH_WAITS_TITLE}
        </span>
      </span>
    );
  }
  if (mode === "publishing" && progressInPopover) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`${PILL} hover:bg-[#0e0f11]/85`}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Publishing…
      </button>
    );
  }
  if (mode === "publishing") {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={PUBLISHING_TITLE}
        className={`${PILL} cursor-not-allowed opacity-70`}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Publishing…
      </button>
    );
  }
  if (mode === "retry") {
    return (
      <>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          title={RETRY_PUBLISH_TITLE}
          className={`${PILL} hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:opacity-70`}
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
          )}
          Retry publish
        </button>
        {retryError && (
          <p
            role="alert"
            className="absolute right-0 top-full z-30 mt-2 w-[260px] rounded-lg border border-danger/20 bg-dangerBg px-3 py-2 text-[12px] leading-5 text-danger shadow-sm"
          >
            {retryError}
          </p>
        )}
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`${PILL} hover:bg-[#0e0f11]/85`}
    >
      Publish
    </button>
  );
}
