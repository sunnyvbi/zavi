"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { startReconnectFlow } from "../settings/reconnectFlows";
import { AD_BUDGET_ANCHOR } from "./AdBudgetSection";
import type { NoteSectionRow } from "@/lib/workspace/useGrowthPlan";

type RowState =
  | { s: "idle" }
  | { s: "working" }
  | { s: "fixed"; note: string }
  | { s: "failed"; note: string };

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function NeedsYouFixRow({
  row,
  label,
  onChanged,
}: {
  row: NoteSectionRow;
  label: string;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<RowState>({ s: "idle" });
  const fix = row.fix;

  const reconnect = async (slug: string) => {
    if (slug === "apple_ads") {
      window.location.href = "/workspace?tab=settings#connector-apple_ads";
      return;
    }
    setState({ s: "working" });
    try {
      await startReconnectFlow(slug);
      setState({
        s: "fixed",
        note: "Finish the connection in the window that opened. Once Zavi can read this account again, this card drops on its own.",
      });
      onChanged?.();
    } catch (e) {
      setState({ s: "failed", note: (e as Error).message || "That did not finish. Nothing changed." });
    }
  };

  const check = async (decision_id: string, went_through: boolean) => {
    setState({ s: "working" });
    try {
      const res = await apiFetch(`/api/workspace/decisions/${decision_id}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ went_through }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        resolved?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      setState({
        s: "fixed",
        note:
          body.resolved === "already"
            ? "✓ Already settled. The change resolved on its own. This card is gone on your next visit."
            : went_through
              ? "✓ Noted: it went through. This card is gone on your next visit."
              : "✓ Noted: it did not go through. Zavi won't resend it; you'll see its next step in the note.",
      });
      onChanged?.();
    } catch (e) {
      setState({ s: "failed", note: (e as Error).message || "Could not record that. Nothing changed." });
    }
  };

  const scrollToBudget = () => {
    document.getElementById(AD_BUDGET_ANCHOR)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const btn =
    "cursor-pointer rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-bold text-white transition-opacity hover:opacity-85 disabled:opacity-50";
  const btnQuiet =
    "cursor-pointer rounded-full border border-rule bg-white dark:bg-transparent px-3.5 py-1.5 text-[12.5px] font-semibold text-ink hover:border-inkMuted";

  return (
    <li
      className={cx(
        "border-t border-rule px-4 py-3.5 first:border-t-0",
        row.urgent && "border-l-[3px] border-l-danger pl-[13px]",
      )}
    >
      <p
        className={cx(
          "text-[11px] font-bold uppercase tracking-[0.05em]",
          row.urgent ? "text-danger" : "text-inkMuted",
        )}
      >
        {row.urgent ? "Money at risk" : label}
      </p>
      <p className="mt-0.5 text-[14px] font-semibold [line-height:24px] text-ink">
        {row.line}
        {}
        {(!fix || fix.kind === "locations" || fix.kind === "action") && row.url && (
          <>
            {" "}
            <a
              href={row.url}
              className="whitespace-nowrap text-[13px] underline decoration-rule underline-offset-2 hover:text-inkSoft"
            >
              {row.url_label ?? "Open"}
            </a>
          </>
        )}
      </p>

      {state.s === "fixed" ? (
        <p className="mt-2 rounded-[8px] bg-mint/15 px-3 py-2 text-[13px] font-semibold text-mintDeep" role="status">
          {state.note}
        </p>
      ) : state.s === "failed" ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 rounded-[8px] bg-marigold/15 px-3 py-2 text-[13px] text-ink" role="alert">
          {state.note}
          <button type="button" className="font-bold underline underline-offset-2" onClick={() => setState({ s: "idle" })}>
            Try again
          </button>
        </p>
      ) : fix?.kind === "reconnect" ? (
        <div className="mt-2">
          <button type="button" className={btn} disabled={state.s === "working"} onClick={() => void reconnect(fix.slug)}>
            {state.s === "working" ? "Connecting…" : "Reconnect"}
          </button>
        </div>
      ) : fix?.kind === "budget" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={scrollToBudget}>
            Lower daily budgets
          </button>
          <button type="button" className={btnQuiet} onClick={scrollToBudget}>
            Raise the cap
          </button>
        </div>
      ) : fix?.kind === "check" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={state.s === "working"} onClick={() => void check(fix.decision_id, true)}>
            It went through
          </button>
          <button type="button" className={btnQuiet} disabled={state.s === "working"} onClick={() => void check(fix.decision_id, false)}>
            It did not
          </button>
        </div>
      ) : null}
    </li>
  );
}
