"use client";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { CardBrandIcon, MaskIcon } from "./fundingUi";

export type SavedCard = { id: string; brand: string; last4: string; funding: string; exp_month: number; exp_year: number; city: string | null; state: string | null };

const place = (c: SavedCard) => [c.city, c.state].filter(Boolean).join(", ");

export function PaymentMethodSkeleton() {
  return <div role="status" aria-live="polite" className="flex flex-col gap-3">
    <span className="sr-only">Loading saved cards.</span>
    <div aria-hidden="true" className="flex h-10 items-center justify-between gap-4">
      <span className="h-6 w-24 animate-pulse rounded-md bg-bone motion-reduce:animate-none" />
      <span className="h-5 w-28 animate-pulse rounded-md bg-bone motion-reduce:animate-none" />
    </div>
    <div aria-hidden="true" className="flex h-12 items-center gap-2.5 rounded-xl border border-rule px-3">
      <span className="h-6 w-9 shrink-0 animate-pulse rounded bg-bone motion-reduce:animate-none" />
      <span className="h-4 w-32 animate-pulse rounded-full bg-bone motion-reduce:animate-none" />
      <span className="ml-auto h-4 w-16 animate-pulse rounded-full bg-bone motion-reduce:animate-none" />
    </div>
  </div>;
}

export function PaymentMethodSelect({ cards, pickedId, onPick, onAdd, disabled }: { cards: SavedCard[]; pickedId: string | null; onPick: (id: string) => void; onAdd: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { if (open) list.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [open]);
  const picked = cards.find(c => c.id === pickedId) ?? null;
  const others = cards.length - (picked ? 1 : 0);
  return <div ref={root} className="flex flex-col gap-3">
    <div className="flex items-center gap-4">
      <span className="min-w-0 flex-1 text-[20px] font-semibold leading-7 text-ink">Payment</span>
      <button type="button" disabled={disabled} onClick={onAdd} className="flex h-10 shrink-0 items-center justify-center rounded-cta px-4 text-[14px] font-semibold leading-5 tracking-[0.01px] text-[#027bff] disabled:opacity-40">Add New Card</button>
    </div>
    {cards.length === 0
      ? <p className="flex h-12 items-center rounded-xl border border-rule px-3 text-[14px] font-medium leading-5 tracking-[0.14px] text-inkMuted">No saved card yet. Add one to pay for ads.</p>
      : <div>
        <button type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)} className="flex h-12 w-full items-center gap-2 rounded-cta border border-rule py-3 pl-3 pr-2 text-left disabled:opacity-60">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            {picked ? <><CardBrandIcon brand={picked.brand} /><span className="min-w-0 flex-1 truncate text-[16px] font-medium leading-6 text-ink">XXXX- {picked.last4}</span></> : <span className="text-[16px] font-medium leading-6 text-inkMuted">Choose a card</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-md py-1 pl-2 pr-1 text-ink">
            {others > 0 && <span className="whitespace-nowrap text-[16px] font-medium leading-6">+{others} Saved</span>}
            <span className={`transition-transform ${open ? "rotate-180" : ""}`}><MaskIcon src="/icons/ads-wallet/arrow-down.svg" box={24} w={13.5} h={7.5} /></span>
          </span>
        </button>
        {open && <ul ref={list} role="listbox" aria-label="Saved cards" className="mt-1 max-h-[232px] overflow-y-auto overscroll-contain rounded-xl border border-rule bg-cream">
          {cards.map(c => <li key={c.id} role="option" aria-selected={c.id === pickedId}>
            <button type="button" onClick={() => { onPick(c.id); setOpen(false); }} className={`flex w-full items-center gap-2.5 border-b border-rule px-3 py-2.5 text-left last:border-b-0 ${c.id === pickedId ? "bg-bone" : "hover:bg-bone"}`}>
              <CardBrandIcon brand={c.brand} />
              <span className="min-w-0 flex-1"><span className="block text-[16px] font-medium leading-6 text-ink">XXXX - {c.last4} {c.funding !== "unknown" ? c.funding : ""}</span>{place(c) && <span className="block text-[14px] font-medium leading-5 text-inkMuted">{place(c)}</span>}</span>
              {c.id === pickedId && <Check size={18} className="shrink-0 text-[#027bff]" aria-label="Selected" />}
            </button>
          </li>)}
        </ul>}
      </div>}
  </div>;
}
