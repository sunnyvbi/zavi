"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { adsStripe } from "@/lib/stripe/adsStripe";
import { campaignFetch } from "./api";
import { money } from "./format";
import { PaymentBillingModal, type CardChoice, type InAppConsent } from "./PaymentBillingModal";
import { CheckCard, InfoNote, MaskIcon, addedToast } from "./fundingUi";
import { PaymentMethodSelect, PaymentMethodSkeleton, type SavedCard } from "./PaymentMethodSelect";
import type { CampaignWorkspaceSpec } from "./types";

type Cards = { tenant_id: string; cards: SavedCard[]; selected_id: string | null; creator_consent: boolean; consent: InAppConsent };
type PayStatus = { order_id: string; status: "pending" | "requires_action" | "paid" | "failed"; client_secret?: string | null };
export type FundingWallet = { balance_cents: number; auto_refill_enabled: boolean; refill_cents: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type PayRequest = { signature: string; id: string; amount?: string; card?: string | null } | null;
const payStore = (key: string) => ({
  read(): PayRequest { try { return JSON.parse(localStorage.getItem(key) ?? "null") as PayRequest; } catch { return null; } },
  write(v: PayRequest) { try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch {  } },
});

export function InAppFunding({ spec, platform, wallet, onChanged, onPaid, onClose, busyChange, initialAmount }: { spec: CampaignWorkspaceSpec; platform?: "linkedin"; wallet: FundingWallet; onChanged: () => void; onPaid?: () => void; onClose: () => void; busyChange?: (busy: boolean) => void; initialAmount?: number }) {
  const base = "/api/ads"; const b = spec.balance;
  const [data, setData] = useState<Cards | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(initialAmount ?? 100));
  const [refillChoice, setRefillChoice] = useState<boolean | null>(null);
  const refill = refillChoice ?? wallet.auto_refill_enabled;
  const [allowCreators, setAllowCreators] = useState(false);
  const creatorsTicked = useRef(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const storeKey = useRef<string | null>(null);
  const request = useRef<PayRequest>(null);
  const [open, setOpen] = useState<PayRequest>(null);
  const [reconciled, setReconciled] = useState(false);
  const [known, setKnown] = useState(false);
  const setRequest = (v: PayRequest) => { request.current = v; if (storeKey.current) payStore(storeKey.current).write(v); setOpen(v); if (!v) setKnown(false); };
  const setBusy = (v: boolean) => { setBusyState(v); busyChange?.(v); };

  const orderState = useCallback(async (id: string): Promise<PayStatus["status"] | "none" | null> => {
    try { return (await campaignFetch<PayStatus>(`${base}/wallet/orders/${id}`)).status; }
    catch (e) { return (e as { status?: number }).status === 404 ? "none" : null; }
  }, [base]);

  const load = useCallback(async (): Promise<Cards | null> => {
    try {
      const r = await campaignFetch<Cards>(`${base}/wallet/payment-methods${platform ? `?platform=${platform}` : ""}`);
      storeKey.current = `zavi.adsPay.${r.tenant_id}./api/channels/chatgpt_ads`;
      setData(r);
      setPicked(p => (p && r.cards.some(c => c.id === p) ? p : r.selected_id ?? r.cards[0]?.id ?? null));
      setAllowCreators(r.creator_consent);
      return r;
    } catch (e) { setError(e instanceof Error ? e.message : "Saved cards are unavailable. Try again."); return null; }
  }, [base, platform]);
  useEffect(() => {
    void (async () => {
      const r = await load();
      if (!r || !storeKey.current) return;
      const prior = payStore(storeKey.current).read();
      if (prior) {
        request.current = prior; setOpen(prior);
        const st = await orderState(prior.id);
        if (st === "paid") { setRequest(null); onChanged(); onPaid?.(); paidToast(prior.amount ? Math.round(Number(prior.amount) * 100) : null); }
        else if (st === "failed") setRequest(null);
        else { if (prior.amount) setAmount(prior.amount); if (prior.card) { setPicked(prior.card); if (prior.card !== r.selected_id) setAllowCreators(false); } setKnown(st !== "none"); setNotice(st === "none" ? unreached(prior.amount) : st === null ? `Zavi could not check your earlier payment of $${prior.amount ?? "?"}. Click Check payment to try again; you will not be charged twice.` : `A payment of $${prior.amount ?? "?"} is still being confirmed. Click Check payment; you will not be charged twice.`); }
      }
      setReconciled(true);
    })();
  }, [load, orderState]);

  const locked = !!open;
  const checking = locked && known;
  const cents = Math.round(Number(amount) * 100);
  const amountOk = /^\d+(\.\d{1,2})?$/.test(amount) && Number.isFinite(cents) && cents >= b.minTopup && cents <= b.maxTopup;
  const valid = amountOk;
  const refillCents = Math.min(Math.max(wallet.refill_cents, b.minRefill), b.dailyRefillCap);
  const choice: CardChoice = { amount_cents: refillCents, enable_refill: refill };
  const settingsChanged = !!data && !locked && (picked !== data.selected_id || (refillChoice !== null && refillChoice !== wallet.auto_refill_enabled) || allowCreators !== data.creator_consent);
  const canSubmit = !!data && !!picked && valid && reconciled && !busy;

  async function select() {
    await campaignFetch(`${base}/wallet/payment-methods/select`, { method: "POST", body: JSON.stringify({ payment_method_id: picked, amount_cents: choice.amount_cents, enable_refill: choice.enable_refill, allow_creators: allowCreators, consent: true, consent_version: data!.consent.version }) });
  }

  async function waitForOrder(orderId: string): Promise<PayStatus["status"]> {
    for (let i = 0; i < 15; i++) {
      const st = await orderState(orderId);
      if (st === "paid" || st === "failed" || st === "requires_action") return st;
      await sleep(2000);
    }
    return "pending";
  }

  function unreached(amount?: string) {
    return `Zavi has no record of your earlier payment of $${amount ?? "?"}, so you have not been charged. Click Pay to try again; you will not be charged twice.`;
  }

  const paidToast = (cents: number | null) => addedToast(cents, b.currency, spec.title);

  async function settle(id: string, definite: boolean): Promise<PayStatus["status"] | "none" | null> {
    const st = await orderState(id);
    if (st === "paid") { const paid = request.current?.amount ? Math.round(Number(request.current.amount) * 100) : null; setRequest(null); onChanged(); onPaid?.(); paidToast(paid); onClose(); }
    else if (st === "failed" || (st === "none" && definite)) setRequest(null);
    else if (request.current) setKnown(st !== "none");
    return st;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!canSubmit) return;
    setBusy(true); setError(null); setNotice(null);
    let req: PayRequest = request.current;
    try {
      if (req && known) {
        const st = await settle(req.id, false);
        if (st === "failed") { setError("The payment did not go through. Nothing was charged. Try again or use another card."); return; }
        if (st === "none") { setNotice(unreached(req.amount)); return; }
        if (st === "pending") { setNotice(`A payment of $${req.amount ?? "?"} is still being confirmed. Click Check payment again in a minute; you will not be charged twice.`); return; }
        if (st === null) { setError("Zavi could not check this payment. Try again in a moment."); return; }
        if (st !== "requires_action") return;
      }
      if (settingsChanged) { await select(); await load(); onChanged(); }
      if (!req) { req = { signature: "pay", id: crypto.randomUUID(), amount, card: picked }; setRequest(req); }
      const payCents = Math.round(Number(req.amount) * 100);
      let pay = await campaignFetch<PayStatus>(`${base}/wallet/pay`, { method: "POST", body: JSON.stringify({ request_id: req.id, amount_cents: payCents, payment_method_id: req.card }) });
      setKnown(true);
      if (pay.status === "requires_action" && pay.client_secret) {
        const stripe = await adsStripe();
        const r = stripe ? await stripe.handleNextAction({ clientSecret: pay.client_secret }) : null;
        if (!stripe || r?.error) {
          const st = await settle(req.id, false);
          setError(`${r?.error?.message ?? "Card authentication could not start."} Nothing was charged. ${st === "failed" ? "Try again or use another card." : "Click Check payment to try again."}`);
          return;
        }
        pay = { ...pay, status: "pending" };
      }
      const final = pay.status === "failed" ? "failed" : pay.status === "paid" ? "paid" : await waitForOrder(pay.order_id);
      if (final === "failed") { setRequest(null); setError("The payment did not go through. Nothing was charged. Try again or use another card."); return; }
      if (final === "requires_action") { setError("Your bank needs you to confirm this payment. Click Check payment to continue."); return; }
      if (final === "paid") { setRequest(null); onChanged(); onPaid?.(); paidToast(payCents); onClose(); return; }
      setNotice("Payment is processing. Your ads balance updates as soon as it clears.");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payment could not be completed. Your balance has not changed.");
      const status = (err as { status?: number }).status;
      if (req) await settle(req.id, !!status && status >= 400 && status < 500);
    } finally { setBusy(false); }
  }

  const fmt = (c: number) => money(c / 100, b.currency);
  return <>
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h2 id="ads-balance-title" className="text-[24px] font-bold leading-[34px] text-ink">Add ads balance</h2>
          <p className="text-[14px] font-medium leading-5 tracking-[0.14px] text-ink">Current balance: {fmt(wallet.balance_cents)}</p>
        </div>
        <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className="flex shrink-0 items-center justify-center rounded-block border border-rule bg-cream p-2 text-inkSoft outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"><MaskIcon src="/icons/ads-wallet/close.svg" box={20} w={11.25} h={11.25} /></button>
      </div>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-2 text-[14px] font-medium leading-5 tracking-[0.14px] text-inkSoft">Amount to add
            <span className="flex h-12 items-center gap-1 rounded-xl border border-rule bg-cream p-3 focus-within:border-ink">
              <span className="text-[16px] font-medium leading-6 text-ink">$</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min={b.minTopup / 100} max={b.maxTopup / 100} step="0.01" required disabled={busy || locked} className="min-w-0 flex-1 bg-transparent text-[16px] font-medium leading-6 text-ink outline-none disabled:opacity-60" aria-label={`Amount in ${b.currency}`} />
            </span>
          </label>
          <div className="flex items-center gap-2 sm:gap-[15px]">{b.presets.map(n => <button type="button" disabled={busy || locked} key={n} onClick={() => setAmount(String(n))} className={`h-10 min-w-0 flex-1 rounded-cta px-2 text-[14px] font-semibold leading-5 tracking-[0.01px] disabled:opacity-40 sm:px-4 ${Number(amount) === n ? "bg-ink text-cream" : "border border-rule bg-cream text-inkSoft"}`}>${n}</button>)}</div>
        </div>
        {data ? <PaymentMethodSelect cards={data.cards} pickedId={picked} onPick={id => { setPicked(id); creatorsTicked.current = false; setAllowCreators(id === data.selected_id && data.creator_consent); }} onAdd={() => setAdding(true)} disabled={busy || locked} /> : !error && <PaymentMethodSkeleton />}
      </div>
      {data && <div className="flex flex-col gap-4">
        <CheckCard checked={refill} onChange={setRefillChoice} disabled={busy || locked}
          detail={refill ? <>When your ads balance drops below {fmt(b.threshold)}, Zavi charges {fmt(refillCents)} to your saved card. The daily limit is {fmt(b.dailyRefillCap)} (midnight UTC reset). You can disable auto-refill at any time.</> : undefined}>Also auto-refill my ads balance</CheckCard>
        <CheckCard checked={allowCreators} onChange={v => { creatorsTicked.current = v; setAllowCreators(v); }} disabled={busy || locked}>Authorize Zavi to charge this card for creator hires Autopilot books within its caps.</CheckCard>
      </div>}
      <InfoNote>After payment, your ads balance will be {amountOk ? fmt(wallet.balance_cents + cents) : "-"}. Ad spend is separate from your Zavi credits.</InfoNote>
      {notice && <p role="status" className="rounded-xl bg-successBg p-3 text-[14px] font-medium leading-5 text-success">{notice}</p>}
      {error && <p role="alert" className="text-[14px] font-medium leading-5 text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2.5">
        <button type="button" disabled={busy} onClick={onClose} className="h-12 rounded-cta border-[1.5px] border-rule bg-cream px-4 text-[16px] font-semibold leading-6 tracking-[0.01px] text-inkSoft disabled:opacity-40">Cancel</button>
        <button type="submit" disabled={!canSubmit} className="h-12 rounded-cta bg-ink px-4 text-[16px] font-semibold leading-6 tracking-[0.01px] text-cream disabled:opacity-40">{busy ? "Processing payment…" : checking ? "Check payment" : `Pay ${amountOk ? fmt(cents) : "$0.00"}`}</button>
      </div>
    </form>
    {data && <PaymentBillingModal open={adding} onClose={() => setAdding(false)} apiBase={base} choice={choice} consent={data.consent} currency={b.currency}
      onSaved={applied => { setAdding(false); setNotice(applied ? "Card saved. It is now your ads payment card." : "Card saved. A newer card choice was kept as your ads payment card."); setPicked(null);
        const keepCreators = allowCreators && creatorsTicked.current; void load().then(() => setAllowCreators(keepCreators)); onChanged(); }} />}
  </>;
}
