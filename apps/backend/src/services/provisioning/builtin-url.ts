
import {
  attachRenderCustomDomain,
  detachRenderCustomDomain,
} from "./render-custom-domain";
import { BUILTIN_HOST_IN_USE, ensureDnsCname, deleteDnsCname } from "./cloudflare-dns";
import { onrenderHostFromUrl } from "./domain";
import { CredentialNotConfigured } from "./github-repo";

export function builtinBaseDomain(): string {
  return process.env.PRAXIS_PRODUCT_DOMAIN ?? "zaviagent.com";
}

function builtinProxied(): boolean {
  return process.env.PRAXIS_BUILTIN_URL_PROXIED === "1";
}

export const PLATFORM_HOST_LABELS: readonly string[] = [
  "latest", "preview-dev", "api-latest", "api-staging", "api-dev",
  "admin-latest", "admin-staging", "admin-dev", "www-latest", "www-dev",
  "sites", "sites-auth",
];

export const RESERVED_LABELS = new Set([
  "www", "api", "app", "apps", "admin", "dashboard", "console", "portal",
  "mail", "email", "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "dns",
  "ftp", "vpn", "cdn", "assets", "static", "media", "img", "images",
  "status", "health", "help", "support", "docs", "doc", "blog", "news",
  "login", "logout", "auth", "oauth", "sso", "account", "accounts", "billing",
  "pay", "payments", "checkout", "stripe", "webhook", "webhooks",
  "staging", "stage", "dev", "test", "qa", "demo", "sandbox", "preview",
  "internal", "private", "secure", "root", "go", "link", "links", "zavi",
  "marketplaces", "solo", "growth", "saas", "startup", "inbox",
  ...PLATFORM_HOST_LABELS,
]);

export type BuiltinLabelValidation =
  | { ok: true; label: string }
  | { ok: false; reason: string };

export function validateBuiltinLabel(raw: unknown): BuiltinLabelValidation {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a URL." };
  const label = raw.trim().toLowerCase();
  if (!label) return { ok: false, reason: "Enter a URL." };
  if (label.length < 3) return { ok: false, reason: "Use at least 3 characters." };
  if (label.length > 63) return { ok: false, reason: "That's too long (max 63 characters)." };
  if (!/^[a-z0-9-]+$/.test(label)) {
    return { ok: false, reason: "Use lowercase letters, numbers, and hyphens only." };
  }
  if (label.startsWith("-") || label.endsWith("-") || label.includes("--")) {
    return { ok: false, reason: "Hyphens can't start, end, or repeat." };
  }
  if (RESERVED_LABELS.has(label)) {
    return { ok: false, reason: "That name is reserved — pick another." };
  }
  return { ok: true, label };
}

export function isBuiltinHostname(hostname: unknown, baseDomain: string = builtinBaseDomain()): boolean {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  const v = validateBuiltinLabel(label);
  return v.ok && v.label === label;
}

export type BuiltinSubdomainRef = {
  hostname: string;
  label: string;
  custom_domain_id: string | null;
  dns_record_id: string | null;
};

export async function setBuiltinSubdomain(
  serviceId: string,
  onrenderUrl: string | null,
  label: string,
): Promise<BuiltinSubdomainRef> {
  const hostname = `${label}.${builtinBaseDomain()}`;
  const onrenderHost = onrenderHostFromUrl(onrenderUrl);

  const attached = await attachRenderCustomDomain(serviceId, hostname);

  let dns_record_id: string | null = null;
  if (onrenderHost) {
    try {
      const dns = await ensureDnsCname(hostname, onrenderHost, {}, builtinProxied(), { onlyReplaceOnrender: true });
      dns_record_id = dns.record_id;
    } catch (e) {
      if ((e as Error).message === BUILTIN_HOST_IN_USE && !attached.already) {
        await detachRenderCustomDomain(serviceId, attached.custom_domain_id).catch((err) => {
          console.warn(`[builtin-url] detach after refused DNS failed for ${hostname}: ${(err as Error).message}`);
        });
      }
      throw e;
    }
  }

  return { hostname, label, custom_domain_id: attached.custom_domain_id, dns_record_id };
}

export async function clearBuiltinSubdomain(
  serviceId: string,
  ref: { hostname?: string | null; custom_domain_id?: string | null } | null,
): Promise<void> {
  if (!ref?.hostname) return;
  if (ref.custom_domain_id) {
    try {
      await detachRenderCustomDomain(serviceId, ref.custom_domain_id);
    } catch (e) {
      if (!(e instanceof CredentialNotConfigured)) throw e;
    }
  }
  await deleteDnsCname(ref.hostname, {}, { onlyOnrender: true });
}

const MAX_DEFAULT_LABEL = 40;

function tenantSuffix(tenantId: string): string {
  const hex = tenantId.replace(/-/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return hex.slice(0, 6) || "app";
}

export function slugifyBuiltinLabel(source: unknown): string {
  if (typeof source !== "string") return "";
  return source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_DEFAULT_LABEL)
    .replace(/-+$/g, "");
}

export function suffixedBuiltinLabel(label: string, tenantId: string): string {
  const suffix = tenantSuffix(tenantId);
  const base = slugifyBuiltinLabel(label).slice(0, 63 - suffix.length - 1).replace(/-+$/g, "");
  return `${base || "app"}-${suffix}`;
}

export function defaultBuiltinLabel(source: unknown, tenantId: string): string {
  const slug = slugifyBuiltinLabel(source);
  const direct = validateBuiltinLabel(slug);
  if (direct.ok) return direct.label;
  return suffixedBuiltinLabel(slug, tenantId);
}
