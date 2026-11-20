"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Wallet as WalletIcon, X } from "lucide-react";
import { campaignFetch } from "./api";
import { money } from "./format";
import { adsPublishableKey } from "@/lib/stripe/adsStripe";
import { InAppFunding } from "./InAppFunding";
import { CheckCard, addedToast } from "./fundingUi";
import { Button } from "@/components/ui/Button";
import { isMember } from "@/lib/members";
import { useWorkspaceOptional } from "../../WorkspaceShell";

import type { CampaignWorkspaceSpec } from "./types";

type Wallet = { balance_cents: number; reserved_cents: number; available_cents: number; auto_refill_enabled: boolean; refill_cents: number; threshold_cents: number; pending: boolean; funding_enabled: boolean; in_app_enabled?: boolean; last_error: string | null };
const CHECKOUT_KEY = "zavi.adsCheckout";
const pillMoney = (cents: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
const OWNERS_ONLY = "Only workspace owners and admins can add balance or turn off auto-refill.";

function AutoRefillState({ detail, turningOff, disabled, onTurnOff, className }: { detail: string | null; turningOff: boolean; disabled: boolean; onTurnOff?: () => void; className: string }) {
  return <div data-testid="auto-refill-state" className={`flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-rule px-3 py-2.5 ${className}`}>
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-[13px] font-medium leading-5 text-ink"><span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />Auto-refill is on</p>
      {detail && <p className="pl-4 text-[12px] leading-4 text-inkMuted">{detail}</p>}
    </div>
    {onTurnOff && <Button variant="secondary" className="h-9 shrink-0 px-3" aria-label="Turn off auto-refill" aria-busy={turningOff || undefined} disabled={disabled} onClick={onTurnOff}>{turningOff ? "Turning off…" : "Turn off"}</Button>}
  </div>;
}
export function ChannelBalance({ spec, platform, refreshKey, cancellationOnly = false, variant = "tile", suggestedAmount, onChanged, onDialogClosed, onWallet }: {
  spec: CampaignWorkspaceSpec; platform?: "linkedin"; refreshKey?: unknown; cancellationOnly?: boolean;
  variant?: "tile" | "card" | "dialog" | "pill";
  onDialogClosed?: () => void;
  suggestedAmount?: number;
  onChanged?: () => void;
  onWallet?: (wallet: Wallet) => void;
}) {
  const channel = platform === "linkedin" ? "LinkedIn" : spec.title.replace(/ Ads$/, "");
  const member = isMember(useWorkspaceOptional()?.role ?? null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(variant === "dialog");
  const [mode, setMode] = useState<"setup" | "topup">("setup");
  const [amount, setAmount] = useState(String(suggestedAmount ?? 100));
  const [consent, setConsent] = useState(false);
  const [refill, setRefill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const latch = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const walletRead = useRef(onWallet);
  walletRead.current = onWallet;
  const [returned, setReturned] = useState<{ result: "success" | "cancel"; mode?: "setup" | "topup"; cents?: number; refill?: boolean; id?: string } | null>(null);
  const [credit, setCredit] = useState<"paid" | "failed" | null>(null);
  const [clearedError, setClearedError] = useState<string | null>(null);
  const lastBalance = useRef<number | null>(null);
  const walletTurn = useRef(0);
  const clearNext = useRef(false);
  const refresh = useCallback(async () => {
    const turn = ++walletTurn.current;
    try {
      const w = await campaignFetch<Wallet>(`/api/ads/wallet`);
      if (turn !== walletTurn.current) return;
      if (lastBalance.current !== null && lastBalance.current !== w.balance_cents) changed.current?.();
      lastBalance.current = w.balance_cents;
      setWallet(w); setError(null);
      walletRead.current?.(w);
      if (clearNext.current) { clearNext.current = false; setClearedError(w.last_error); }
      else setClearedError(c => (c !== null && c !== w.last_error ? null : c));
    }
    catch { if (turn === walletTurn.current) setError("Ads balance is unavailable. Try again."); }
  }, [spec.apiBase]);
  const walletNow = useRef(wallet);
  walletNow.current = wallet;
  const paidByHand = useCallback(() => { clearNext.current = true; setClearedError(walletNow.current?.last_error ?? null); }, []);
  useEffect(() => { void refresh(); const onFocus = () => void refresh(); window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus); }, [refresh, refreshKey]);
  useEffect(() => {
    if (!wallet?.pending) return;
    const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer);
  }, [wallet?.pending, refresh]);
  useEffect(() => {
    if (variant === "dialog") return;
    try {
      const url = new URL(window.location.href);
      const result = url.searchParams.get("ads_payment");
      if (result !== "success" && result !== "cancel") return;
      let saved: { mode?: "setup" | "topup"; cents?: number; refill?: boolean; id?: string } = {};
      try { saved = JSON.parse(sessionStorage.getItem(CHECKOUT_KEY) ?? "{}") ?? {}; sessionStorage.removeItem(CHECKOUT_KEY); } catch { saved = {}; }
      url.searchParams.delete("ads_payment");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      setReturned({ result, ...(result === "success" && (saved.mode === "setup" || saved.mode === "topup") ? { mode: saved.mode, cents: saved.cents, refill: saved.refill, id: typeof saved.id === "string" ? saved.id : undefined } : {}) });
    } catch { return; }
  }, [variant]);
  useEffect(() => {
    setCredit(null);
    if (returned?.result !== "success" || returned.mode !== "topup") return;
    const id = returned.id;
    let stopped = false; let tries = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      tries++;
      let status: string | null = null;
      if (id) { try { status = (await campaignFetch<{ status: string }>(`/api/ads/wallet/orders/${id}`)).status; } catch { status = null; } }
      if (stopped) return;
      if (status === "paid") paidByHand();
      await refresh();
      if (stopped) return;
      if (status === "paid" || status === "failed") { setCredit(status); return; }
      if (tries < 20) timer = setTimeout(() => void check(), 3000);
    };
    void check();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [returned, refresh, paidByHand]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const closedOnce = useRef(onDialogClosed);
  closedOnce.current = onDialogClosed;
  useEffect(() => { if (variant === "dialog" && !open) closedOnce.current?.(); }, [variant, open]);
  const refillSeeded = useRef(false);
  useEffect(() => { if (variant === "dialog" && wallet && !refillSeeded.current) { refillSeeded.current = true; setRefill(!!wallet.auto_refill_enabled); } }, [variant, wallet]);
  const inApp = !!wallet?.in_app_enabled && !!adsPublishableKey();
  const amountShown = mode === "topup" || refill;
  const cents = amountShown ? Math.round(Number(amount) * 100) : spec.balance.minRefill;
  const valid = !amountShown || Number.isFinite(cents) && cents >= (mode === "setup" ? spec.balance.minRefill : spec.balance.minTopup) && cents <= (mode === "setup" ? spec.balance.dailyRefillCap : spec.balance.maxTopup) && /^\d+(\.\d{1,2})?$/.test(amount);
  const underRefillMin = mode === "setup" && refill && /^\d+(\.\d{1,2})?$/.test(amount) && Number.isFinite(cents) && cents > 0 && cents < spec.balance.minRefill && cents >= spec.balance.minTopup && cents <= spec.balance.maxTopup;
  function addOnce() { setMode("topup"); setConsent(false); }
  function addNow() { setMode("topup"); setConsent(false); setRefill(!!wallet?.auto_refill_enabled); setReturned(null); setOpen(true); }
  const paidCents = returned?.cents ?? null;
  useEffect(() => { if (variant === "pill" && credit === "paid") addedToast(paidCents, spec.balance.currency, spec.title); }, [variant, credit, paidCents, spec.balance.currency, spec.title]);
  const noticeAmount = returned?.cents ? money(returned.cents / 100, spec.balance.currency) : null;
  const notice = returned && <div role="status" data-testid="ads-payment-notice" className="rounded-xl border border-rule bg-bone p-3 text-[13px] text-ink">
    {returned.result === "cancel" ? <p>Checkout was cancelled. Nothing was charged and your balance has not changed.</p>
      : returned.mode === "setup" ? <p><strong>Card saved. No money was added to your ads balance.</strong> {returned.refill ? `Auto-refill is on: Zavi charges this card${noticeAmount ? ` ${noticeAmount}` : ""} when your balance drops below ${money(spec.balance.threshold / 100, spec.balance.currency)}.` : "Auto-refill is off."} To add money now, use Add once.</p>
      : returned.mode === "topup" ? credit === "failed" ? <p><strong>The payment did not go through. Nothing was charged.</strong></p>
        : <p><strong>{credit === "paid" ? `${noticeAmount ?? "Your payment"} was added to your ads balance.` : `${noticeAmount ?? "Your payment"} is being added to your ads balance.`}</strong>{credit === "paid" ? null : " Your balance updates as soon as the payment clears."}</p>
      : <p>Checkout finished. Check your balance below; if you only saved a card, no money was added.</p>}
    <div className="mt-2 flex gap-3">
      {returned.result === "success" && returned.mode !== "topup" && !cancellationOnly && !member && wallet?.funding_enabled && <button type="button" onClick={addNow} className="underline">Add money now</button>}
      <button type="button" onClick={() => setReturned(null)} className="underline">Dismiss</button>
    </div>
  </div>;
  async function pay(e: React.FormEvent) {
    e.preventDefault(); if (cancellationOnly || !wallet?.funding_enabled || latch.current || !valid || (mode === "setup" && !consent)) return;
    latch.current = true; setBusy(true); setError(null);
    const signature = `${mode}:${cents}:${refill}`;
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    try {
      const result = await campaignFetch<{ url: string }>(`/api/ads/wallet/checkout`, { method: "POST", body: JSON.stringify({ mode, amount_cents: cents, consent, ...(mode === "setup" ? { enable_refill: refill } : {}), request_id: request.current.id, ...(platform ? { platform } : {}) }) });
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Payment link is unavailable.");
      try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify({ mode, cents, refill: mode === "setup" && refill, id: request.current.id })); } catch { void 0; }
      window.location.assign(url.href);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open checkout. Your balance has not changed."); }
    finally { latch.current = false; setBusy(false); }
  }
  async function disable() {
    if (latch.current) return; latch.current = true; setBusy(true); setTurningOff(true);
    try { await campaignFetch(`/api/ads/wallet/disable-refill`, { method: "POST" }); await refresh(); }
    catch { setError("Auto-refill could not be disabled. Try again."); }
    finally { latch.current = false; setBusy(false); setTurningOff(false); }
  }
  const refillState = (className: string) => wallet?.auto_refill_enabled ? <AutoRefillState detail={wallet.refill_cents > 0 ? `${money(wallet.refill_cents / 100, spec.balance.currency)} per refill` : null} turningOff={turningOff} disabled={busy} onTurnOff={member ? undefined : () => void disable()} className={className} /> : null;
  const shownError = error || (wallet?.last_error && wallet.last_error !== clearedError ? wallet.last_error : null);
  const ownersOnly = (className: string) => member && wallet ? <p data-testid="wallet-owners-only" className={className}>{OWNERS_ONLY}</p> : null;
  return <>
    {variant === "dialog" ? null : variant === "pill" ? <button type="button" data-testid="balance-pill" disabled={!wallet} onClick={() => { setOpen(true); setConsent(false); setMode("setup"); setRefill(!!wallet?.auto_refill_enabled); }} className="inline-flex h-9 items-center rounded-full border border-ca-strong bg-ca-bg text-ca-action font-semibold text-ca-xdark hover:bg-ca-hover focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60">
      <span className="inline-flex items-center gap-2 pl-4 pr-3 tabular-nums"><WalletIcon size={16} aria-hidden className="text-ca-secondary" /><span className="sr-only">Shared ads balance</span>{wallet ? pillMoney(wallet.balance_cents, spec.balance.currency) : "-"}</span>
      {!cancellationOnly && !member && <><span aria-hidden className="h-4 w-px bg-ca-strong" /><span className="pl-3 pr-4">Add money</span></>}
    </button> : variant === "card" ? <div className="flex h-full flex-col gap-2 rounded-2xl border border-ca-border bg-ca-bg p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="whitespace-nowrap text-[16px] font-semibold leading-6 text-ca-xdark">Shared ads balance</span>
          <strong className="text-[16px] font-semibold leading-6 tabular-nums text-ca-xdark">{wallet ? money(wallet.balance_cents / 100, spec.balance.currency) : "-"}</strong>
        </div>
        {!cancellationOnly && !member && wallet?.funding_enabled && <button type="button" onClick={() => { setOpen(true); setConsent(false); setMode("setup"); setRefill(!!wallet?.auto_refill_enabled); }} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-ca-action px-4 text-ca-action font-semibold text-ca-on-action"><Plus size={16} aria-hidden />Add Balance</button>}
      </div>
      {wallet && platform !== "linkedin" && <p className="text-[12px] text-inkMuted">{money(wallet.available_cents / 100, spec.balance.currency)} available</p>}
      {wallet && wallet.reserved_cents > 0 && <p className="text-[12px] text-inkMuted">{money(wallet.reserved_cents / 100, spec.balance.currency)} reserved</p>}
      {notice}
      <div className="mt-auto flex flex-col items-start gap-2 empty:hidden">
        {wallet && !wallet.funding_enabled && <p className="text-xs text-inkMuted">Payments are unavailable. Zavi will enable them when setup is complete.</p>}
        {refillState("bg-bone")}
        {ownersOnly("text-xs text-inkMuted")}
        {shownError && <p role="alert" className="text-xs text-danger">{shownError}</p>}
      </div>
    </div> : <div className="flex min-h-[104px] justify-between gap-3 rounded-2xl border border-rule bg-bone/60 px-4 py-4"><div className="min-w-0 flex-1"><span className="text-[14px] text-inkMuted">Shared ads balance</span>{!cancellationOnly && !member && wallet?.funding_enabled && <button type="button" onClick={() => { setOpen(true); setConsent(false); setMode("setup"); setRefill(!!wallet?.auto_refill_enabled); }} className="mt-2 block rounded-cta bg-ink px-3 py-1.5 text-[12px] font-medium text-cream">+ Add balance</button>}{wallet && !wallet.funding_enabled && <p className="mt-2 text-xs text-inkMuted">Payments are unavailable. Zavi will enable them when setup is complete.</p>}{wallet?.auto_refill_enabled && <div className="mt-2">{refillState("bg-cream")}</div>}{ownersOnly("mt-2 text-xs text-inkMuted")}{shownError && <p role="alert" className="mt-2 text-xs text-danger">{shownError}</p>}</div><div className="text-right"><strong className="text-[22px] font-medium tabular-nums text-ink">{wallet ? money(wallet.balance_cents / 100, spec.balance.currency) : "-"}</strong><p className="mt-1 text-[12px] text-inkMuted">{wallet?.pending ? "Refill pending" : wallet?.auto_refill_enabled ? "Auto-refill on" : "Ads funds"}</p>{notice}{wallet && wallet.reserved_cents > 0 && <p className="text-[11px] text-inkMuted">{money(wallet.reserved_cents / 100, spec.balance.currency)} reserved</p>}</div></div>}
    <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)} aria-labelledby="ads-balance-title" className={inApp ? "max-h-[85dvh] w-[min(592px,calc(100%-32px))] max-w-[592px] rounded-[25px] border border-rule bg-cream text-ink shadow-[0_24px_48px_rgba(16,18,20,0.18)] backdrop:bg-[rgba(14,15,17,0.2)] [html.dark_&]:backdrop:bg-[rgba(0,0,0,0.66)] overflow-y-auto p-6" : "w-[min(560px,calc(100%-32px))] max-w-[560px] rounded-3xl border border-rule bg-cream p-6 text-ink shadow-2xl backdrop:bg-black/60 sm:p-9"}>
      {open && member ? <div className="space-y-5"><div className="flex items-start justify-between gap-3"><h2 id="ads-balance-title" className="text-[24px] font-semibold">Add ads balance</h2><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={20} /></button></div><p className="text-[14px] text-inkMuted">{OWNERS_ONLY}</p></div>
        : open && wallet && !wallet.funding_enabled ? <div className="space-y-5"><div className="flex items-start justify-between gap-3"><div><h2 id="ads-balance-title" className="text-[24px] font-semibold">Add ads balance</h2><p className="mt-1 text-[14px] text-inkMuted">Current balance: {money(wallet.balance_cents / 100, spec.balance.currency)}</p></div><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={20} /></button></div><p className="rounded-xl bg-bone p-4 text-[14px] text-inkMuted">Payments are not available for this workspace yet, so money cannot be added here. Zavi turns them on when setup is complete.</p></div>
        : open && inApp && wallet ? <InAppFunding spec={spec} platform={platform} wallet={wallet} initialAmount={suggestedAmount} onChanged={() => void refresh()} onPaid={paidByHand} onClose={() => setOpen(false)} busyChange={setBusy} /> : <form onSubmit={pay} className="space-y-5"><div className="flex items-start justify-between gap-3"><div><h2 id="ads-balance-title" className="text-[24px] font-semibold">Add ads balance</h2><p className="mt-1 text-[14px] text-inkMuted">Current balance: {wallet ? money(wallet.balance_cents / 100, spec.balance.currency) : "Unavailable"}</p></div><button type="button" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></div>
        <div className="grid grid-cols-2 rounded-xl bg-bone p-1">{([["setup", "Card"], ["topup", "Add once"]] as const).map(([key, label]) => <button type="button" key={key} disabled={busy} aria-pressed={mode === key} onClick={() => { setMode(key); setConsent(false); }} className={`rounded-cta py-2.5 text-[14px] ${mode === key ? "bg-cream font-semibold shadow-sm" : "text-inkMuted"}`}>{label}</button>)}</div>
        {amountShown && <><label className="block text-[14px] font-medium">{mode === "setup" ? "Refill amount" : "Amount to add"}<div className="mt-2 flex items-center gap-2 rounded-xl border border-rule px-4"><span className="text-inkMuted">$</span><input type="number" value={amount} onChange={e => setAmount(e.target.value)} min={(mode === "setup" ? spec.balance.minRefill : spec.balance.minTopup) / 100} max={(mode === "setup" ? spec.balance.dailyRefillCap : spec.balance.maxTopup) / 100} step="0.01" required disabled={busy} className="h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none" aria-label={`Amount in ${spec.balance.currency}`} /></div></label>
        <div className="grid grid-cols-4 gap-2">{spec.balance.presets.map(n => <button type="button" disabled={busy} key={n} onClick={() => setAmount(String(n))} className={`rounded-cta border border-rule py-2.5 text-[14px] ${Number(amount) === n ? "bg-ink text-cream" : ""}`}>${n}</button>)}</div></>}
        {mode === "setup" && <p className="rounded-xl bg-bone p-4 text-[13px] text-inkMuted">Card saves a payment card{refill ? " and turns on auto-refill" : ""}. It does not add money to your ads balance now. To add money now, <button type="button" disabled={busy} onClick={addOnce} className="underline">switch to Add once</button>.</p>}
        {underRefillMin && <p role="alert" className="text-[13px] text-danger">Auto-refill amounts start at {money(spec.balance.minRefill / 100, spec.balance.currency)}. To add {money(cents / 100, spec.balance.currency)} now, <button type="button" disabled={busy} onClick={addOnce} className="underline">switch to Add once</button>.</p>}
        {mode === "setup" ? <><CheckCard checked={refill} onChange={v => { setRefill(v); setConsent(false); }} disabled={busy} detail={refill ? <>When your ads balance drops below {money(spec.balance.threshold / 100, spec.balance.currency)}, Zavi charges {money(valid ? cents / 100 : 0, spec.balance.currency)} to your saved card. The daily limit is {money(spec.balance.dailyRefillCap / 100, spec.balance.currency)} (midnight UTC reset). You can disable auto-refill at any time.</> : undefined}>Also auto-refill my ads balance</CheckCard><CheckCard checked={consent} onChange={setConsent} disabled={busy}>{refill ? `Authorize Zavi to charge this card for ${channel} ads refills and for creator hires Autopilot books within its caps. Refills are $${(valid ? cents / 100 : 0).toFixed(2)} whenever your ads balance falls below $${(spec.balance.threshold / 100).toLocaleString("en-US")}, up to $${(spec.balance.dailyRefillCap / 100).toLocaleString("en-US")} per UTC day. Disable auto-refill in the ${channel} Ads channel at any time.` : "Authorize Zavi to charge this card for creator hires Autopilot books within its caps."}</CheckCard></> : <p className="rounded-xl bg-bone p-4 text-[13px] text-inkMuted">After payment, your ads balance will be {wallet && valid ? money((wallet.balance_cents + cents) / 100, spec.balance.currency) : "-"}. Ad spend is separate from your Zavi credits. A campaign’s remaining lifetime budget is reserved before activation. Reservations remain held when a campaign is paused or its budget is reduced, until spend is reconciled or support reviews the remainder.</p>}
        {refillState("bg-bone")}
        {!wallet?.funding_enabled && <p className="text-[13px] text-inkMuted">Payments are not configured for this environment yet.</p>}
        {shownError && <p role="alert" className="text-[13px] text-danger">{shownError} <button type="button" onClick={() => void refresh()} className="underline">Refresh</button></p>}
        <div className="flex justify-end gap-3"><Button variant="secondary" className="h-11 px-4 text-[14px]" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" className="h-11 px-4 text-[14px]" disabled={busy || !valid || !wallet?.funding_enabled || (mode === "setup" && !consent)}>{busy ? "Opening checkout…" : mode === "setup" ? "Save card" : `Pay ${money(valid ? cents / 100 : 0, spec.balance.currency)}`}</Button></div>
      </form>}
    </dialog>
  </>;
}
