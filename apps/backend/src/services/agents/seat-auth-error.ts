
const PROVIDER_AUTH_RE =
  /\b(api error:\s*401|oauth (access )?token (has been |has |was |is )?(revoked|expired|invalid)|authentication_error|invalid x-api-key|organization has disabled claude subscription access|account does not have access to claude)\b/i;

export function isProviderAuthError(error: string | null): boolean {
  return error != null && PROVIDER_AUTH_RE.test(error);
}

const SEAT_DISABLED_NOTICE_MAX_LEN = 300;
const SEAT_ENTITLEMENT_RE =
  /organization has disabled claude subscription access|account does not have access to claude/i;
const SEAT_DISABLED_NOTICE_RE =
  /^your (organization has disabled claude subscription access|account does not have access to claude)\b/i;

export function isSeatEntitlementError(text: string | null | undefined): boolean {
  return text != null && SEAT_ENTITLEMENT_RE.test(text);
}

export function isProviderSeatDisabledNotice(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > SEAT_DISABLED_NOTICE_MAX_LEN) return false;
  return SEAT_DISABLED_NOTICE_RE.test(t);
}

export function isOurSeatAuthError(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return isProviderSeatDisabledNotice(raw) || (isProviderAuthError(raw) && /claude code/i.test(raw));
}
