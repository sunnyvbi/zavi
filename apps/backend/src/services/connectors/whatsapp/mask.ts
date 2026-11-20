
export function maskWaId(waId: string): string {
  const digits = String(waId ?? "").replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  const last4 = digits.slice(-4);
  if (digits.length === 11 && digits.startsWith("1")) return `+1 ••• ••• ${last4}`;
  return `••• ${last4}`;
}

export const HANDSET_NAME_MAX = 40;

const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function handsetDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > HANDSET_NAME_MAX
    ? `${cleaned.slice(0, HANDSET_NAME_MAX - 1).trimEnd()}…`
    : cleaned;
}
