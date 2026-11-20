
import { randomUUID } from "node:crypto";
import type { McpCallResult } from "@/services/mcp/types";
import { labCaseActive } from "./lab-read-cache";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

export const LAB_SIMULATED_TOOLS: ReadonlySet<string> = new Set([
  "report__render_social_image",
  "growth__propose_creative_brief",
]);

export function isLabSimulatedTool(server_id: string, tool_name: string): boolean {
  return labCaseActive() && LAB_SIMULATED_TOOLS.has(`${server_id}__${tool_name}`);
}

export const CREATIVE_UNGROUNDED_MESSAGE =
  "You are about to generate creative having read NOTHING this run, so every word on it would come from memory. Read what is already running first, using WHICHEVER of these you hold: `meta_ads__list_ads` (include_creative:true) for the advertiser's own live ads with their ctr; `apify__scrape_meta_ads` for what competitors are running in the Meta Ad Library — it needs NO connector, and its `page_url` reads the customer's own Facebook Page when Meta is not connected; otherwise `web_search__search`, or whatever read this channel already has. Then call this again. A second call goes through even if those reads came back empty or the connector was missing; if that happens, say in your reply that the creative is ungrounded and which read failed.";

const seen = new Map<string, { reads: number; renders: number }>();
const stateOf = (run_id: string) => {
  let s = seen.get(run_id);
  if (!s) {
    if (seen.size > 500) seen.delete(seen.keys().next().value as string);
    s = { reads: 0, renders: 0 };
    seen.set(run_id, s);
  }
  return s;
};

export function noteLabToolCall(run_id: string | undefined, server_id: string, tool_name: string): void {
  if (!run_id || !labCaseActive()) return;
  if (server_id !== "report") stateOf(run_id).reads++;
  void tool_name;
}

const ok = (content: unknown): McpCallResult => ({ ok: true, is_error: false, content: JSON.stringify(content), ms: 1 });
const fail = (error: string, message: string): McpCallResult => ({
  ok: false,
  is_error: true,
  content: JSON.stringify({ error, message }),
  ms: 1,
});

export type LabSimulateDeps = {
  brand?: (tenant_id: string) => Promise<{ primary: string; accent: string | null; source: string; source_url: string | null; evidence: unknown[] } | null>;
  uuid?: () => string;
};

type LabBrand = { primary: string; accent: string | null; source: string; source_url: string | null; evidence: unknown[] };
const DEFAULT_BRAND: LabBrand = { primary: "#111111", accent: null, source: "default", source_url: null, evidence: [] };

async function savedBrandKit(tenantId: string): Promise<LabBrand | null> {
  const { tenantClient, asTenantId } = await import("@/services/tenant-client");
  const { data } = await tenantClient(asTenantId(tenantId))
    .from("tenant_brand_kits")
    .select("primary_hex,accent_hex,source,source_url,evidence")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.primary_hex !== "string") return null;
  return {
    primary: row.primary_hex,
    accent: typeof row.accent_hex === "string" ? row.accent_hex : null,
    source: typeof row.source === "string" ? row.source : "scrape",
    source_url: typeof row.source_url === "string" ? row.source_url : null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  };
}

export async function labSimulatedCall(
  ctx: { run_id?: string; tenant_id: string },
  server_id: string,
  tool_name: string,
  args: unknown,
  deps: LabSimulateDeps = {},
): Promise<McpCallResult | null> {
  if (!isLabSimulatedTool(server_id, tool_name)) return null;

  if (server_id === "report" && tool_name === "render_social_image") {
    const { renderSocialImageInputSchema } = await import("@/services/reports/deliver-social-image");
    const parsed = renderSocialImageInputSchema.safeParse(args);
    if (!parsed.success) return fail("invalid_input", parsed.error.issues.map((i) => i.message).join("; "));
    const s = stateOf(ctx.run_id ?? "none");
    s.renders++;
    if (s.reads === 0 && s.renders < 2) return fail("creative_ungrounded", CREATIVE_UNGROUNDED_MESSAGE);

    const input = parsed.data as {
      posts?: Array<{ layout?: string; plate_prompt?: string | null }>;
      panels?: Array<{ layout?: string; plate_prompt?: string | null }>;
      carousel_layout?: string;
    };
    const carousel = Array.isArray(input.panels);
    const items = (carousel ? input.panels : input.posts) ?? [];
    const uuid = deps.uuid ?? randomUUID;
    const images = items.map((it, i) => ({
      artifact_id: `lab-image-${i + 1}`,
      filename: `social-${i + 1}-${it.layout ?? (carousel ? (input.carousel_layout ?? "dark") : "block")}.png`,
      bytes: 0,
      cached: false,
      image_path: `${ctx.tenant_id}/${uuid()}.jpg`,
    }));
    const photographed = items.filter((it) => typeof it.plate_prompt === "string" && it.plate_prompt.trim()).length;
    let brand: LabBrand = DEFAULT_BRAND;
    try {
      const kit = await (deps.brand ?? savedBrandKit)(ctx.tenant_id);
      if (kit) brand = { primary: kit.primary, accent: kit.accent ?? null, source: kit.source, source_url: kit.source_url ?? null, evidence: kit.evidence ?? [] };
    } catch {
    }
    return ok({
      mode: carousel ? "carousel" : "options",
      images,
      generated: photographed,
      cached: 0,
      typeset: images.length - photographed,
      skipped: [],
      slack_ok: false,
      brand,
      brand_verified: images.map((im) => ({ filename: im.filename, hexes: brand.source === "default" ? [] : [brand.primary] })),
      lab_simulated: true,
    });
  }

  if (server_id === "growth" && tool_name === "propose_creative_brief") {
    const { proposeCreativeBriefInputSchema } = await import("@/services/tools/growth/propose_creative_brief");
    const parsed = proposeCreativeBriefInputSchema.safeParse(args);
    if (!parsed.success) return fail("tool_input_invalid", parsed.error.message);
    const title = String((parsed.data as { title?: unknown }).title ?? "Creative brief").trim();
    const utm = `lab_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "brief"}`;
    return ok({
      brief_id: "lab-brief",
      utm_campaign: utm,
      status: "draft",
      title,
      next_step: CREATOR_MARKETPLACE_ENABLED
        ? `This draft is now the card "Post this brief to Zavi creators: ${title}" on the UGC page, where the founder edits and posts it. Do not write a step for posting it. The delivered video carries utm_campaign=${utm}, which is how its result is separated later.`
        : `Assign this brief to the merchant's own team or an existing production partner. Zavi does not source or book outside creators. The delivered video carries utm_campaign=${utm}, which is how its result is separated later.`,
      lab_simulated: true,
    });
  }
  return null;
}
