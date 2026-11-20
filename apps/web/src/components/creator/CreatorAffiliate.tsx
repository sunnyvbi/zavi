"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, CreditCard } from "lucide-react";
import { creatorApi, CreatorApiError, money, type CreatorAffiliate as A, type CreatorSetup } from "@/lib/creator/api";
import { shortDate } from "./CreatorInbox";
import { BTN_PRIMARY, BTN_SMALL, Bone, Card, EmptySlot, ErrorNote, H1 } from "./areaUi";
import { AffiliateLinkCard, ProRow, useAffiliateBase, useHasBusiness } from "./affiliateParts";
import { useOptionalCreatorMe } from "./CreatorChrome";

export function notReady(setup: CreatorSetup | null): { line: string; href: string } {
  const mode = setup?.earn_mode ?? null;
  const line =
    mode === "jobs"
      ? "Your affiliate link shows here once your profile is set up."
      : mode === "both"
        ? "Your affiliate link is ready once your profile is set up, with your first package."
        : "Your affiliate link is ready once How you want to earn, Your age and What you make are done.";
  if (!setup) return { line, href: "/creators/apply?step=goal" };
  const first = !setup.goal ? "goal" : !setup.dob ? "account" : !setup.make ? "make" : setup.package_required !== false && !setup.package ? "package" : "goal";
  return { line, href: `/creators/apply?step=${first}` };
}

export function entryLabel(e: A["entries"][number]): string {
  if (e.kind === "recovered") return "Taken back from a paid payout after a refund";
  if (e.kind === "adjustment") return e.amount_cents < 0 ? "Refund or dispute on a referred payment" : "Restored after a dispute";
  const month = e.month_index ? `month ${e.month_index}` : "a plan change";
  return e.rate === 1 ? `Referred payment, ${month} (100%)` : `Referred payment, ${month} (30%)`;
}

export function payoutLine(d: A): string {
  const o = d.open_payout;
  if (o?.state === "awaiting_approval") return `${money(o.amount_cents)} is being checked before your first payout.`;
  if (o?.state === "claimed") return `${money(o.amount_cents)} is queued for the next daily payout.`;
  if (o?.state === "transferring") return `${money(o.amount_cents)} is being sent to your Stripe account.`;
  if (o?.state === "reconcile") return `We are confirming a payout of ${money(o.amount_cents)} with Stripe.`;
  if (d.payable_cents >= 2000) return `${money(d.payable_cents)} is ready and goes out with the next daily payout.`;
  if (d.payable_cents > 0) return `${money(d.payable_cents)} is ready. Payouts start at $20.`;
  return "Payouts start at $20, once a referred payment has passed its 30-day refund window.";
}

export function CreatorAffiliateScreen() {
  const ctx = useOptionalCreatorMe();
  const setup = ctx?.me.setup ?? null;
  const mode = setup?.earn_mode ?? null;
  const [data, setData] = useState<A | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSetup, setPendingSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasBusiness = useHasBusiness();

  useEffect(() => {
    creatorApi
      .affiliate()
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof CreatorApiError && e.code === "not_approved") setPendingSetup(true);
        else setError(e instanceof CreatorApiError ? e.message : "Your affiliate page did not load.");
      });
  }, []);

  const affiliateBase = useAffiliateBase();
  const link = data ? `${affiliateBase}${data.code}` : "";
  const left = notReady(setup);
  const setUpPayouts = async () => {
    setBusy(true);
    setError(null);
    try {
      window.location.href = (await creatorApi.onboardingLink()).url;
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "Stripe did not open. Try again.");
      setBusy(false);
    }
  };

  return (
    <div>
      <H1
        title="Affiliate"
        blurb="Share your link. When someone you send subscribes, you get 100% of their first 2 monthly payments, then 30% through month 12."
      />
      {error ? (
        <div className="mt-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {pendingSetup ? (
        <div className="mt-6 space-y-4">
          <EmptySlot>{left.line}</EmptySlot>
          <div className="flex justify-center">
            <Link href={left.href} className={BTN_PRIMARY}>
              Finish setup
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : !data ? (
        error ? null : (
          <div className="mt-6 grid gap-4" aria-label="Loading your affiliate page">
            <Bone className="h-24 w-full rounded-2xl" />
            <Bone className="h-24 w-full rounded-2xl" />
          </div>
        )
      ) : (
        <>
          <AffiliateLinkCard
            link={link}
            Card={Card}
            small={BTN_SMALL}
            className="mt-6"
            onCopyFailed={() => setError("Copy did not work. Select the link and copy it instead.")}
          />

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-[13px] text-muted">Clicks, last 30 days</p>
              <p className="mt-1 text-[26px] font-bold tabular-nums tracking-tight text-foreground">{data.clicks_30d}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">Signups</p>
              <p className="mt-1 text-[26px] font-bold tabular-nums tracking-tight text-foreground">{data.signups}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">Paying customers</p>
              <p className="mt-1 text-[26px] font-bold tabular-nums tracking-tight text-foreground">{data.paying}</p>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-[13px] text-muted">In the 30-day refund window</p>
              <p className="mt-1 break-words text-[26px] font-bold tabular-nums tracking-tight text-foreground">{money(data.pending_cents)}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">Ready to pay</p>
              <p className="mt-1 break-words text-[26px] font-bold tabular-nums tracking-tight text-foreground">{money(data.payable_cents)}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">Paid</p>
              <p className="mt-1 break-words text-[26px] font-bold tabular-nums tracking-tight text-foreground">{money(data.paid_cents)}</p>
            </Card>
          </div>

          <Card className="mt-4">
            <p className="text-[14px] leading-relaxed text-foreground">{payoutLine(data)}</p>
            {data.payout.disconnected ? (
              <button type="button" disabled={busy} onClick={setUpPayouts} className={`${BTN_PRIMARY} mt-3 h-10 w-full sm:w-auto`}>
                <CreditCard className="h-4 w-4" aria-hidden="true" />
                Reconnect Stripe
              </button>
            ) : !data.payout.connected ? (
              <>
                <p className="mt-2 text-[13px] text-muted">Set up payouts with Stripe so your commissions can reach your bank.</p>
                <button type="button" disabled={busy} onClick={setUpPayouts} className={`${BTN_PRIMARY} mt-3 h-10 w-full sm:w-auto`}>
                  <CreditCard className="h-4 w-4" aria-hidden="true" />
                  Set up payouts
                </button>
              </>
            ) : (
              <p className="mt-2 inline-flex items-center gap-2 text-[13px] font-semibold text-success">
                <Check className="h-4 w-4" aria-hidden="true" />
                Stripe connected{data.payout.payouts_enabled ? "" : ", still checking your details"}
              </p>
            )}
          </Card>

          {mode === "affiliate" || mode === "both" ? (
            <Card className="mt-4">
              <ProRow small={BTN_SMALL} hasBusiness={hasBusiness} />
            </Card>
          ) : null}

          <Card className="mt-4">
            <h3 className="text-[16px] font-semibold text-foreground">Commissions</h3>
            <ul className="mt-3 divide-y divide-black/[0.06]">
              {data.entries.length === 0 ? (
                <li className="py-3 text-[14px] text-muted">Nothing yet. Commissions show here when someone you referred pays.</li>
              ) : (
                data.entries.map((e, i) => (
                  <li key={`${e.created_at}-${i}`} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-[14px] text-foreground">{entryLabel(e)}</p>
                      <p className="text-[12px] text-muted">
                        {shortDate(e.created_at)}
                        {e.paid ? " · paid" : new Date(e.matures_at) > new Date() ? ` · ready ${shortDate(e.matures_at)}` : " · ready"}
                      </p>
                    </div>
                    <p className={`shrink-0 text-[14px] font-semibold tabular-nums ${e.amount_cents < 0 ? "text-danger" : "text-foreground"}`}>{money(e.amount_cents)}</p>
                  </li>
                ))
              )}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
