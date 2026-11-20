
import { maskWaId } from "@/services/connectors/whatsapp/mask";

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export function normalizeHandle(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  if (s.includes("@")) {
    const email = s.toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
  }
  const phone = `+${s.replace(/\D/g, "")}`;
  return E164_RE.test(phone) ? phone : null;
}

export function maskHandle(handle: string): string {
  const at = handle.indexOf("@");
  if (at > 0) return `${handle[0]}•••${handle.slice(at)}`;
  return maskWaId(handle);
}
