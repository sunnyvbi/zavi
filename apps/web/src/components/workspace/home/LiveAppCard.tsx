"use client";

import type { BuildFailureDetails, BuildStatus } from "@/lib/workspace/useBuildProduct";
import { AppPreviewFrame } from "./AppPreviewFrame";
import {
  BUILD_INTERNAL_FAILURE,
  buildFailureLine,
  isOutOfCreditsBuild,
} from "@/lib/workspace/buildFailureCopy";
import { BUILD_STOPPED_REFUSAL } from "@/lib/workspace/creditRefusal";
import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import type { PickedElement } from "./previewPicker";
import { ExportToGithubButton } from "./ExportToGithubButton";
import { NextChevron } from "@/components/ui/NextChevron";

function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function LiveAppCard({
  status,
  url,
  failure,
  onElementPicked,
}: {
  status: BuildStatus;
  url: string | null;
  failure?: BuildFailureDetails | null;
  onElementPicked?: (picked: PickedElement) => void;
}) {
  if (status === "none") return null;

  if (status === "building") {
    return (
      <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
        <div className="flex items-center gap-3">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-5 w-5 shrink-0 animate-spin text-inkMuted"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.55" />
          </svg>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-ink">
              Your app is being built…
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.5] text-inkMuted">
              Your AI team is writing, deploying, and going live. This page
              updates automatically when the live URL is ready.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (status === "failed") {
    const stopped = failure?.class === "budget_halted" ||
      failure?.class === "class_cap_halted" ||
      failure?.class === "stale_reaped" ||
      failure?.class === "user_cancelled";
    if (!stopped && isOutOfCreditsBuild(failure)) {
      return <CreditRefusalNotice refusal={BUILD_STOPPED_REFUSAL} />;
    }
    const line = buildFailureLine(failure) ?? BUILD_INTERNAL_FAILURE;
    return (
      <section
        role="status"
        className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-[12px] font-semibold text-red-700"
          >
            ✕
          </span>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-red-700">
              {stopped ? "Build stopped" : "Build failed"}
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.5] text-red-700">
              {line}
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (!url) return null;
  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)] lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 lg:shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-ink">
              Your app is live
            </p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-0.5 block truncate font-mono text-[13px] text-inkMuted underline-offset-2 hover:text-ink hover:underline"
              title={url}
            >
              {displayHost(url)}
            </a>
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-full bg-emerald-600 px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-emerald-700"
        >
          Open app <NextChevron />
        </a>
      </div>

      {}
      <AppPreviewFrame liveUrl={url} tall onElementPicked={onElementPicked} />

      {}
      <ExportToGithubButton />
    </section>
  );
}
