
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = invoice as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  } | null;
  const ref = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  const id = typeof ref === "string" ? ref : ref?.id ?? null;
  return id || null;
}
