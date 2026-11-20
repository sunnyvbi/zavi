
import { createHash } from "node:crypto";
import { getCompanyFacts } from "@/services/company/facts";
import { validateCustomBrands } from "@/services/competitor-intel/brands";
import { hostOf } from "./detect";

export type GeoBrandContext = {
  brand: string | null;
  owned_domains: string[];
  rivals: string[];
};

export async function loadBrandContext(tenantId: string): Promise<GeoBrandContext> {
  const facts = await getCompanyFacts(tenantId);
  const brand = facts.name?.trim() || null;
  const site = facts.website?.trim() ?? "";
  const host = site ? hostOf(/^https?:\/\//i.test(site) ? site : `https://${site}`) : null;
  const validated = validateCustomBrands(facts.competitors);
  const rivals = (validated.ok ? validated.brands : []).filter(
    (r) => !brand || r.toLowerCase() !== brand.toLowerCase(),
  );
  return { brand, owned_domains: host ? [host] : [], rivals };
}

export function setHash(values: readonly string[]): string {
  const canonical = [...new Set(values.map((v) => v.trim().toLowerCase()))].sort().join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
