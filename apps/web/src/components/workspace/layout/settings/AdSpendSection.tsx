"use client";

import { useCallback, useEffect, useState } from "react";
import { Info } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { sharedJson } from "@/lib/workspace/sharedRead";
import { headOfGrowthOf } from "@/lib/workspace/useGrowthPlan";
import { cardButton } from "../../actions/card/styles";
import { CGO_LABEL, useOpenStatic } from "../shared";
import { SettingsSection } from "./SettingsSection";

type Budget = { status: "active" | "stopped"; daily_limit_usd: number | null } | null;
type Plan = { head_of_growth?: unknown; channels?: Array<{ slug?: unknown; autorun?: unknown }> };
type Spend = { autopilot: boolean; auto: boolean; budget: Budget };

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

const MODES = [
  { auto: false, title: "Ask me first", line: "Every ad waits for your approval before it spends." },
  { auto: true, title: "Go ahead on my behalf", line: "Zavi acts inside your ad budget where Autopilot allows it. Everything else still waits for you." },
] as const;

export function AdSpendSection({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const openStatic = useOpenStatic();
  const [spend, setSpend] = useState<Spend | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (live: () => boolean) => {
    setFailed(false);
    const [budget, plan] = await Promise.all([
      sharedJson<{ budget?: Budget }>("/api/workspace/ad-budget"),
      sharedJson<Plan>("/api/workspace/growth/plan"),
    ]);
    if (!live()) return;
    if (!budget || !plan) {
      setFailed(true);
      return;
    }
    const autopilot = headOfGrowthOf(plan.head_of_growth).autopilot;
    const row = Array.isArray(plan.channels) ? plan.channels.find((c) => c?.slug === slug) : undefined;
    setSpend({
      autopilot,
      auto: autopilot && (row ? row.autorun === true : true),
      budget: budget.budget?.status === "active" ? budget.budget : null,
    });
  }, [slug]);

  useEffect(() => {
    let on = true;
    void load(() => on);
    return () => {
      on = false;
    };
  }, [load]);

  const choose = async (auto: boolean) => {
    if (!spend || busy || spend.auto === auto) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/growth/channels/${encodeURIComponent(slug)}/autorun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autorun: auto }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
        const said = body?.error?.message;
        throw new Error(res.status === 403 && typeof said === "string" && said ? said : "That did not save. Try again.");
      }
      setSpend((s) => (s ? { ...s, auto } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const limit = spend?.budget ? (spend.budget.daily_limit_usd != null ? money(spend.budget.daily_limit_usd) : "No daily limit") : "No ad budget yet";

  return (
    <SettingsSection id={`${slug}-spend`} title="Before Zavi spends">
      {failed ? (
        <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
          Zavi could not load your spend settings. Try again.
          <button type="button" onClick={() => void load(() => true)} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
        </p>
      ) : !spend ? (
        <div aria-busy className="mt-3 h-[220px] animate-pulse rounded-xl bg-ca-subtle motion-reduce:animate-none" />
      ) : (
        <>
          <div role="radiogroup" aria-labelledby={`${slug}-spend`} className="mt-3 flex flex-col gap-2">
            {MODES.map((m) => {
              const on = spend.auto === m.auto;
              const off = !canEdit || busy || (m.auto && !spend.autopilot);
              return (
                <label
                  key={m.title}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ca-focus",
                    on ? "border-ca-action bg-ca-subtle" : "border-ca-strong",
                    off ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                    !on && !off && "hover:bg-ca-hover",
                  )}
                >
                  <input
                    type="radio"
                    name={`${slug}-spend-mode`}
                    checked={on}
                    disabled={off}
                    onChange={() => void choose(m.auto)}
                    className="mt-1 size-4 accent-ca-action"
                  />
                  <span>
                    <span className="block text-ca-facts font-semibold text-ca-xdark">{m.title}</span>
                    <span className="block text-ca-action text-ca-secondary">{m.line}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {!spend.autopilot && <p className="mt-2 text-ca-action text-ca-secondary">{`Autopilot is off, so Zavi asks first on every channel. Turn it on in ${CGO_LABEL} to let Zavi go ahead.`}</p>}
          {!canEdit && <p className="mt-2 text-ca-action text-ca-secondary">Only a workspace owner or admin can change this.</p>}
          {error && <p role="alert" className="mt-2 text-ca-action text-ca-danger">{error}</p>}
          <dl className="mt-4 flex flex-col gap-1.5">
            <dt className="text-ca-action font-medium text-ca-dark">Daily limit</dt>
            <dd className="w-full max-w-60 rounded-xl border border-ca-strong bg-ca-subtle px-3 py-2.5 text-ca-facts tabular-nums text-ca-dark">{limit}</dd>
          </dl>
          <p className="mt-2 flex items-start gap-1.5 text-ca-action text-ca-secondary">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            {`One ad budget covers every ad channel. You set it, and Autopilot, in ${CGO_LABEL}.`}
          </p>
          <button type="button" onClick={() => openStatic("autopilot")} className={cn(cardButton.base, cardButton.secondary, "mt-3")}>{`Change in ${CGO_LABEL}`}</button>
        </>
      )}
    </SettingsSection>
  );
}
