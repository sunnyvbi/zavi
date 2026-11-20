
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export type MaterializeInvestor = {
  firm?: string | null;
  name?: string | null;
  email?: string | null;
  suggested_message?: string | null;
  focus?: string | null;
  fit_rationale?: string | null;
  source?: string | null;
  source_url?: string | null;
  [k: string]: unknown;
};

const FIRM_SUFFIX_TOKENS = new Set([
  "ventures",
  "capital",
  "partners",
  "vc",
  "llc",
  "lp",
  "inc",
  "fund",
]);

export function canonicalFirm(firm: string): string {
  const cleaned = (firm ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(" ");
  while (tokens.length > 0 && FIRM_SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

export function normalizeName(name: string): string {
  return (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function identityKey(firm: string, name: string): string {
  return `${canonicalFirm(firm)}|${normalizeName(name)}`;
}

function isNamelessKey(key: string): boolean {
  return key.endsWith("|") && key.length > 1;
}

export type MaterializeSummary = {
  added: number;
  already_saved: number;
};

type Baseline = {
  emails: ReadonlySet<string>;
  identityKeys: ReadonlySet<string>;
};

function baselineToken(email: string | null, idKey: string): string {
  return email ? `e:${email.toLowerCase()}` : `k:${idKey}`;
}

async function readBaseline(
  sb: Sb,
  tenantId: string,
): Promise<Baseline | null> {
  try {
    const { data, error } = await sb
      .from("fundraising_investor")
      .select("identity_key, normalized_email")
      .eq("tenant_id", tenantId);
    if (error || !Array.isArray(data)) return null;
    const emails = new Set<string>();
    const identityKeys = new Set<string>();
    for (const raw of data as Array<Record<string, unknown>>) {
      const e = raw?.normalized_email;
      const hasEmail = typeof e === "string" && e.trim().length > 0;
      if (hasEmail) emails.add((e as string).trim().toLowerCase());
      const k = raw?.identity_key;
      if (!hasEmail && typeof k === "string" && k.length > 0) identityKeys.add(k);
    }
    return { emails, identityKeys };
  } catch {
    return null;
  }
}

export async function materializeInvestors(
  tenantId: string,
  investors: MaterializeInvestor[],
  sb: Sb = serviceClient(),
  frozenIdentityKeys?: ReadonlyMap<MaterializeInvestor, string>,
): Promise<MaterializeSummary | null> {
  if (!tenantId) {
    console.warn(
      "[fundraising materialize] missing tenantId — skipping materialize",
    );
    return null;
  }

  const baseline = await readBaseline(sb, tenantId);
  let added = 0;
  let alreadySaved = 0;
  const countedTokens = new Set<string>();

  let ok = 0;
  let failed = 0;
  const namelessKeysWritten = new Set<string>();
  let namelessCollisionsSkipped = 0;
  for (const inv of investors) {
    const firm = (inv.firm ?? "").toString();
    const name = (inv.name ?? "").toString();
    const emailRaw = (inv.email ?? "").toString().trim();
    const email = emailRaw.length > 0 ? emailRaw : null;
    const idKey = frozenIdentityKeys?.get(inv) ?? identityKey(firm, name);
    if (idKey === "|" && !email) {
      continue;
    }
    if (isNamelessKey(idKey) && !email) {
      if (namelessKeysWritten.has(idKey)) {
        namelessCollisionsSkipped += 1;
        continue;
      }
      namelessKeysWritten.add(idKey);
    }
    try {
      const { error } = await sb.rpc("fundraising_upsert_investor", {
        p_tenant_id: tenantId,
        p_firm: firm,
        p_name: name,
        p_email: email,
        p_source: (inv.source ?? "fundraising_agent").toString(),
        p_notes:
          ((inv.fit_rationale ?? inv.focus ?? "") as string)
            .toString()
            .slice(0, 2000) || null,
        p_draft_subject: null,
        p_draft_body:
          ((inv.suggested_message ?? "") as string).toString().slice(0, 8000) ||
          null,
        p_identity_key: idKey,
      });
      if (error) {
        failed += 1;
        console.warn(
          `[fundraising materialize] upsert RPC error (continuing): ${error.message}`,
        );
        continue;
      }
      ok += 1;
      if (baseline) {
        const token = baselineToken(email, idKey);
        if (!countedTokens.has(token)) {
          countedTokens.add(token);
          const existed = email
            ? baseline.emails.has(email.toLowerCase())
            : baseline.identityKeys.has(idKey);
          if (existed) alreadySaved += 1;
          else added += 1;
        }
      }
    } catch (e) {
      failed += 1;
      console.warn(
        `[fundraising materialize] upsert threw (continuing): ${(e as Error).message}`,
      );
    }
  }

  console.log(
    `[fundraising materialize] materialized ${ok}/${investors.length} investors ` +
      `(failed=${failed} nameless_key_collisions_skipped=${namelessCollisionsSkipped} ` +
      `added=${baseline ? added : "?"} already_saved=${baseline ? alreadySaved : "?"})`,
  );

  if (failed > 0) return null;
  return baseline ? { added, already_saved: alreadySaved } : null;
}
