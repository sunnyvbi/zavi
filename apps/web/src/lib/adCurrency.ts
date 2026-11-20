export function adCurrencySymbol(currency: unknown): string {
  const c = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (c === "INR") return "₹";
  if (c === "" || c === "USD") return "$";
  return `${c} `;
}
