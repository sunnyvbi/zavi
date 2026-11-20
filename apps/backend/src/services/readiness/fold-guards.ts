
export interface TenantIdentity {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  company_shape: string | null;
  product_host: string | null;
}

export type TenantFactVerdict =
  | { clean: true }
  | { clean: false; matched: string; token: string };

const STOPWORDS = new Set([
  "the", "and", "app", "inc", "llc", "ltd", "co", "corp", "company", "group", "labs",
  "ai", "io", "com", "net", "org", "test", "demo", "team", "tech", "hq", "shop", "store",
]);

function identityTokens(t: TenantIdentity): string[] {
  const out: string[] = [];

  const add = (raw: string | null) => {
    if (!raw) return;
    const s = raw.trim().toLowerCase();
    if (!s) return;

    const parts = s
      .split(/[\s._\-/]+/)
      .map((p) => p.replace(/\.(com|io|ai|co|net|org)$/, ""))
      .filter((p) => p.length >= 4 && !STOPWORDS.has(p));

    if (s.length >= 4 && !STOPWORDS.has(s) && parts.length > 0) out.push(s);

    out.push(...parts);
  };

  add(t.slug);
  add(t.display_name);
  add(t.product_host);
  return [...new Set(out)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkTenantFacts(
  patternSummary: string,
  sources: TenantIdentity[],
): TenantFactVerdict {
  const text = (patternSummary ?? "").toLowerCase().trim();
  if (!text) return { clean: false, matched: "(empty)", token: "(empty)" };

  for (const t of sources) {
    for (const token of identityTokens(t)) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(token)}([^a-z0-9]|$)`, "i");
      if (re.test(text)) {
        return { clean: false, matched: t.slug, token };
      }
    }
  }
  return { clean: true };
}

export interface ConflictVerdict {
  conflict: boolean;
  detail: string | null;
}

export function checkConflictOfInterest(sources: TenantIdentity[]): ConflictVerdict {
  const byShape = new Map<string, string[]>();
  for (const t of sources) {
    const shape = t.company_shape?.trim();
    if (!shape) continue;
    const list = byShape.get(shape) ?? [];
    list.push(t.slug);
    byShape.set(shape, list);
  }

  for (const [shape, slugs] of byShape) {
    if (slugs.length >= 2) {
      return {
        conflict: true,
        detail:
          `Derived from ${slugs.length} tenants that share company_shape='${shape}' ` +
          `(${slugs.join(", ")}). They may be direct competitors — a lesson learned from ` +
          `one must not become fleet behavior that advantages another. A human must clear this.`,
      };
    }
  }

  return { conflict: false, detail: null };
}

export const MIN_SOURCE_TENANTS = 2;

export function hasEnoughSources(sources: TenantIdentity[]): boolean {
  return new Set(sources.map((s) => s.tenant_id)).size >= MIN_SOURCE_TENANTS;
}
