const at = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

export function linkedinPausePending(stopRequestedAt: unknown, stopConfirmedAt: unknown, lastActivateMs: number | null): boolean {
  const requested = at(stopRequestedAt);
  if (requested === null) return false;
  const confirmed = at(stopConfirmedAt);
  return (confirmed === null || confirmed < requested) && !(lastActivateMs !== null && lastActivateMs > requested);
}

export function linkedinStopStands(stopRequestedAt: unknown, stopConfirmedAt: unknown, lastActivateMs: number | null): boolean {
  const requested = at(stopRequestedAt);
  const confirmed = at(stopConfirmedAt);
  return requested !== null && confirmed !== null && confirmed >= requested && !(lastActivateMs !== null && lastActivateMs > requested);
}
