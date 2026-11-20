"use client";

import { useEffect, useState } from "react";
import { Check, CreditCard } from "lucide-react";
import { creatorApi, CreatorApiError, money, type CreatorEarnings as E } from "@/lib/creator/api";
import Link from "next/link";
import { shortDate } from "./CreatorInbox";
import { useCreatorMe } from "./CreatorChrome";
import { BTN_PRIMARY, BTN_SMALL, Bone, Card, ErrorNote, H1, StatusPill } from "./areaUi";

export function payoutSetupLine(lines: E["lines"]): string {
  const unpaid = lines.filter((l) => l.bucket !== "paid");
  const approved = unpaid.filter((l) => l.status === "completed").reduce((n, l) => n + l.amount_cents, 0);
  const running = unpaid.filter((l) => l.status !== "completed").reduce((n, l) => n + l.amount_cents, 0);
  const setUp = "Set up payouts with Stripe so it can reach your bank.";
  if (approved > 0 && running > 0) {
    return `${money(approved)} is approved and waiting for you, and ${money(running)} follows when the business approves the rest. ${setUp}`;
  }
  if (approved > 0) return `${money(approved)} is approved and waiting for you. ${setUp}`;
  return `You accepted a job. Set up payouts with Stripe so ${money(running)} can reach your bank when the business approves.`;
}

export function CreatorEarningsScreen() {
  const { me } = useCreatorMe();
  const [data, setData] = useState<E | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    creatorApi
      .earnings()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof CreatorApiError ? e.message : "Your earnings did not load."));
  }, []);

  const openStripe = async (kind: "onboard" | "tax") => {
    setBusy(true);
    setError(null);
    try {
      const { url } = kind === "onboard" ? await creatorApi.onboardingLink() : await creatorApi.taxFormsLink();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "Stripe did not open. Try again.");
      setBusy(false);
    }
  };

  const disconnected = !!data && data.payout.disabled_reason === "deauthorized";
  const connected = !!data && data.payout.connected && data.payout.details_submitted && !disconnected;
  const hasJobs = !!data && data.lines.length > 0;

  return (
    <div>
      <H1 title="Earnings" blurb="You receive your price less Zavi's 15%. Payouts go to your bank through Stripe." />
      {error ? (
        <div className="mt-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {!data ? (
        error ? null : <EarningsSkeleton />
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-[13px] text-muted">Paid</p>
              <p className="mt-1 break-words text-[26px] font-bold tabular-nums tracking-tight text-foreground">{money(data.paid_cents)}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">On the way</p>
              <p className="mt-1 break-words text-[26px] font-bold tabular-nums tracking-tight text-foreground">{money(data.held_cents + data.on_the_way_cents)}</p>
            </Card>
            <Card>
              <p className="text-[13px] text-muted">Payouts</p>
              {data.payout_country_supported === false ? (
                <>
                  <p className="mt-1 text-[14px] font-semibold text-warn">Not available</p>
                  <p className="mt-1 text-[13px] text-muted">Zavi can&apos;t pay creators in your country yet. We&apos;ll email you when we can.</p>
                </>
              ) : disconnected ? (
                <>
                  <p className="mt-1 text-[14px] font-semibold text-danger">Disconnected</p>
                  <p className="mt-1 text-[13px] text-muted">Your Stripe account was disconnected from Zavi. Reconnect to resume payouts.</p>
                  <button type="button" disabled={busy} onClick={() => openStripe("onboard")} className={`${BTN_PRIMARY} mt-3 h-10 w-full`}>
                    <CreditCard className="h-4 w-4" aria-hidden="true" />
                    Reconnect Stripe
                  </button>
                </>
              ) : connected ? (
                <>
                  <p className="mt-1 inline-flex items-center gap-2 text-[14px] font-semibold text-success">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Stripe connected
                  </p>
                  <p className="mt-1 text-[13px] text-muted">{data.payout.payouts_enabled ? "Payouts are on." : "Stripe is still checking your details."}</p>
                  <button type="button" disabled={busy} onClick={() => openStripe("tax")} className={`${BTN_SMALL} mt-3`}>
                    Manage in Stripe
                  </button>
                </>
              ) : (
                <>
                  <p className="mt-1 text-[14px] font-semibold text-warn">Not set up</p>
                  {!me.setup.complete ? (
                    <p data-testid="payout-needs-profile" className="mt-1 text-[13px] text-muted">
                      Finish your profile first, then set up payouts here.{" "}
                      <Link href="/creator" className="font-semibold text-foreground underline">
                        Finish your profile
                      </Link>
                    </p>
                  ) : !me.creator.country_code ? (
                    <p data-testid="payout-needs-country" className="mt-1 text-[13px] text-muted">
                      Add your country above first, then set up payouts here.
                    </p>
                  ) : (
                    <>
                      {!hasJobs && <p className="mt-1 text-[13px] text-muted">Set it up now so you are paid as soon as a business approves your work.</p>}
                      <button type="button" disabled={busy} onClick={() => openStripe("onboard")} className={`${BTN_PRIMARY} mt-3 h-10 w-full`}>
                        <CreditCard className="h-4 w-4" aria-hidden="true" />
                        Set up payouts
                      </button>
                    </>
                  )}
                </>
              )}
            </Card>
          </div>

          {hasJobs && !connected && data.payout_country_supported !== false ? (
            <Card className="mt-4 border-warn/20 bg-warnBg">
              <p className="text-[14px] leading-relaxed text-foreground">{payoutSetupLine(data.lines)}</p>
            </Card>
          ) : null}

          <Card className="mt-4">
            <h3 className="text-[16px] font-semibold text-foreground">Payouts</h3>
            <ul className="mt-3 divide-y divide-black/[0.06]">
              {data.lines.length === 0 ? (
                <li className="py-3 text-[14px] text-muted">No payouts yet. They show here once a business approves your work.</li>
              ) : (
                data.lines.map((l) => (
                  <li key={l.order_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[14px] font-medium text-foreground">{l.business_name ? `${l.business_name}: ` : ""}
                        {l.title ?? "A job"}
                      </span>
                      <span className="text-[13px] text-muted">{shortDate(l.closed_at ?? l.payout_ready_at ?? "")}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <StatusPill tone={l.bucket === "paid" ? "good" : "wait"}>{l.bucket === "paid" ? "Paid" : l.bucket === "held" ? "Held by Zavi" : "On the way"}</StatusPill>
                      <span className="text-[14px] font-semibold tabular-nums text-foreground">{money(l.amount_cents)}</span>
                    </span>
                  </li>
                ))
              )}
            </ul>
          </Card>

          <p className="mt-4 text-[13px] text-muted">Tax forms come from Stripe.</p>
        </>
      )}
    </div>
  );
}

function EarningsSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading your earnings.</span>
      <div aria-hidden="true">
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <Bone className="h-3.5 w-20 rounded-full" />
              <Bone className="mt-3 h-8 w-28 rounded-full" />
            </Card>
          ))}
        </div>
        <Card className="mt-4">
          <Bone className="h-5 w-24 rounded-full" />
          <div className="mt-3 divide-y divide-black/[0.06]">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <Bone className="h-4 w-1/2 rounded-full" />
                  <Bone className="mt-2 h-3 w-20 rounded-full" />
                </div>
                <Bone className="h-6 w-24 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
