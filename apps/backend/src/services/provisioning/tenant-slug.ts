
import { createHash } from "node:crypto";

export function baseSlug(name: string, maxLen: number): string {
  return (
    (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen)
      .replace(/-+$/g, "") || "company"
  );
}

export function tenantSuffix(tenant_id: string): string {
  return createHash("sha256")
    .update(String(tenant_id ?? ""))
    .digest("hex")
    .slice(0, 8);
}

export function tenantScopedSlug(company_name: string, tenant_id: string, maxLen: number): string {
  return `${baseSlug(company_name, maxLen)}-${tenantSuffix(tenant_id)}`;
}

export const RESERVED_COMPANY_SLUGS: ReadonlySet<string> = new Set([
  "praxis",
  "thepraxis",
  "praxisai",
  "api",
  "admin",
  "www",
  "app",
  "apps",
  "staging",
  "stage",
  "prod",
  "production",
  "dev",
  "test",
  "demo",
  "internal",
  "system",
  "root",
  "host",
  "hosting",
  "mail",
  "email",
  "smtp",
  "support",
  "help",
  "noreply",
  "no-reply",
  "postmaster",
  "abuse",
  "security",
  "billing",
  "auth",
  "login",
  "account",
  "accounts",
  "status",
  "console",
  "dashboard",
  "company",
]);

export type CompanyNameRejection =
  | "empty"
  | "control_chars"
  | "path_traversal"
  | "slug_empty"
  | "reserved";

export function validateCompanyName(rawName: string): CompanyNameRejection | null {
  const raw = rawName ?? "";
  const name = raw.trim();
  if (!name) return "empty";

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(raw)) return "control_chars";

  if (name.includes("/") || name.includes("\\")) return "path_traversal";
  if (name.includes("..")) return "path_traversal";

  if (!/[a-z0-9]/i.test(name)) return "slug_empty";

  const slug = baseSlug(name, 200);
  const compact = slug.replace(/-/g, "");
  if (RESERVED_COMPANY_SLUGS.has(slug) || RESERVED_COMPANY_SLUGS.has(compact)) {
    return "reserved";
  }

  return null;
}
