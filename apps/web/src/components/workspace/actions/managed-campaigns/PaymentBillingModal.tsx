"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CardCvcElement, CardExpiryElement, CardNumberElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementStyle } from "@stripe/stripe-js";
import { adsStripe } from "@/lib/stripe/adsStripe";
import { campaignFetch } from "./api";
import { money } from "./format";
import { MaskIcon } from "./fundingUi";

export type InAppConsent = { version: string; save_text: string; refill_text: string; creator_text: string };
export type CardChoice = { amount_cents: number; enable_refill: boolean };

const CODES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
function countries(): Array<[string, string]> {
  let name = (c: string) => c;
  try { const d = new Intl.DisplayNames(["en"], { type: "region" }); name = c => d.of(c) ?? c; } catch {  }
  const rows = CODES.map(c => [c, name(c)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  return [rows.find(r => r[0] === "US")!, ...rows.filter(r => r[0] !== "US")];
}
const field = "h-10 w-full rounded-[10px] border border-rule bg-cream px-[10px] text-[14px] font-medium leading-5 tracking-[0.14px] text-inkSoft outline-none placeholder:text-[#BFBFBF] focus:border-ink focus-within:border-ink disabled:opacity-50";
const stripeField = "h-10 w-full rounded-[10px] border border-rule bg-cream p-[10px] focus-within:border-ink";
const label = "flex flex-col gap-1.5 text-[13px] font-medium leading-5 tracking-[0.01px] text-inkSoft";
const legend = "mb-3 text-[16px] font-semibold leading-6 text-ink";
const selectField = `${field} appearance-none pr-8`;
function Chevron() { return <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-inkMuted"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
const US_STATES: Array<[string, string]> = [["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["DC","District of Columbia"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],["PR","Puerto Rico"]];

function elementStyle(el: Element | null): StripeElementStyle {
  const cs = el ? getComputedStyle(el) : null;
  const rgb = (name: string, fallback: string) => {
    const parts = (cs?.getPropertyValue(name) ?? "").trim().split(/[\s,]+/).filter(Boolean);
    return parts.length >= 3 ? `rgb(${parts.slice(0, 3).join(", ")})` : fallback;
  };
  return { base: { color: rgb("--c-ink-soft", "#1f1f1f"), fontFamily: '"Plus Jakarta Sans", sans-serif', fontSize: "14px", fontWeight: "500", lineHeight: "20px", letterSpacing: "0.14px", "::placeholder": { color: "#BFBFBF" } }, invalid: { color: "#CD2029" } };
}

function CardForm({ apiBase, choice, consent, currency, onClose, onSaved, onBusy }: { apiBase: string; choice: CardChoice; consent: InAppConsent; currency: string; onClose: () => void; onSaved: (applied: boolean) => void; onBusy: (busy: boolean) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const form = useRef<HTMLFormElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ above: false, below: false });
  const measure = () => {
    const el = body.current;
    if (!el) return;
    const above = el.scrollTop > 4;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
    setEdge(e => (e.above === above && e.below === below ? e : { above, below }));
  };
  useEffect(() => {
    measure();
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [style, setStyle] = useState<StripeElementStyle>(() => elementStyle(null));
  useEffect(() => { setStyle(elementStyle(form.current)); }, []);
  const [billing, setBilling] = useState({ first: "", last: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" });
  const [busy, setBusyState] = useState(false);
  const setBusy = (v: boolean) => { setBusyState(v); onBusy(v); };
  const countryRows = useMemo(countries, []);
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const set = (k: keyof typeof billing) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setBilling(b => ({ ...b, [k]: e.target.value }));
  const ready = !!stripe && !!elements && billing.first.trim() && billing.last.trim() && billing.line1.trim() && billing.city.trim() && billing.zip.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!ready || busy || !stripe || !elements) return;
    const card = elements.getElement(CardNumberElement); if (!card) return;
    setBusy(true); setError(null);
    const requestId = crypto.randomUUID();
    try {
      const setup = await campaignFetch<{ client_secret: string; setup_intent_id: string }>(`${apiBase}/wallet/setup-intent`, { method: "POST", body: JSON.stringify({ request_id: requestId, amount_cents: choice.amount_cents, enable_refill: choice.enable_refill, allow_creators: false, consent: true, consent_version: consent.version }) });
      const result = await stripe.confirmCardSetup(setup.client_secret, { payment_method: { card, billing_details: {
        name: `${billing.first.trim()} ${billing.last.trim()}`,
        address: { line1: billing.line1.trim(), line2: billing.line2.trim() || undefined, city: billing.city.trim(), state: billing.state.trim() || undefined, postal_code: billing.zip.trim(), country: billing.country },
      } } });
      if (result.error) throw new Error(result.error.message ?? "The card could not be saved.");
      const done = await campaignFetch<{ applied: boolean }>(`${apiBase}/wallet/setup-intent/complete`, { method: "POST", body: JSON.stringify({ setup_intent_id: setup.setup_intent_id }) });
      onSaved(done.applied);
    } catch (err) { setError(err instanceof Error ? err.message : "The card could not be saved. Nothing was charged."); }
    finally { setBusy(false); }
  }

  const us = billing.country === "US";
  const holder = `${billing.first} ${billing.last}`.trim();
  return <form ref={form} onSubmit={submit} className="flex max-h-[85dvh] min-h-0 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-rule px-6 py-4">
      <div className="flex min-w-0 flex-col">
        <h2 id="ads-card-title" className="text-[20px] font-bold leading-7 text-ink">Payment &amp; Billing</h2>
        <p className="text-[13px] leading-5 text-inkMuted">{choice.enable_refill ? "Save a card for your ads balance and auto-refills." : "Save a card for your ads balance. Nothing is charged now."}</p>
      </div>
      <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className="flex size-9 shrink-0 items-center justify-center rounded-full border border-cream bg-creamDeep text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"><MaskIcon src="/icons/ads-wallet/close.svg" box={20} w={11.25} h={11.25} /></button>
    </div>
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={body} onScroll={measure} className="ws-scroll grid min-h-0 flex-1 grid-cols-1 overflow-y-auto overscroll-contain md:grid-cols-[320px_minmax(0,1fr)]">
    <div className="flex flex-col gap-5 border-b border-rule bg-creamDeep p-6 md:border-b-0 md:border-r">
      <div aria-hidden className="hidden aspect-[1.586] w-full flex-col justify-between rounded-2xl border border-white/10 bg-gradient-to-br from-[#33363b] to-[#0e0f11] p-4 text-white shadow-[0_12px_24px_rgba(16,18,20,0.18)] md:flex">
        <div className="flex items-center justify-between">
          <span className="h-7 w-9 rounded-md bg-[#6f7379]" />
          <span className="text-[12px] font-bold uppercase leading-4 tracking-[0.12em]">{brand || "Card"}</span>
        </div>
        <span className="text-[16px] font-semibold leading-6 tracking-[0.2em]">•••• •••• •••• ••••</span>
        <span className="truncate text-[12px] font-semibold uppercase leading-4 tracking-[0.08em] opacity-80">{holder || "Your name"}</span>
      </div>
      <fieldset className="flex flex-col gap-3" disabled={busy}><legend className={legend}>Card Details</legend>
        <div className={label}>Card Number<div className={stripeField}><CardNumberElement options={{ style }} onChange={e => setBrand(e.brand === "unknown" ? "" : e.brand)} /></div></div>
        <div className="grid grid-cols-2 gap-3">
          <div className={label}>Expiry Date<div className="relative"><div className={`${stripeField} pr-10`}><CardExpiryElement options={{ style }} /></div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/icons/ads-wallet/calendar.svg" alt="" width={16} height={16} className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-70" /></div></div>
          <div className={label}>Security Code<div className="relative"><div className={`${stripeField} pr-10`}><CardCvcElement options={{ style }} /></div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/icons/ads-wallet/cvv.svg" alt="" width={27} height={17} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-70" /></div></div>
        </div>
      </fieldset>
    </div>
    <div className="p-6">
    <fieldset className="flex flex-col gap-3" disabled={busy}><legend className={legend}>Billing Details</legend>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>First Name<input value={billing.first} onChange={set("first")} autoComplete="given-name" required className={field} /></label>
        <label className={label}>Last Name<input value={billing.last} onChange={set("last")} autoComplete="family-name" required className={field} /></label>
      </div>
      <label className={label}>Address 1<input value={billing.line1} onChange={set("line1")} autoComplete="address-line1" required className={field} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Address 2<input value={billing.line2} onChange={set("line2")} autoComplete="address-line2" placeholder="Apt, suite (optional)" className={field} /></label>
        <label className={label}>City<input value={billing.city} onChange={set("city")} autoComplete="address-level2" required className={field} /></label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>State{us
          ? <span className="relative"><select value={billing.state} onChange={set("state")} autoComplete="address-level1" required className={selectField}><option value="" disabled>Select state</option>{US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select><Chevron /></span>
          : <input value={billing.state} onChange={set("state")} autoComplete="address-level1" className={field} />}</label>
        <label className={label}>ZIP Code<input value={billing.zip} onChange={set("zip")} autoComplete="postal-code" required className={field} /></label>
      </div>
      <label className={label}>Country<span className="relative"><select value={billing.country} onChange={e => setBilling(b => ({ ...b, country: e.target.value, state: "" }))} autoComplete="country" className={selectField}>{countryRows.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select><Chevron /></span></label>
    </fieldset>
    </div>
    </div>
    {edge.above && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-black/15 to-transparent [html.dark_&]:from-white/10" />}
    {edge.below && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-black/15 to-transparent [html.dark_&]:from-white/10" />}
    </div>
    <div className="flex shrink-0 flex-col gap-3 border-t border-rule px-6 py-4">
    {error && <p role="alert" className="text-[14px] font-medium leading-5 text-danger">{error}</p>}
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
      <p className="text-[12px] leading-[18px] tracking-[0.01px] text-inkMuted">By saving, you authorize Zavi to charge this card for ads balance you add{choice.enable_refill ? ` and auto-refills of ${money(choice.amount_cents / 100, currency)} when your balance drops below $50.00 (up to $1,000.00 a day)` : ""}. Stored securely by Stripe.</p>
      <div className="flex shrink-0 items-center justify-end gap-3">
        <button type="button" disabled={busy} onClick={onClose} className="h-11 rounded-cta border-[1.5px] border-rule bg-cream px-4 text-[14px] font-semibold leading-5 tracking-[0.01px] text-inkSoft disabled:opacity-40">Cancel</button>
        <button type="submit" disabled={!ready || busy} className="h-11 rounded-cta bg-ink px-5 text-[14px] font-semibold leading-5 tracking-[0.01px] text-cream disabled:opacity-40">{busy ? "Saving card…" : "Save card"}</button>
      </div>
    </div>
    </div>
  </form>;
}

export function PaymentBillingModal({ open, onClose, ...props }: { open: boolean; onClose: () => void; apiBase: string; choice: CardChoice; consent: InAppConsent; currency: string; onSaved: (applied: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const stripePromise = useMemo(() => (open ? adsStripe() : null), [open]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  return <dialog ref={dialog} onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!busy.current) onClose(); }} onClose={e => e.stopPropagation()} aria-labelledby="ads-card-title" className="max-h-[85dvh] w-[min(880px,calc(100%-32px))] max-w-[880px] rounded-[25px] border border-rule bg-cream text-ink shadow-[0_24px_48px_rgba(16,18,20,0.18)] backdrop:bg-[rgba(14,15,17,0.2)] [html.dark_&]:backdrop:bg-[rgba(0,0,0,0.66)] overflow-hidden p-0">
    {open && (stripePromise
      ? <Elements stripe={stripePromise} options={{ fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" }] }}><CardForm {...props} onClose={onClose} onBusy={v => { busy.current = v; }} /></Elements>
      : <p role="alert" className="p-6 text-[13px] text-danger">Card entry is not configured for this environment.</p>)}
  </dialog>;
}
