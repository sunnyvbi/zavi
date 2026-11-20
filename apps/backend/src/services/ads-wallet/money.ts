export function decimalCents(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,9})?$/.test(value))
    throw new Error("Provider spend is unreadable");
  const [whole, fraction = ""] = value.split(".");
  const cents =
    BigInt(whole) * 100n +
    BigInt((fraction + "00").slice(0, 2)) +
    (/[1-9]/.test(fraction.slice(2)) ? 1n : 0n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Provider spend is too large");
  return Number(cents);
}
