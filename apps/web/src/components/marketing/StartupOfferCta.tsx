"use client";

import { attributionLink } from "@/lib/marketing/attributionLinks";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";

const OFFER_SLUG = "launch-2026";

type OfferStatus = {
  active: boolean;
  seats_total: number;
  seats_remaining: number;
  sold_out: boolean;
};

export function StartupOfferCta() {
  const router = useRouter();
  const [status, setStatus] = useState<OfferStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createBrowserSupabase();
        const { data } = await supabase.rpc("startup_offer_status", { p_offer_slug: OFFER_SLUG });
        if (!cancelled && data) setStatus(data as OfferStatus);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onClick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabase();
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        router.push(attributionLink(`/start?next=${encodeURIComponent("/startups")}`, window.location.href));
        return;
      }

      const res = await apiFetch("/api/billing/startup-offer", { method: "POST" });
      if (res.status === 409) {
        setStatus((s) => (s ? { ...s, sold_out: true, seats_remaining: 0 } : s));
        setError("All seats are taken.");
        return;
      }
      if (res.status === 403 || res.status === 401) {
        router.push(attributionLink(`/start?next=${encodeURIComponent("/startups")}`, window.location.href));
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not start checkout. Try again.");
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        trackEvent("checkout_started", { offer: OFFER_SLUG });
        window.location.href = body.url;
        return;
      }
      setError("Could not start checkout. Try again.");
    } catch {
      setError("Could not start checkout. Try again.");
    } finally {
      setBusy(false);
    }
  }, [router]);

  const soldOut = status?.sold_out === true || status?.active === false;

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || soldOut}
        className="inline-flex min-h-[56px] items-center justify-center rounded-blockLg bg-[#0e0f11] px-8 text-[20px] font-semibold text-white transition hover:bg-[#26282b] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {soldOut ? "All seats taken" : busy ? "Starting checkout…" : "Get 100,000 credits for $1"}
      </button>

      {status && !soldOut && (
        <p className="text-[13px] text-[#6b6f76]">
          {status.seats_remaining} of {status.seats_total} seats left
        </p>
      )}
      {soldOut && (
        <p className="text-[13px] text-[#6b6f76]">
          This round is closed.{" "}
          <a className="underline" href="/pricing">
            See pricing
          </a>
          .
        </p>
      )}
      {error && <p className="text-[13px] text-[#b42318]">{error}</p>}
    </div>
  );
}
