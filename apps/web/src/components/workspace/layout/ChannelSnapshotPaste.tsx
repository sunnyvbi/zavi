"use client";

import { useEffect, useState } from "react";
import type { Channel } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { cx, FOCUS_RING } from "./shared";

const PASTEABLE = new Set(["tiktok_ads", "google_ads", "meta_ads", "linkedin_ads", "chatgpt_ads"]);

export function channelCanPaste(slug: string, connected: boolean): boolean {
  return PASTEABLE.has(slug) && !connected;
}

type Snapshot = {
  id: string;
  provider: string;
  period_start: string;
  period_end: string;
  source: string | null;
  created_at: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; snapshots: Snapshot[] }
  | { kind: "error" };

type SubmitState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "invalid"; message: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function ChannelSnapshotPaste({
  channel,
  connected,
}: {
  channel: Channel;
  connected: boolean;
}) {
  const provider = channel.slug;
  const enabled = channelCanPaste(provider, connected);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [raw, setRaw] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/snapshots?provider=${encodeURIComponent(provider)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { snapshots?: Snapshot[] };
        if (alive) setState({ kind: "ready", snapshots: body.snapshots ?? [] });
      } catch {
        if (alive) setState({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, provider, submit.kind]);

  if (!enabled) return null;

  const latest = state.kind === "ready" ? state.snapshots[0] : undefined;

  async function save() {
    if (!ISO_DAY.test(periodStart) || !ISO_DAY.test(periodEnd)) {
      setSubmit({ kind: "invalid", message: "Both dates need to look like 2026-09-01." });
      return;
    }
    if (periodEnd < periodStart) {
      setSubmit({ kind: "invalid", message: "The end date is before the start date." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      setSubmit({
        kind: "invalid",
        message: "That is not valid JSON. Paste the export as it came, or wrap it in { }.",
      });
      return;
    }
    setSubmit({ kind: "saving" });
    try {
      const res = await apiFetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          period_start: periodStart,
          period_end: periodEnd,
          payload,
          source: "manual_paste",
        }),
      });
      if (!res.ok) {
        const reason =
          res.status >= 400 && res.status < 500
            ? await res
                .json()
                .then((b: { error?: { message?: string } }) => b?.error?.message ?? "")
                .catch(() => "")
            : "";
        setSubmit({
          kind: "invalid",
          message: reason || "Couldn't save that just now. Try again.",
        });
        return;
      }
      setSubmit({ kind: "saved" });
      setRaw("");
      setOpen(false);
    } catch {
      setSubmit({ kind: "invalid", message: "Couldn't save that just now. Try again." });
    }
  }

  return (
    <section aria-labelledby="channel-snapshot-paste">
      <h3 id="channel-snapshot-paste" className="mt-5 text-[16px] font-semibold text-ink">
        Your numbers
      </h3>
      <p className="mt-1.5 text-[13px] leading-5 text-inkMuted">
        {}
        Zavi can&apos;t read this ad account. Paste what your Ads Manager shows and it will use
        those numbers, quoted with the dates you give, never as a live reading.
      </p>

      {state.kind === "loading" && (
        <p className="mt-2 text-[13px] leading-5 text-inkMuted">Checking for a snapshot…</p>
      )}

      {state.kind === "error" && (
        <p className="mt-2 text-[13px] leading-5 text-inkMuted">
          Couldn&apos;t check for a snapshot just now.
        </p>
      )}

      {state.kind === "ready" && (
        <div className="mt-2 rounded-2xl border border-rule bg-white p-3.5">
          {latest ? (
            <p className="text-[16px] font-medium text-ink">
              Covering {latest.period_start} to {latest.period_end}
            </p>
          ) : (
            <p className="text-[16px] font-medium text-ink">Nothing pasted yet</p>
          )}
          <p className="mt-1 text-[13px] leading-5 text-inkMuted">
            {latest
              ? "Runs on this channel can quote these figures. Paste again to bring them up to date."
              : "Without one, this channel works from public evidence only and states no spend, CPA or ROAS."}
          </p>

          {!open && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setSubmit({ kind: "idle" });
              }}
              className={cx(
                "mt-2.5 rounded-cta border border-rule px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-neutral-50",
                FOCUS_RING,
              )}
            >
              Paste ad snapshot
            </button>
          )}

          {open && (
            <div className="mt-3 flex flex-col gap-2.5">
              <div className="flex gap-2">
                <label className="flex-1 text-[14px] font-medium text-inkMuted">
                  From
                  <input
                    type="date"
                    value={periodStart}
                    onChange={(e) => setPeriodStart(e.target.value)}
                    className={cx(
                      "mt-1 w-full rounded-xl border border-rule px-2.5 py-1.5 text-[13px] text-ink",
                      FOCUS_RING,
                    )}
                  />
                </label>
                <label className="flex-1 text-[14px] font-medium text-inkMuted">
                  To
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={(e) => setPeriodEnd(e.target.value)}
                    className={cx(
                      "mt-1 w-full rounded-xl border border-rule px-2.5 py-1.5 text-[13px] text-ink",
                      FOCUS_RING,
                    )}
                  />
                </label>
              </div>

              <label className="text-[14px] font-medium text-inkMuted">
                The numbers, as JSON
                <textarea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder={'{"spend": 4200, "conversions": 63, "cpa": 66.67}'}
                  className={cx(
                    "mt-1 w-full rounded-xl border border-rule px-2.5 py-1.5 font-mono text-[13px] text-ink",
                    FOCUS_RING,
                  )}
                />
              </label>

              {submit.kind === "invalid" && (
                <p className="text-[13px] leading-5 text-inkMuted">{submit.message}</p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={submit.kind === "saving"}
                  className={cx(
                    "rounded-cta border border-rule bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50",
                    FOCUS_RING,
                  )}
                >
                  {submit.kind === "saving" ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className={cx(
                    "rounded-cta border border-rule px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-neutral-50",
                    FOCUS_RING,
                  )}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
