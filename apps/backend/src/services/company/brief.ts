
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { CompanyFacts } from "./facts";
import { getCompanyFacts } from "./facts";

const BRIEF_FACTS: Array<{ key: keyof CompanyFacts["facts"]; label: string }> = [
  { key: "what_we_sell", label: "What they sell" },
  { key: "who_we_serve", label: "Who they serve" },
  { key: "industry", label: "Industry" },
  { key: "markets", label: "Markets" },
  { key: "location", label: "Based in" },
  { key: "founded", label: "Founded" },
];

const SOCIALS: Array<{ key: keyof CompanyFacts["facts"]; label: string }> = [
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "instagram_url", label: "Instagram" },
  { key: "facebook_url", label: "Facebook" },
  { key: "x_url", label: "X" },
];

export function companyKeyFacts(record: CompanyFacts): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (record.website) out.push({ label: "Website", value: record.website });
  for (const { key, label } of BRIEF_FACTS) {
    const value = record.facts[key]?.value.trim();
    if (value) out.push({ label, value });
  }
  if (record.competitors.length > 0) {
    out.push({ label: "Competitors", value: record.competitors.join(", ") });
  }
  return out;
}

export function stripLeadingTitle(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)* {0,3}#[ \t]+[^\r\n]*(?:\r?\n+|$)/, "").trim();
}

export type CompanyProseWriter = "founder" | "staff" | "provisioning";

export type CompanyProseResult = {
  stored: boolean;
  reason: "written" | "empty" | "outranked" | "error";
  error: string | null;
};

export async function writeCompanyProse(
  tenant_id: string,
  prose: string,
  writer: CompanyProseWriter,
  source_ref: string,
): Promise<CompanyProseResult> {
  const text = (prose ?? "").trim();
  if (!text) return { stored: false, reason: "empty", error: null };
  try {
    const { setCompanyFact, projectCompanyFactValue } = await import("./facts");

    if (writer === "founder") {
      const { ok, error } = await setCompanyFact(tenant_id, "company_story", text, source_ref);
      return ok
        ? { stored: true, reason: "written", error: null }
        : { stored: false, reason: "error", error };
    }

    const source =
      writer === "staff" ? "staff_reviewed" : "ai_estimated";
    const written = await projectCompanyFactValue(
      tenant_id,
      "company_story",
      text,
      source,
      source_ref,
    );
    if (written.error) return { stored: false, reason: "error", error: written.error };
    return written.written
      ? { stored: true, reason: "written", error: null }
      : { stored: false, reason: "outranked", error: null };
  } catch (e) {
    const message = (e as Error).message;
    console.warn(`[company/brief] could not store company prose for ${tenant_id}: ${message}`);
    return { stored: false, reason: "error", error: message };
  }
}

export function companyFieldProvenance(
  record: CompanyFacts,
): Record<string, { source: string; verified_at: string | null }> {
  const out: Record<string, { source: string; verified_at: string | null }> = {};
  for (const [key, fact] of Object.entries(record.facts)) {
    if (!fact?.value?.trim()) continue;
    out[key] = { source: fact.source, verified_at: fact.verified_at ?? null };
  }
  return out;
}

export function renderCompanyBrief(record: CompanyFacts): string | null {
  const name = record.name?.trim();
  const story = stripLeadingTitle(record.facts.company_story?.value ?? "");
  const stated = BRIEF_FACTS.filter(({ key }) => record.facts[key]?.value.trim());
  const socials = SOCIALS.filter(({ key }) => record.facts[key]?.value.trim());
  if (
    !story &&
    stated.length === 0 &&
    socials.length === 0 &&
    !record.website &&
    record.competitors.length === 0
  ) {
    return null;
  }

  const lines: string[] = [];
  if (name) lines.push(`# ${name}`, "");
  if (story) lines.push(story, "");

  if (
    stated.length > 0 ||
    socials.length > 0 ||
    record.website ||
    record.competitors.length > 0
  ) {
    lines.push("## What they have told us", "");
    if (record.website) lines.push(`- **Website:** ${record.website}`);
    for (const { key, label } of stated) {
      lines.push(`- **${label}:** ${record.facts[key]!.value.trim()}`);
    }
    if (record.competitors.length > 0) {
      lines.push(`- **Competitors:** ${record.competitors.join(", ")}`);
    }
    for (const { key, label } of socials) {
      lines.push(`- **${label}:** ${record.facts[key]!.value.trim()}`);
    }
    lines.push("");
  }

  lines.push(
    "_This brief is generated from the company record. Correct anything wrong on the Company Details card and it updates here._",
  );
  return lines.join("\n").trim();
}

export async function regenerateCompanyBrief(tenant_id: string): Promise<boolean> {
  try {
    const record = await getCompanyFacts(tenant_id);
    const body = renderCompanyBrief(record);

    if (!body) {
      const sb = tenantClient(asTenantId(tenant_id));
      const { data: live } = await sb
        .from("memory_note")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("slug", "company")
        .is("superseded_by", null)
        .maybeSingle();
      const id = (live as { id?: string } | null)?.id;
      if (id) {
        await sb
          .from("memory_note")
          .update({ superseded_by: id, superseded_at: new Date().toISOString() })
          .eq("id", id);
      }
      return false;
    }
    await upsertAnchor(
      {
        tenant_id,
        slug: "company",
        title: "company.md",
        body_markdown: body,
        source: "agent_write",
        metadata: {
          key_facts: companyKeyFacts(record),
          derived_from: "company_record",
          rendered_at: new Date().toISOString(),
          field_provenance: companyFieldProvenance(record),
        },
      },
      { derivedFromCompanyRecord: true },
    );
    return true;
  } catch (e) {
    console.warn(
      `[company/brief] could not regenerate the brief for ${tenant_id}: ${(e as Error).message}`,
    );
    return false;
  }
}
