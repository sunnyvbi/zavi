
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { getCaptureLedger } from "@/services/agents/engine/capture-ledger";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { MEMORY_SLUGS, type MemoryDocSlug } from "@/services/memory/loader";
import { ExpectedToolError } from "../types";
import type { ToolSpec } from "../types";

export const DISCOVERY_AGENT_SLUG = "onboarding-discovery";

export const DISCOVERY_OWNED_SOURCES = ["agent_discovery_verified", "agent_discovery_inferred"];

const MIN_INDEPENDENT_DOMAINS = 2;

const MAX_BODY_CHARS = 8000;
const MAX_TITLE_CHARS = 200;
const MAX_SOURCES = 12;
const MAX_URL_CHARS = 2048;
const MAX_NOTE_CHARS = 500;

const inputSchema = z.object({
  slug: z
    .enum(MEMORY_SLUGS as unknown as [MemoryDocSlug, ...MemoryDocSlug[]])
    .describe("Which canonical brain anchor this finding belongs to."),
  body_markdown: z
    .string()
    .min(1)
    .max(MAX_BODY_CHARS)
    .describe("The anchor content, in markdown. Write only what your sources actually support."),
  sources: z
    .array(
      z.object({
        url: z.string().url().max(MAX_URL_CHARS).describe("The https URL you actually read."),
        note: z.string().max(MAX_NOTE_CHARS).optional().describe("What this source establishes."),
      }),
    )
    .min(1)
    .max(MAX_SOURCES)
    .describe(
      "The evidence. EVERY factual claim in the body must be supported by one of these. " +
        "The server decides how much they are worth — it checks them against the tenant's own " +
        "registered domain. Two pages on one site are ONE source.",
    ),
  title: z.string().max(MAX_TITLE_CHARS).optional(),
});

type WriteAnchorInput = z.infer<typeof inputSchema>;

export type WriteAnchorOutput = {
  written: "draft";
  slug: string;
  note_id: string;
  confidence: "high" | "low";
  reason: string;
};

export function hostOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

export function isOwnHost(host: string, ownHosts: ReadonlySet<string>): boolean {
  for (const own of ownHosts) {
    if (host === own || host.endsWith(`.${own}`)) return true;
  }
  return false;
}

export function independenceKey(host: string): string {
  const labels = host.split(".");
  return labels.length < 2 ? host : labels.slice(-2).join(".");
}

const ZAVI_GENERATED_HOST_SUFFIXES = [
  "onrender.com",
  "thepraxis.ai",
  "zaviagent.com",
] as const;

export function isZaviGeneratedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return ZAVI_GENERATED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

async function tenantOwnHosts(tenant_id: string): Promise<Set<string>> {
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("product_url")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`tenant product_url read failed: ${error.message}`);
  const productUrl = (data as { product_url?: Record<string, string> | null } | null)?.product_url;
  const out = new Set<string>();
  for (const v of Object.values(productUrl ?? {})) {
    if (typeof v !== "string") continue;
    const h = hostOf(v);
    if (h) out.add(h);
  }
  return out;
}

export const discoveryWriteAnchorTool: ToolSpec = {
  name: "onboarding_discovery_write_anchor",
  effect: "write",
  description:
    "Write a brain anchor from onboarding discovery. Supply the anchor body AND the source URLs you actually read. " +
    "The SERVER decides whether your finding is VERIFIED (auto-applied to the real anchor) or held as an unverified " +
    "DRAFT — it checks your sources against the tenant's own registered domain itself. You cannot assert that the " +
    "tenant's site corroborates you; only the sources you cite count. An anchor written by a human (or confirmed by " +
    "one) is never overwritten — your finding becomes a draft and the disagreement is reported.",
  input_schema: inputSchema,

  async execute(ctx, input: unknown): Promise<WriteAnchorOutput> {
    const args: WriteAnchorInput = inputSchema.parse(input);

    if (ctx.agent_slug !== DISCOVERY_AGENT_SLUG) {
      throw new ExpectedToolError(
        "discovery_write_anchor_denied",
        `Only the ${DISCOVERY_AGENT_SLUG} agent may write discovery anchors.`,
      );
    }

    const httpsSources = args.sources.filter((s) => hostOf(s.url) !== null);
    if (httpsSources.length === 0) {
      throw new ExpectedToolError(
        "discovery_write_anchor_no_evidence",
        "At least one https:// source URL is required. Write only what you can cite.",
      );
    }

    const ownHosts = await tenantOwnHosts(ctx.tenant_id);
    const captures = ctx.run_id ? getCaptureLedger(ctx.run_id) : [];
    const fetchedHosts = new Set<string>();
    for (const c of captures) {
      const h = hostOf(c.final_url) ?? hostOf(c.requested_url);
      if (h) fetchedHosts.add(h);
    }
    const ownHostsAreAllZaviGenerated =
      ownHosts.size > 0 && [...ownHosts].every((h) => isZaviGeneratedHost(h));

    const domainCorroborated =
      !ownHostsAreAllZaviGenerated && [...fetchedHosts].some((h) => isOwnHost(h, ownHosts));
    const independentDomains = new Set([...fetchedHosts].map(independenceKey)).size;

    let verified = domainCorroborated && independentDomains >= MIN_INDEPENDENT_DOMAINS;
    let reason = verified
      ? `verified: this run actually fetched the tenant's own site + ${independentDomains} independent domains`
      : !ownHosts.size
        ? "inferred: tenant has no registered product domain to corroborate against"
        : ownHostsAreAllZaviGenerated
          ? "inferred: this tenant's only site is one Zavi built and deployed — corroborating against it would be grading our own homework"
          : !domainCorroborated
            ? "inferred: this run never actually fetched the tenant's own site (citing it is not reading it)"
            : `inferred: only ${independentDomains} independently-fetched domain(s), need ${MIN_INDEPENDENT_DOMAINS}`;

    const metadata = {
      discovery: {
        confidence: verified ? "verified" : "inferred",
        domain_corroborated: domainCorroborated,
        independent_domains: independentDomains,
        fetched_hosts: [...fetchedHosts],
        cited_sources: httpsSources.map((s) => ({ url: s.url, note: s.note ?? null })),
        run_id: ctx.run_id ?? null,
        agent_slug: ctx.agent_slug,
        discovered_at: new Date().toISOString(),
      },
    };

    (metadata.discovery as Record<string, unknown>).auto_apply = false;
    (metadata.discovery as Record<string, unknown>).promote_hint = verified
      ? "high-confidence: the run fetched the tenant's own site and >=2 independent domains — safe to promote after a glance"
      : "low-confidence: needs review";
    if (verified) {
      reason = `${reason} — held as a DRAFT for human promotion (discovery never auto-applies)`;
    }

    const draftSlug = `${args.slug}__inferred` as const;
    const draft = await upsertAnchor(
      {
        tenant_id: ctx.tenant_id,
        slug: draftSlug,
        title: `${args.slug} (unverified discovery draft)`,
        body_markdown: args.body_markdown,
        source: "agent_discovery_inferred",
        metadata,
      },
      { skipEmbedding: true },
    );
    ctx.log?.("wrote discovery draft", {
      slug: draftSlug,
      note_id: draft.note_id,
      confidence: verified ? "high" : "low",
      reason,
    });
    return {
      written: "draft",
      slug: draftSlug,
      note_id: draft.note_id,
      confidence: verified ? "high" : "low",
      reason,
    };
  },
};
