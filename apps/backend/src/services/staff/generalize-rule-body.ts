
export type TenantIdentifiers = {
  tenant_id: string;
  name?: string | null;
  slug?: string | null;
  source_refs?: string[];
};

export type GeneralizeResult = {
  generalized: string;
  ok: boolean;
  surviving: string[];
};

const REDACTION = "[tenant]";

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierTokens(ids: TenantIdentifiers): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t.length >= 3) out.add(t);
  };
  add(ids.tenant_id);
  add(ids.name);
  add(ids.slug);
  for (const r of ids.source_refs ?? []) add(r);
  return Array.from(out);
}

export function generalizeRuleBody(
  body: string,
  ids: TenantIdentifiers,
): GeneralizeResult {
  const tokens = identifierTokens(ids);
  let scrubbed = body ?? "";
  for (const tok of tokens) {
    const re = new RegExp(reEscape(tok), "gi");
    scrubbed = scrubbed.replace(re, REDACTION);
  }

  const surviving: string[] = [];
  for (const tok of tokens) {
    const re = new RegExp(reEscape(tok), "i");
    if (re.test(scrubbed)) surviving.push(tok);
  }

  return { generalized: scrubbed, ok: surviving.length === 0, surviving };
}
