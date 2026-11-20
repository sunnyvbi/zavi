"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { HumanSectionShell } from "./HumanSectionShell";
import { HumanCard, HumanError, HumanSessionExpired, HumanSkeleton } from "./HumanStates";
import { CreatorMoneyLines, formatCents } from "./creatorMoney";
import type {
  BookingBriefPrefill,
  CreatorBookingQuote,
  CreatorOrderCreated,
} from "./creatorJobTypes";

export type BookingTargetInput =
  | { package_id: string }
  | { offer_id: string }
  | { application_id: string };

const BRIEF_TITLE_MAX = 200;
const BRIEF_BODY_MAX = 4000;

function briefBodyFrom(prefill: BookingBriefPrefill): string {
  const lines = [
    prefill.angle ? `Angle: ${prefill.angle}` : "",
    prefill.hook ? `Hook: ${prefill.hook}` : "",
    prefill.format ? `Format: ${prefill.format}` : "",
    prefill.deliverables ? `How many: ${prefill.deliverables}` : "",
  ].filter(Boolean);
  return lines.join("\n\n").slice(0, BRIEF_BODY_MAX);
}

export function CreatorBookingIsland({
  target,
  briefId = null,
}: {
  target: BookingTargetInput;
  briefId?: string | null;
}) {
  const [quote, setQuote] = useState<CreatorBookingQuote | null>(null);
  const [dueAt, setDueAt] = useState<string>("");
  const [confirmedLarge, setConfirmedLarge] = useState(false);
  const briefDoor = "package_id" in target;
  const [briefOpen, setBriefOpen] = useState(true);
  const [briefTitle, setBriefTitle] = useState("");
  const [briefBody, setBriefBody] = useState("");
  const briefPrefilled = useRef(false);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repricing, setRepricing] = useState(false);
  const navigating = useRef(false);
  const quoteSeq = useRef(0);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      navigating.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const loadQuote = useCallback(
    async (due_at?: string) => {
      const seq = ++quoteSeq.current;
      setError(null);
      try {
        const res = await apiFetch("/api/humans/orders/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, due_at, brief_id: briefId ?? undefined }),
        });
        if (seq !== quoteSeq.current) return;
        if (res.status === 401) {
          setSessionExpired(true);
          return;
        }
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(b?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as { quote: CreatorBookingQuote };
        if (seq !== quoteSeq.current) return;
        setQuote(body.quote);
        if (!due_at && body.quote.due_at) setDueAt(body.quote.due_at.slice(0, 10));
        if (!briefPrefilled.current) {
          briefPrefilled.current = true;
          const prefill = body.quote.brief_prefill;
          setBriefTitle(
            ((prefill?.title || body.quote.job.title) ?? "").slice(0, BRIEF_TITLE_MAX),
          );
          if (prefill) setBriefBody(briefBodyFrom(prefill));
        }
      } catch (e) {
        setError((e as Error).message || "Network error");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(target), briefId],
  );

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  const onDueChange = (value: string) => {
    setDueAt(value);
    if (!value) return;
    const iso = new Date(`${value}T12:00:00.000Z`).toISOString();
    setRepricing(true);
    const pending = loadQuote(iso);
    const seq = quoteSeq.current;
    void pending.finally(() => {
      if (seq === quoteSeq.current) setRepricing(false);
    });
  };

  const skipBrief = () => {
    setBriefTitle("");
    setBriefBody("");
    setBriefOpen(false);
  };

  const book = useCallback(async () => {
    if (!quote) return;
    setBusy(true);
    setError(null);
    const sendBrief = briefDoor && briefOpen && briefBody.trim().length > 0;
    try {
      const res = await apiFetch("/api/humans/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          due_at: quote.due_at ?? undefined,
          large_amount_confirmed: confirmedLarge || undefined,
          return_path: "/humans/jobs",
          brief_title: sendBrief ? briefTitle.trim() || undefined : undefined,
          brief: sendBrief ? briefBody.trim() : undefined,
          brief_id: briefDoor ? (briefId ?? undefined) : undefined,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(b?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as CreatorOrderCreated;
      if (body.checkout_url) {
        navigating.current = true;
        window.location.assign(body.checkout_url);
        return;
      }
      setError(
        "Zavi could not open the payment page. Nothing was charged. Try again in a moment.",
      );
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      if (!navigating.current) setBusy(false);
    }
  }, [quote, target, confirmedLarge, briefDoor, briefOpen, briefTitle, briefBody, briefId]);

  const blocked = quote?.blocked ?? null;
  const gateUnmet = Boolean(quote?.needs_large_amount_confirm) && !confirmedLarge;

  return (
    <HumanSectionShell
      title={quote ? `Book ${quote.creator.display_name || "this creator"}` : "Book a creator"}
      lede="Check the price, the Zavi fee and the total before anything touches your card."
      breadcrumb={
        briefDoor
          ? [{ label: "Find creators", href: "/humans/creators" }, { label: "Book" }]
          : [{ label: "Jobs", href: "/humans/jobs" }, { label: "Book" }]
      }
    >
      {}
      {briefDoor ? (
        <Link
          href="/humans/creators"
          className="mb-4 inline-flex h-9 items-center gap-2 rounded-full border border-ink/15 bg-white pl-2.5 pr-3.5 text-[14px] font-semibold text-ink hover:bg-ink/[0.04]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Find creators
        </Link>
      ) : null}
      {sessionExpired ? (
        <HumanSessionExpired next="/humans/jobs" />
      ) : loading && !quote ? (
        <HumanSkeleton rows={2} />
      ) : !quote ? (
        <HumanError message={error ?? "Zavi could not price this."} onRetry={() => void loadQuote()} />
      ) : (
        <div className="space-y-4">
          <HumanCard>
            <p className="text-[16px] font-semibold text-ink">{quote.job.title}</p>
            <p className="mt-0.5 text-[12px] text-inkMuted">
              {quote.creator.display_name}
              {quote.creator.city ? ` · ${quote.creator.city}` : ""}
              {quote.job.delivery_days ? ` · ${quote.job.delivery_days} days to deliver` : ""}
            </p>

            <div className="mt-4 max-w-[46ch]">
              <CreatorMoneyLines money={quote.money} creatorName={quote.creator.display_name} />
            </div>

            <BookingTerms quote={quote} dueAt={dueAt} onDueChange={onDueChange} />
          </HumanCard>

          {briefDoor ? (
            <HumanCard>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[16px] font-semibold text-ink">What do you want made?</p>
                <span className="text-[12px] text-inkMuted">Optional</span>
              </div>
              {briefOpen ? (
                <>
                  {quote.brief_prefill ? (
                    <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                      Started from the brief Zavi wrote. Change anything you want before you book.
                    </p>
                  ) : null}
                  <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                    {quote.creator.display_name || "The creator"} reads this on the job. Skip it and
                    the package description is all they get. Either way the booking goes through.
                    Messages and payment stay on Zavi, so contact details are taken out.
                  </p>

                  <div className="mt-3.5">
                    <label htmlFor="brief-title" className="text-[14px] font-medium text-ink">
                      Title
                    </label>
                    <input
                      id="brief-title"
                      type="text"
                      value={briefTitle}
                      maxLength={BRIEF_TITLE_MAX}
                      onChange={(e) => setBriefTitle(e.target.value)}
                      placeholder="What this job is called"
                      className="mt-1.5 block w-full max-w-[46ch] rounded-lg border border-ink/15 bg-white px-3 py-2 text-[13px] text-ink"
                    />
                  </div>

                  <div className="mt-3">
                    <label htmlFor="brief-body" className="text-[14px] font-medium text-ink">
                      Brief
                    </label>
                    <textarea
                      id="brief-body"
                      rows={5}
                      value={briefBody}
                      maxLength={BRIEF_BODY_MAX}
                      onChange={(e) => setBriefBody(e.target.value)}
                      placeholder="What to film, who it is for, anything that has to be said or shown, links to examples."
                      className="mt-1.5 block w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-[13px] leading-[1.55] text-ink"
                    />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={skipBrief}
                      className="text-[13px] text-inkMuted underline underline-offset-2 hover:text-ink"
                    >
                      Skip, I will send it myself
                    </button>
                    <span className="text-[12px] text-inkMuted">
                      {BRIEF_BODY_MAX - briefBody.length} characters left
                    </span>
                  </div>
                </>
              ) : (
                <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                  No brief. {quote.creator.display_name || "The creator"} works from the package
                  description, and you can send the details in the job thread.{" "}
                  <button
                    type="button"
                    onClick={() => setBriefOpen(true)}
                    className="text-ink underline underline-offset-2"
                  >
                    Write one now
                  </button>
                </p>
              )}
            </HumanCard>
          ) : null}

          {blocked ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
              <p className="text-[16px] font-semibold text-amber-900">
                This cannot be booked right now
              </p>
              <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-amber-800">
                {blocked.message}
              </p>
            </div>
          ) : null}

          {quote.needs_large_amount_confirm ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
              <p className="text-[16px] font-semibold text-amber-900">
                This is over{" "}
                {formatCents(quote.large_amount_confirm_cents, quote.money.currency)}
              </p>
              <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-amber-800">
                Zavi asks twice on a number this size.
              </p>
              <label className="mt-3 flex items-start gap-2.5 text-[13px] leading-[1.5] text-amber-900">
                <input
                  type="checkbox"
                  checked={confirmedLarge}
                  onChange={(e) => setConfirmedLarge(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I want Zavi to hold{" "}
                  {formatCents(quote.money.business_total_cents, quote.money.currency)} on this
                  card.
                </span>
              </label>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[13px] leading-[1.5] text-rose-800">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || repricing || blocked !== null || gateUnmet}
              onClick={() => void book()}
              className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50"
            >
              {busy
                ? "Opening the payment page"
                : repricing
                  ? "Updating price…"
                  : `Continue to payment, ${formatCents(quote.money.business_total_cents, quote.money.currency)}`}
            </button>
            <Link
              href="/humans/jobs"
              className="text-[13px] text-inkMuted underline underline-offset-2 hover:text-ink"
            >
              Not now
            </Link>
          </div>
        </div>
      )}
    </HumanSectionShell>
  );
}

export const PRODUCT_NEEDED_LINE =
  "The delivery date starts when the creator receives your product. They mark it received on the job, and the clock starts then.";

export function BookingTerms({
  quote,
  dueAt,
  onDueChange,
}: {
  quote: CreatorBookingQuote;
  dueAt: string;
  onDueChange: (value: string) => void;
}) {
  return (
    <>
      {quote.due_deadline ? (
        <div className="mt-4">
          <label htmlFor="due-at" className="text-[14px] font-medium text-ink">
            Delivery date
          </label>
          <input
            id="due-at"
            type="date"
            value={dueAt}
            onChange={(e) => onDueChange(e.target.value)}
            className="mt-1.5 block rounded-lg border border-ink/15 bg-white px-3 py-2 text-[13px] text-ink"
          />
          {}
          <p className="mt-2 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
            {quote.due_deadline.line}
          </p>
        </div>
      ) : quote.due_after_accept ? (
        <p className="mt-4 max-w-[70ch] text-[13px] leading-[1.55] text-ink">
          <span className="font-medium">Due:</span> {quote.due_after_accept}.
        </p>
      ) : (
        <p className="mt-4 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
          {PRODUCT_NEEDED_LINE}
        </p>
      )}

      {quote.accept_window ? (
        <p className="mt-4 max-w-[74ch] rounded-lg bg-ink/[0.03] px-3.5 py-3 text-[13px] leading-[1.55] text-ink">
          Your card is held, not charged. {quote.creator.display_name || "The creator"} has{" "}
          {quote.accept_window.hours} hours to accept. {quote.accept_window.consequence_text}
        </p>
      ) : quote.charge_now_text && !quote.blocked ? (
        <p className="mt-4 max-w-[74ch] rounded-lg bg-ink/[0.03] px-3.5 py-3 text-[13px] leading-[1.55] text-ink">
          {quote.charge_now_text}
        </p>
      ) : null}
    </>
  );
}
