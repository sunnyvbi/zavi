"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { creatorApi, CreatorApiError } from "@/lib/creator/api";
import { BTN_PRIMARY, BTN_SECONDARY, Card, CreatorFrame, ErrorNote, H1, Loading } from "@/components/creator/areaUi";

type State = "loading" | "action_required" | "confirming" | "error";

export default function StripeReturnPage() {
  const router = useRouter();
  const [status, setStatus] = useState<State>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setStatus("loading");
    setErrorMsg(null);
    try {
      const result = await creatorApi.payoutRefresh();
      if (result.payout.transfers_active) {
        router.replace("/creator/earnings");
      } else if (result.payout.action_required) {
        setStatus("action_required");
      } else {
        setStatus("confirming");
      }
    } catch (e) {
      setErrorMsg(e instanceof CreatorApiError ? e.message : "Could not confirm your Stripe setup. Try again.");
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const continueSetup = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const { url } = await creatorApi.onboardingLink();
      window.location.href = url;
    } catch (e) {
      setErrorMsg(e instanceof CreatorApiError ? e.message : "Could not open Stripe. Try again.");
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "loading") {
    return (
      <CreatorFrame>
        <Loading what="your Stripe setup" />
      </CreatorFrame>
    );
  }

  return (
    <CreatorFrame>
      <Card className="space-y-4 text-center">
        {status === "error" ? (
          <>
            <H1 title="We could not check your payouts" />
            <ErrorNote message={errorMsg} />
            <button type="button" disabled={busy} onClick={refresh} className={`${BTN_PRIMARY} w-full`}>
              Retry
            </button>
          </>
        ) : status === "action_required" ? (
          <>
            <H1
              title="Finish setting up payouts"
              blurb="Stripe still needs a few details before we can pay you. It only takes a minute, and your earnings wait safely until then."
            />
            <ErrorNote message={errorMsg} />
            <div className="flex flex-col gap-2">
              <button type="button" disabled={busy} onClick={continueSetup} className={`${BTN_PRIMARY} w-full`}>
                {busy ? "Opening Stripe…" : "Continue with Stripe"}
              </button>
              <button type="button" onClick={() => router.replace("/creator/earnings")} className={`${BTN_SECONDARY} w-full`}>
                Go to Earnings
              </button>
            </div>
          </>
        ) : (
          <>
            <H1
              title="Stripe is confirming your account"
              blurb="This usually takes a few seconds. Check again, or go back to Earnings and look later."
            />
            <div className="flex flex-col gap-2">
              <button type="button" disabled={busy} onClick={refresh} className={`${BTN_PRIMARY} w-full`}>
                {busy ? "Checking…" : "Check again"}
              </button>
              <button type="button" onClick={() => router.replace("/creator/earnings")} className={`${BTN_SECONDARY} w-full`}>
                Go to Earnings
              </button>
            </div>
          </>
        )}
      </Card>
    </CreatorFrame>
  );
}
