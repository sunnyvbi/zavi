export function currencyFromUnit(unit: string | null | undefined): string | null {
  return /^currency:([A-Z]{3})$/.exec(unit ?? "")?.[1] ?? null;
}

export function formatCurrency(value: number | null | undefined, currency: string | null | undefined, cents = false): string {
  if (value == null || !Number.isFinite(value) || !currency || !/^[A-Z]{3}$/.test(currency)) return "-";
  const amount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(value);
  return currency === "USD" ? `$${amount}` : `${currency} ${amount}`;
}
