
export const FULL_RATE_MONTHS = 2;
export const LAST_MONTH = 12;
export const PART_RATE = 0.3;
export const HOLD_DAYS = 30;
const DAY_MS = 86_400_000;
const AVG_MONTH_DAYS = 30.4375;

export type CommissionLine = {
  id: string;
  amountCents: number;
  proration: boolean;
  periodStart: Date;
  months: number;
};

export type CommissionEntry = {
  source_key: string;
  amount_cents: number;
  invoice_id: string;
  month_index: number;
  rate: number;
  base_cents: number;
  livemode: boolean;
  matures_at: string;
};

export function monthIndex(anchor: Date, at: Date): number {
  return Math.round((at.getTime() - anchor.getTime()) / DAY_MS / AVG_MONTH_DAYS) + 1;
}

export function rateForMonth(month: number): number {
  if (month < 1 || month > LAST_MONTH) return 0;
  return month <= FULL_RATE_MONTHS ? 1 : PART_RATE;
}

export function anchorFor(lines: CommissionLine[]): Date | null {
  const plan = lines.filter((l) => !l.proration && l.amountCents > 0);
  const pool = plan.length > 0 ? plan : lines.filter((l) => l.amountCents > 0);
  if (pool.length === 0) return null;
  return new Date(Math.min(...pool.map((l) => l.periodStart.getTime())));
}

export function cashShare(inv: { amountPaidCents: number; totalCents: number; taxCents: number }, linesCents: number): number {
  if (linesCents <= 0 || inv.totalCents <= 0 || inv.amountPaidCents <= 0) return 0;
  const taxShare = Math.min(1, Math.max(0, inv.taxCents / inv.totalCents));
  const cashExTax = inv.amountPaidCents * (1 - taxShare);
  return Math.min(1, cashExTax / linesCents);
}

export function commissionEntries(args: {
  invoiceId: string;
  lines: CommissionLine[];
  anchor: Date;
  share: number;
  livemode: boolean;
  paidAt: Date;
}): CommissionEntry[] {
  const matures_at = new Date(args.paidAt.getTime() + HOLD_DAYS * DAY_MS).toISOString();
  const out: CommissionEntry[] = [];
  for (const line of args.lines) {
    if (line.amountCents <= 0) continue;
    const paid = line.amountCents * args.share;
    const first = monthIndex(args.anchor, line.periodStart);
    if (line.proration) {
      if (first < 1 || first > LAST_MONTH) continue;
      const base = Math.floor(paid);
      const amount = Math.floor(paid * PART_RATE);
      if (amount > 0) {
        out.push({ source_key: `${args.invoiceId}:${line.id}:p`, amount_cents: amount, invoice_id: args.invoiceId, month_index: first, rate: PART_RATE, base_cents: base, livemode: args.livemode, matures_at });
      }
      continue;
    }
    const months = Math.max(1, Math.floor(line.months));
    const perMonth = paid / months;
    for (let k = 0; k < months; k++) {
      const m = first + k;
      const rate = rateForMonth(m);
      if (rate === 0) continue;
      const amount = Math.floor(perMonth * rate);
      if (amount <= 0) continue;
      out.push({ source_key: `${args.invoiceId}:${line.id}:${m}`, amount_cents: amount, invoice_id: args.invoiceId, month_index: m, rate, base_cents: Math.floor(perMonth), livemode: args.livemode, matures_at });
    }
  }
  return out;
}
