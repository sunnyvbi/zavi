"use client";

import { formatCents } from "./creatorMoney";
import type { CreatorJobReceipt } from "./creatorJobTypes";

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function CreatorReceipt({
  receipt,
  orderId,
  className = "",
}: {
  receipt: CreatorJobReceipt;
  orderId: string;
  className?: string;
}) {
  const c = receipt.currency;
  const net = receipt.business_total_cents - receipt.refunded_cents;
  const rows: [string, string][] = [
    ["Creator price", formatCents(receipt.price_cents, c)],
    ["Zavi fee", formatCents(receipt.business_fee_cents, c)],
    ["Charged to your card", formatCents(receipt.business_total_cents, c)],
  ];
  if (receipt.refunded_cents > 0) {
    rows.push(["Refunded", `-${formatCents(receipt.refunded_cents, c)}`]);
    rows.push(["You paid", formatCents(net, c)]);
  }

  return (
    <section aria-label="Receipt" className={`rounded-2xl border border-ink/[0.08] bg-cream p-4 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold text-ink">Receipt</p>
        <p className="text-[12px] text-inkMuted">
          Paid {day(receipt.paid_at)} · Job #{orderId.slice(0, 8)}
        </p>
      </div>
      <dl className="mt-3 space-y-1.5 text-[13px]">
        {rows.map(([label, value], i) => (
          <div
            key={label}
            className={`flex justify-between gap-3 ${i === 2 || label === "You paid" ? "font-semibold text-ink" : "text-inkMuted"}`}
          >
            <dt>{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {receipt.chargeback_status === "open" ? (
        <p className="mt-3 rounded-lg bg-warnBg px-3 py-2 text-[13px] text-warn">
          Your bank is disputing this charge. The creator&apos;s payout is on hold until it is decided.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-[13px]">
        {receipt.receipt_url ? (
          <a href={receipt.receipt_url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
            Stripe receipt
          </a>
        ) : null}
        <button type="button" onClick={() => window.print()} className="font-medium text-inkMuted underline underline-offset-2">
          Print
        </button>
      </div>
    </section>
  );
}
