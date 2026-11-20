export type ConnectField = { key: string; label: string; placeholder: string; hint: string };

const FIELDS: Readonly<Record<string, ConnectField>> = {
  shopify: {
    key: "subdomain",
    label: "Store name",
    placeholder: "acme",
    hint: "The 'acme' in acme.myshopify.com. Find it under Settings → Domains in Shopify.",
  },
};

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function connectFieldFor(toolkit: string): ConnectField | null {
  return FIELDS[toolkit.toLowerCase()] ?? null;
}

export function normalizeShopSubdomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.myshopify\.com$/, "");
  return SUBDOMAIN_RE.test(v) ? v : null;
}

export type ConnectionDataResult =
  | { ok: true; data: Record<string, string> | undefined; shop?: string }
  | { ok: false; field: ConnectField };

export function connectionDataFor(toolkit: string, body: unknown): ConnectionDataResult {
  const field = connectFieldFor(toolkit);
  if (!field) return { ok: true, data: undefined };
  const b = body as { connection_data?: Record<string, unknown> } | null;
  const value = normalizeShopSubdomain(b?.connection_data?.[field.key]);
  if (!value) return { ok: false, field };
  return { ok: true, data: { [field.key]: value } };
}
