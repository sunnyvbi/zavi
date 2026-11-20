"use client";

import { useEffect, useRef, useState } from "react";
import { creatorApi, CreatorApiError } from "@/lib/creator/api";
import { BTN_PRIMARY, Card, CreatorFrame, ErrorNote, H1, Loading } from "@/components/creator/areaUi";

export default function StripeRefreshPage() {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const getNewLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await creatorApi.onboardingLink();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "Could not get a new link. Try again.");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getNewLink();
  }, []);

  if (busy && !error) {
    return (
      <CreatorFrame>
        <Loading what="a fresh Stripe link" />
      </CreatorFrame>
    );
  }

  return (
    <CreatorFrame>
      <Card className="space-y-4 text-center">
        <H1
          title="Your Stripe link expired"
          blurb="Setup links only last a short time. Get a new one to keep setting up payouts."
        />
        <ErrorNote message={error} />
        <button type="button" disabled={busy} onClick={getNewLink} className={`${BTN_PRIMARY} w-full`}>
          {busy ? "Getting link…" : "Get a new link"}
        </button>
      </Card>
    </CreatorFrame>
  );
}
