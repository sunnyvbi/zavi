"use client";
import type { ReactNode } from "react";
import { toast } from "@/components/ui/toast";

export function addedToast(cents: number | null, currency: string, channel: string) {
  const amount = cents ? new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100) : null;
  toast.add({ type: "success", inverse: true, position: "bottom-center", title: amount ? `Added ${amount}` : "Money added", description: channel });
}

export function MaskIcon({ src, box, w, h }: { src: string; box: number; w: number; h: number }) {
  const mask = `url(${src}) center / contain no-repeat`;
  return <span aria-hidden className="flex shrink-0 items-center justify-center" style={{ width: box, height: box }}>
    <span className="block bg-current" style={{ width: w, height: h, mask, WebkitMask: mask }} />
  </span>;
}

export function InfoIcon() {
  return <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/icons/ads-wallet/info-circle.svg" alt="" width={21.5} height={21.5} className="block" />
  </span>;
}

export function InfoNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2.5 rounded-xl bg-[#e6f2ff] p-3">
    <InfoIcon />
    <p className="min-w-0 flex-1 text-[14px] font-medium leading-5 tracking-[0.14px] text-[#454545]">{children}</p>
  </div>;
}

export function CardBrandIcon({ brand }: { brand: string }) {
  if (brand === "visa") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/icons/ads-wallet/visa.svg" alt="Visa" width={34} height={24} className="block h-6 w-[34px] shrink-0" />;
  }
  const short: Record<string, string> = { mastercard: "MC", amex: "AMEX", discover: "DISC", diners: "DINERS", jcb: "JCB", unionpay: "UPAY" };
  return <span className="inline-flex h-6 w-[34px] shrink-0 items-center justify-center rounded text-[8px] font-bold tracking-wide" style={{ background: "#ffffff", color: "#0e0f11", border: "1px solid #F5F5F5" }}>{short[brand] ?? brand.toUpperCase().slice(0, 4)}</span>;
}

export function FigmaCheckbox({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <span className="relative inline-flex size-6 shrink-0">
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    <svg aria-hidden width="24" height="24" viewBox="0 0 24 24" fill="none" className="pointer-events-none rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ink/30 peer-disabled:opacity-40">
      {checked
        ? <><rect x="1" y="1" width="22" height="22" rx="5" className="fill-rule" /><rect x="2" y="2" width="20" height="20" rx="4" className="fill-ink" /><path d="M6.5 12.5L10.25 16.25L17.5 8" className="stroke-cream" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" /></>
        : <rect x="3" y="3" width="18" height="18" rx="3" className="stroke-rule" strokeWidth="2" />}
    </svg>
  </span>;
}

export function CheckCard({ checked, onChange, disabled, children, detail }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: string; detail?: ReactNode }) {
  return <div className="flex flex-col gap-2 rounded-2xl border border-rule p-4">
    <label className="flex items-start gap-2 text-[14px] font-medium leading-5 tracking-[0.14px] text-ink">
      <FigmaCheckbox checked={checked} onChange={onChange} disabled={disabled} label={children} />
      <span className="pt-0.5">{children}</span>
    </label>
    {detail && <div className="rounded-xl bg-creamDeep p-3 text-[14px] font-medium leading-5 tracking-[0.14px] text-[#454545]">{detail}</div>}
  </div>;
}
