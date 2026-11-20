"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { BuildConfirm } from "@/lib/workspace/buildConfirm";

type Phase = "pending" | "starting" | "started" | "out_of_credits" | "expired" | "failed";

function focusComposer(): void {
  const el = document.querySelector<HTMLTextAreaElement>("textarea");
  el?.focus();
}

export function BuildConfirmCard({
  card,
  threadId,
}: {
  card: BuildConfirm;
  threadId: string | null | undefined;
}) {
  const expiredAtLoad = Date.parse(card.expires_at) < Date.now();
  const [phase, setPhase] = useState<Phase>(
    card.status === "started" ? "started" : expiredAtLoad ? "expired" : "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const replaced = card.status === "replaced" && phase !== "started";

  const start = async () => {
    if (replaced) return;
    if (phase !== "pending" && phase !== "out_of_credits" && phase !== "failed") return;
    if (!threadId) return;
    if (Date.parse(card.expires_at) < Date.now()) {
      setPhase("expired");
      return;
    }
    setPhase("starting");
    setError(null);
    try {
      const res = await apiFetch(
        `/api/chat/build-confirm/${encodeURIComponent(threadId)}/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce: card.nonce }),
        },
      );
      if (res.ok) {
        setPhase("started");
        return;
      }
      if (res.status === 402) {
        setPhase("out_of_credits");
        return;
      }
      if (res.status === 409) {
        setPhase("expired");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? "Something went wrong starting the build.");
      setPhase("failed");
    } catch {
      setError("Something went wrong starting the build.");
      setPhase("failed");
    }
  };

  const credits = card.est_credits.toLocaleString("en-US");
  const usd = card.est_usd.toFixed(2);

  return (
    <div
      data-testid="build-confirm-card"
      className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm"
    >
      <div className="text-[16px] font-semibold text-ink">Large build</div>
      <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
        {card.est_credits === 0
          ? "Free: this is your workspace's first build."
          : `About ${credits} credits (~$${usd}).`}{" "}
        {replaced ? "This build was not started." : "Nothing runs until you start it."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {replaced && (
          <span role="status" className="text-[13px] text-inkMuted">
            Replaced by your new request.
          </span>
        )}
        {!replaced && (phase === "pending" || phase === "out_of_credits" || phase === "failed") && (
          <>
            <button
              type="button"
              onClick={() => void start()}
              className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            >
              Start build
            </button>
            <button
              type="button"
              onClick={focusComposer}
              className="rounded-cta border border-ink/15 px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-bone"
            >
              Change scope
            </button>
          </>
        )}
        {!replaced && phase === "starting" && (
          <button
            type="button"
            disabled
            className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-[13px] font-medium text-white opacity-50"
          >
            Starting…
          </button>
        )}
        {phase === "started" && (
          <span role="status" className="text-[13px] font-medium text-ink">
            Build started. Progress will show here.
          </span>
        )}
        {!replaced && phase === "expired" && (
          <span role="status" className="text-[13px] text-inkMuted">
            This build request was replaced or expired. Ask me again to start it.
          </span>
        )}
      </div>

      {!replaced && phase === "out_of_credits" ? (
        <p role="alert" className="mt-2 text-[12px] text-red-700">
          Not enough credits for this build.{" "}
          <a href="/workspace?tab=settings#billing" className="underline">
            Top up
          </a>
          , then start it again.
        </p>
      ) : null}

      {!replaced && phase === "failed" && error ? (
        <p role="alert" className="mt-2 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
