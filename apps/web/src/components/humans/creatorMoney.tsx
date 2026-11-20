"use client";

export function formatCents(cents: number, currency = "usd"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const symbol = currency.toLowerCase() === "usd" ? "$" : `${currency.toUpperCase()} `;
  return `${sign}${symbol}${dollars.toLocaleString("en-US")}.${rest}`;
}

export type MoneyLines = {
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  business_fee_label: string;
};

export function CreatorMoneyLines({
  money,
  creatorName,
  emphasis = true,
}: {
  money: MoneyLines;
  creatorName?: string | null;
  emphasis?: boolean;
}) {
  const rows = [
    {
      k: creatorName ? `${creatorName}'s price` : "Creator's price",
      v: formatCents(money.price_cents, money.currency),
    },
    {
      k: `Zavi fee (${money.business_fee_label})`,
      v: formatCents(money.business_fee_cents, money.currency),
    },
  ];
  return (
    <dl className="text-[13px]">
      {rows.map((r) => (
        <div key={r.k} className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-inkMuted">{r.k}</dt>
          <dd className="tabular-nums text-ink">{r.v}</dd>
        </div>
      ))}
      <div
        className={`mt-1 flex items-baseline justify-between gap-4 border-t border-ink/[0.08] pt-2 ${
          emphasis ? "text-[14px] font-semibold" : ""
        }`}
      >
        <dt className="text-ink">Total charged to your card</dt>
        <dd className="tabular-nums text-ink">
          {formatCents(money.business_total_cents, money.currency)}
        </dd>
      </div>
    </dl>
  );
}
