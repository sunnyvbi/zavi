"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Lock, ShieldCheck } from "lucide-react";
import type { CreatorBookingQuote, CreatorOrderCreated } from "@/components/humans/creatorJobTypes";
import type { BriefApplicantsResponse, BriefWorkbenchResponse } from "@/components/humans/humanPostedBriefs";
import { dayTimeUtc, firstName, money, shortDay, useUgcDrawer } from "./hub";
import { Avatar, BTN, CARD, DrawerNote, FIELD, ProductQuestion, SideDrawer, termsLine } from "./ui";
import { callJson, useCreatorCards } from "./useCards";
import type { CreatorOfferView } from "./types";
import { lastFindParams } from "./FindFilters";
import { offerWhat, offerWhen } from "./offers";

type Mode = "package" | "application" | "offer";

export function HireDrawer() {
  const drawer = useUgcDrawer();
  const p = drawer.params;
  const mode: Mode = p.application ? "application" : p.offer ? "offer" : "package";

  const [quote, setQuote] = useState<CreatorBookingQuote | null>(null);
  const [offer, setOffer] = useState<CreatorOfferView | null>(null);
  const [appNote, setAppNote] = useState<string | null>(null);
  const [bench, setBench] = useState<BriefWorkbenchResponse["brief"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [show, setShow] = useState("");
  const [product, setProduct] = useState(false);
  const [confirmedLarge, setConfirmedLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (mode === "offer") {
        const r = await callJson<{ offer: CreatorOfferView }>(`/api/creators/offers/${encodeURIComponent(p.offer!)}`);
        if (!alive) return;
        if (r.ok) setOffer(r.data.offer);
        else setLoadError(r.message);
        return;
      }
      const target = mode === "application" ? { application_id: p.application } : { package_id: p.package };
      const r = await callJson<{ quote: CreatorBookingQuote }>("/api/humans/orders/quote", {
        body: { target, ...(mode === "package" && p.brief ? { brief_id: p.brief } : {}) },
      });
      if (!alive) return;
      if (!r.ok) {
        setLoadError(r.message);
        return;
      }
      setQuote(r.data.quote);
      if (mode === "package") setShow(r.data.quote.brief_prefill?.angle ?? "");
      if (mode === "application" && p.brief) {
        const [apps, wb] = await Promise.all([
          callJson<BriefApplicantsResponse>(`/api/humans/briefs/${encodeURIComponent(p.brief)}/applicants`),
          callJson<BriefWorkbenchResponse>(`/api/humans/briefs/${encodeURIComponent(p.brief)}/workbench`),
        ]);
        if (!alive) return;
        if (apps.ok) setAppNote(apps.data.applicants.find((a) => a.application_id === p.application)?.note ?? null);
        if (wb.ok) setBench(wb.data.brief);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, p.offer, p.application, p.package, p.brief]);

  const memberId = quote?.creator.human_member_id ?? offer?.human_member_id ?? "";
  const cards = useCreatorCards(memberId ? [memberId] : []);
  const card = memberId ? cards[memberId] : undefined;

  const name = quote?.creator.display_name || card?.display_name || "the creator";
  const first = firstName(name);
  const city = quote?.creator.city ?? card?.city ?? null;
  const ownOffer = offer?.proposed_by === "tenant";
  const price = mode === "offer" ? offer?.fees.price_cents : quote?.money.price_cents;
  const fee = mode === "offer" ? offer?.fees.business_fee_cents : quote?.money.business_fee_cents;
  const total = mode === "offer" ? offer?.fees.business_total_cents : quote?.money.business_total_cents;

  const pay = useCallback(async () => {
    setBusy(true);
    setError(null);
    let url: string | null = null;
    if (mode === "package" && quote) {
      const r = await callJson<CreatorOrderCreated>("/api/humans/orders", {
        body: {
          target: { package_id: p.package },
          brief_id: p.brief || undefined,
          due_at: quote.due_at ?? undefined,
          large_amount_confirmed: confirmedLarge || undefined,
          return_path: "ugc",
          brief_title: show.trim() ? quote.job.title : undefined,
          brief: show.trim() || undefined,
          product_needed: product,
        },
      });
      if (r.ok) url = r.data.checkout_url;
      else setError(r.message);
    } else if (mode === "application" && p.brief) {
      const r = await callJson<{ checkout_url: string | null }>(`/api/humans/briefs/${encodeURIComponent(p.brief)}/hire`, {
        body: { application_id: p.application, large_amount_confirmed: confirmedLarge || undefined },
      });
      if (r.ok) url = r.data.checkout_url;
      else setError(r.message);
    } else if (mode === "offer" && offer) {
      const r =
        offer.status === "accepted"
          ? await callJson<{ checkout_url: string | null }>(`/api/creators/offers/${encodeURIComponent(offer.id)}/checkout`, { body: {} })
          : await callJson<{ order: { checkout_url?: string | null } }>(
              `/api/creators/offers/${encodeURIComponent(offer.id)}/accept`,
              { body: {} },
            );
      if (r.ok) url = "order" in r.data ? (r.data.order.checkout_url ?? null) : (r.data.checkout_url ?? null);
      else setError(r.message);
    }
    if (url) {
      window.location.assign(url);
      return;
    }
    setBusy(false);
    setError((e) => e ?? "Zavi could not open the payment page. Nothing was charged. Try again in a moment.");
  }, [mode, quote, offer, ownOffer, p.package, p.brief, p.application, confirmedLarge, show, product]);

  const heading =
    mode === "application" ? `Hire ${name}` : mode === "offer" ? (ownOffer ? `${first} accepted. Pay to start` : `Accept ${first}'s offer`) : `Book ${name}`;
  const back =
    mode === "application"
      ? { label: "Back to applicants", go: () => drawer.open("applicants", { brief: p.brief }) }
      : mode === "offer"
        ? { label: `Back to messages with ${first}`, go: () => drawer.open("thread", { creator: memberId }) }
        : { label: "Back to Find creators", go: () => drawer.open("find", lastFindParams()) };

  const pkg = mode === "package" ? card?.packages.find((x) => x.id === p.package) : undefined;
  const title =
    mode === "application"
      ? (quote?.job.title ?? "")
      : mode === "offer"
        ? ownOffer
          ? `Your custom offer to ${name}`
          : `Custom offer from ${name}`
        : (pkg?.title ?? quote?.job.title ?? "");
  const terms =
    mode === "offer" && offer
      ? `${offerWhat(offer)} · ${offerWhen(offer)} · 2 rounds of changes`
      : mode === "application" && bench
        ? [
            !bench.lane || bench.lane === "ugc_video" ? `${bench.deliverables ?? 1} UGC video` : null,
            bench.format,
            bench.delivery_days ? `delivered in ${bench.delivery_days} days after hire` : null,
            "2 rounds of changes",
          ]
            .filter(Boolean)
            .join(" · ")
        : pkg
          ? termsLine(pkg)
          : "";
  const how =
    mode === "application"
      ? `Charged now. When the payment goes through, ${first} is hired, the brief closes and everyone else gets your note. If it doesn't go through, the brief stays open and nobody is told anything.`
      : mode === "offer"
        ?
          "Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work."
        : `Your card is held now, not charged. ${first} has 72 hours to accept. If ${first} accepts, you are charged and the job starts${
            quote?.due_after_accept ? `, due ${quote.due_after_accept}` : ""
          }. If ${first} declines or doesn't answer, the hold is released.`;
  const payLabel = mode === "application" ? `Pay ${money(total)}` : mode === "offer" ? `Pay ${money(total)}` : `Hold ${money(total)}`;
  const ready = mode === "offer" ? Boolean(offer) : Boolean(quote);
  const blocked = quote?.blocked ?? null;
  const needsConfirm = Boolean(quote?.needs_large_amount_confirm);

  return (
    <SideDrawer title={ready ? heading : "Checkout"} onClose={drawer.close}>
      {}
      <button
        type="button"
        onClick={back.go}
        className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-rule bg-cream pl-2.5 pr-3.5 text-[14px] font-semibold text-ink hover:bg-bone"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {back.label}
      </button>
      {!ready ? (
        <div className="mt-3">
          <DrawerNote>{loadError ?? "Loading the price…"}</DrawerNote>
        </div>
      ) : (
        <div className="mt-3 grid gap-4">
          <div className={CARD}>
            <div className="flex items-start gap-3">
              <Avatar name={name} photoUrl={card?.photo_url ?? null} />
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold text-ink">{title}</p>
                {terms && <p className="mt-1 text-[14px] text-inkSoft">{terms}</p>}
                <p className="mt-1 text-[13px] text-inkMuted">
                  {name}
                  {city ? ` · ${city}` : ""}
                </p>
              </div>
            </div>
          </div>
          {mode === "application" && (
            <div className={CARD}>
              <p className="text-[14px] font-semibold text-ink">{first}&apos;s note</p>
              <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">&ldquo;{appNote ?? ""}&rdquo;</p>
              <p className="mt-3 text-[14px] font-semibold text-ink">Product to send</p>
              <p className="mt-1 text-[14px] text-inkSoft">{bench?.product_needed ? "Yes, from your brief." : "No, from your brief."}</p>
            </div>
          )}
          {mode === "offer" && offer && (
            <div className={CARD}>
              <p className="text-[14px] font-semibold text-ink">
                {ownOffer ? `The offer, as you sent it on ${dayTimeUtc(offer.created_at)}` : `The offer, as ${first} sent it on ${dayTimeUtc(offer.created_at)}`}
              </p>
              <p className="mt-1 text-[14px] text-inkSoft">
                {offerWhat(offer)} · {offerWhen(offer)} · 2 rounds of changes
              </p>
              <p className="mt-4 text-[14px] font-semibold text-ink">Product to send</p>
              <p className="mt-1 text-[14px] text-inkSoft">{offer.product_needed ? "Yes, from the offer." : "No, from the offer."}</p>
            </div>
          )}
          {mode === "package" && (
            <div className={`${CARD} grid gap-4`}>
              <label className="block">
                <span className="text-[14px] font-medium text-ink">What the video should show</span>
                <textarea rows={3} className={`${FIELD} mt-1.5`} value={show} onChange={(e) => setShow(e.target.value.slice(0, 4000))} />
              </label>
              <ProductQuestion value={product} onChange={setProduct} creator={first} />
            </div>
          )}
          <div className={CARD}>
            <p className="text-[14px] font-semibold text-ink">Summary</p>
            <dl className="mt-3 grid gap-2 text-[14px]">
              <div className="flex justify-between">
                <dt className="text-inkSoft">{mode === "application" ? `${first}'s price` : mode === "offer" ? "Offer" : "Package"}</dt>
                <dd className="font-medium text-ink">{money(price)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-inkSoft">Zavi fee (10%)</dt>
                <dd className="font-medium text-ink">{money(fee)}</dd>
              </div>
              {mode === "package" && quote?.due_after_accept && !product && (
                <div className="flex justify-between">
                  <dt className="text-inkSoft">Due</dt>
                  <dd className="font-medium text-ink">{quote.due_after_accept}</dd>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-rule pt-2 text-[16px]">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="font-bold text-ink">{money(total)}</dd>
              </div>
            </dl>
            <p className="mt-4 flex items-start gap-2 rounded-lg bg-creamDeep px-3 py-2.5 text-[13px] leading-snug text-inkSoft">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              {how}
            </p>
            {blocked && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{blocked.message}</p>}
            {needsConfirm && (
              <label className="mt-3 flex items-start gap-2.5 text-[13px] leading-snug text-ink">
                <input type="checkbox" checked={confirmedLarge} onChange={(e) => setConfirmedLarge(e.target.checked)} className="mt-0.5" />
                <span>This is over {money(quote?.large_amount_confirm_cents)}. I want Zavi to hold {money(total)} on this card.</span>
              </label>
            )}
            {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{error}</p>}
            <button
              type="button"
              disabled={busy || Boolean(blocked) || (needsConfirm && !confirmedLarge)}
              onClick={() => void pay()}
              className={`${BTN} mt-4 w-full bg-ink text-cream hover:bg-ink/85`}
            >
              <Lock className="h-4 w-4" aria-hidden="true" />
              {busy ? "Opening the payment page" : payLabel}
            </button>
            <p className="mt-2 text-center text-[13px] text-inkMuted">Payment by Stripe. Zavi never sees your card number.</p>
          </div>
        </div>
      )}
    </SideDrawer>
  );
}
