"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, newRequestId, type ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "../channelPlanLock";
import type { TopActionSpec } from "../platformSpec";
import type { ActionItem } from "../types";
import { ActionModal, MDone, m } from "./ActionModal";
import { readTopActionRun, startTopAction } from "./api";
import { TopActionFields, useTopActionForm } from "./fields";

export const POLL_MS = 3000;
export const POLL_CAP_MS = 10 * 60 * 1000;
const RUNNING = new Set(["queued", "running"]);

type Step = "form" | "planning" | "plan" | "nothing_new" | "failed";

function why(a: ChannelActionView): string | null {
  return a.body?.step?.body ?? a.impact_reason ?? null;
}

export function CreateAdModal({
  slug,
  channelName,
  action,
  onClose,
  onApprove,
  onChanged,
  onStarted,
}: {
  slug: string;
  channelName: string;
  action: TopActionSpec;
  onStarted?: () => void;
  onClose: () => void;
  onApprove?: (a: ActionItem) => void | Promise<unknown>;
  onChanged: () => void;
}) {
  const planLock = useChannelPlanLock();
  const form = useTopActionForm(slug, action.key, action.fields);
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<ChannelActionView[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  const lastAsk = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const unsupported = typeof form.context.unsupported === "string" ? form.context.unsupported : null;
  const canSubmit = form.valid && !busy && !unsupported;

  const close = () => {
    onChanged();
    onClose();
  };

  async function poll(run_id: string) {
    const deadline = Date.now() + POLL_CAP_MS;
    while (alive.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!alive.current) return;
      try {
        const r = await readTopActionRun(slug, run_id);
        if (!alive.current) return;
        if (RUNNING.has(r.status)) continue;
        if (r.actions.length > 0) {
          setCards(r.actions);
          setStep("plan");
          onChanged();
        } else if (r.status === "success") {
          setSummary(r.summary ?? null);
          setStep("nothing_new");
          onChanged();
        } else {
          setError("Zavi could not make a plan this time. Nothing was proposed. Try again.");
          setStep("failed");
        }
        return;
      } catch {
      }
    }
    if (alive.current) {
      setError("This is taking longer than usual. The plan will appear in the list when it is ready.");
      setStep("failed");
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const inputs = form.inputs();
      const asked = JSON.stringify(inputs);
      if (lastAsk.current !== null && lastAsk.current !== asked) requestId.current = newRequestId();
      lastAsk.current = asked;
      let r = await startTopAction(slug, action.key, requestId.current, inputs);
      for (let i = 0; i < 3 && !r.run_id; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        if (!alive.current) return;
        r = await startTopAction(slug, action.key, requestId.current, inputs);
      }
      if (!r.run_id) throw new Error("Zavi is still starting this. Check the list in a minute.");
      setStep("planning");
      setBusy(false);
      onStarted?.();
      void poll(r.run_id);
    } catch (e) {
      setBusy(false);
      if (upgradeOnPlanRefusal(planLock, e)) {
        onClose();
        return;
      }
      if (e instanceof ApiError && e.status === 402) {
        setError(e.message || "You are out of credits for this. Top up, then try again.");
      } else {
        setError((e as Error).message || "Zavi could not start this. Try again.");
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        requestId.current = newRequestId();
        lastAsk.current = null;
      }
    }
  }

  async function approve(a: ChannelActionView) {
    if (!onApprove) return;
    setApproving(a.id);
    try {
      const ok = await onApprove(a);
      if (ok !== false && alive.current) setApproved((s) => ({ ...s, [a.id]: true }));
    } finally {
      if (alive.current) setApproving(null);
    }
  }

  const locked = step !== "form" && step !== "failed";
  const allApproved = cards.length > 0 && cards.every((c) => approved[c.id] || c.status !== "pending");

  const footer =
    step === "plan" || step === "nothing_new" ? (
      <button type="button" className={m.primary} onClick={close}>
        Done
      </button>
    ) : (
      <>
        <button type="button" className={m.cancel} disabled={busy} onClick={close}>
          {step === "planning" ? "Close" : "Cancel"}
        </button>
        {step !== "planning" && !unsupported && (
          <button type="button" className={m.primary} disabled={!canSubmit} onClick={submit}>
            {busy ? "Starting…" : step === "failed" ? "Try again" : (action.primary ?? "Make a plan")}
          </button>
        )}
      </>
    );

  return (
    <ActionModal
      eyebrow={channelName}
      title={action.label}
      sub={action.lead ?? "Tell Zavi what the ad is about. Zavi works out the set-up and shows you the plan first."}
      onClose={close}
      busy={busy || approving !== null}
      hint={step === "planning" ? "You can close this. The plan lands in the list." : (action.hint ?? "Nothing goes live until you approve.")}
      footer={footer}
      done={
        step === "plan" && allApproved ? (
          <MDone text="Approved. Zavi is making the change now." action={<button type="button" className={m.cancel} onClick={close}>Done</button>} />
        ) : undefined
      }
    >
      {step === "planning" && (
        <div role="status" className="rounded-xl border border-[#027BFF]/20 bg-[#027BFF]/[0.05] px-4 py-3.5 text-[14px] leading-[1.5] text-[#1f1f1f]">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#027BFF]">Making a plan…</p>
          <p className="mt-1">Zavi is reading your ad account and writing the plan. This takes a minute or two.</p>
        </div>
      )}
      {step === "plan" && (
        <div className="rounded-xl border border-[#027BFF]/20 bg-[#027BFF]/[0.05] px-4 py-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#027BFF]">Zavi&apos;s plan</p>
          <p className="mt-1 text-[14px] text-[#595959]">Waiting for your approval on the Growth page. Nothing is live yet.</p>
          <div className="mt-3 flex flex-col gap-3">
            {cards.map((a) => (
              <div key={a.id} data-testid="top-action-card" className="rounded-xl border border-[#e5e7eb] bg-white px-3.5 py-3">
                <p className="text-[16px] font-bold tracking-[-.01em] text-[#0e0f11]">{a.title}</p>
                {why(a) && <p className="mt-0.5 text-[14px] leading-[1.5] text-[#595959]">{why(a)}</p>}
                <div className="mt-2.5 flex justify-end">
                  {approved[a.id] || a.status !== "pending" ? (
                    <span className="text-[13px] font-semibold text-emerald-700">{approved[a.id] ? "Approved" : "In the list"}</span>
                  ) : onApprove ? (
                    <button type="button" className={m.primary} disabled={approving !== null} onClick={() => approve(a)}>
                      {approving === a.id ? "Approving…" : "Approve"}
                    </button>
                  ) : (
                    <span className="text-[13px] text-[#8a8a8a]">Approve it in the list</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {step === "nothing_new" && (
        <div role="status" data-testid="top-action-nothing-new" className={m.note}>
          {summary && <p>{summary}</p>}
          <p className={summary ? "mt-1.5 text-[#595959]" : ""}>Zavi finished without a new card. It may already be waiting in your list.</p>
        </div>
      )}
      {error && <p role="alert" className={m.error}>{error}</p>}
      {unsupported ? (
        <p role="status" data-testid="top-action-unsupported" className={m.note}>
          {unsupported}
        </p>
      ) : (
        <>
          {action.note && step === "form" && <p className={m.note}>{action.note}</p>}
          <TopActionFields fields={action.fields} form={form} disabled={locked} />
        </>
      )}
    </ActionModal>
  );
}
