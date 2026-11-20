import { CHANNELS, CONNECTOR_FREE_TOOLS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { enqueueAgentRun } from "@/services/agents/runner";
import { runChannelRecipe } from "@/services/channels/engine";
import { defaultChannelContext } from "@/services/channels/context";
import { seoSnapshotShowsReadableSite } from "@/services/tools/growth/seo/snapshot";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { createTierGate } from "@/services/agents/entitlement";
import { isTierGatedChannel, PREVIEW_RUN_KEY_PREFIX, previewRunKey } from "@/services/billing/tiers";
import { isChannelLocked } from "@/services/channels/lock";

export const AUTO_SERVE_TENANTS_CREATED_AFTER = "2026-09-22T00:00:00.000Z";

export async function siteWasRead(tenant_id: string): Promise<boolean> {
  return seoSnapshotShowsReadableSite(tenant_id);
}

const CONNECTOR_FREE = new Set<string>(
  CONNECTOR_FREE_TOOLS as readonly string[],
);

export function runsOnPublicEvidence(slug: string): boolean {
  const ch = CHANNELS.find((c) => c.slug === slug);
  if (!ch) return false;
  return ch.tools.some((t) => CONNECTOR_FREE.has(t));
}

export type FirstRunBet = { channel_slug: string };

export function pickFirstRun(bets: readonly FirstRunBet[]): string | null {
  const ordered = bets.map((b) => b.channel_slug).filter(Boolean);
  if (ordered.length === 0) return null;
  return (
    ordered.find((slug) => runsOnPublicEvidence(slug)) ?? ordered[0] ?? null
  );
}

async function tenantIsNew(tenant_id: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenants")
      .select("created_at")
      .limit(1);
    if (error || !data || data.length === 0) return false;
    const created = (data[0] as { created_at?: unknown }).created_at;
    return (
      typeof created === "string" && created >= AUTO_SERVE_TENANTS_CREATED_AFTER
    );
  } catch {
    return false;
  }
}

export function firstRunKey(tenant_id: string): string {
  return `first-run:${tenant_id}`;
}

async function hasEverRunAChannel(tenant_id: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id")
      .or("trigger.eq.channel_recipe,channel_slug.not.is.null")
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  } catch {
    return true;
  }
}

export async function fanOutFirstRun(
  tenant_id: string,
  bets: readonly FirstRunBet[],
): Promise<
  | { ran: false; reason: string }
  | { ran: true; channel_slug: string; preview_slugs?: string[] }
> {
  try {
    if (!(await tenantIsNew(tenant_id)))
      return { ran: false, reason: "tenant_not_new" };

    const previewSlugs = pickPreviewSlugs(await previewCandidates(tenant_id), bets);
    if (previewSlugs.length > 0) {
      if (!(await siteWasRead(tenant_id)))
        return { ran: false, reason: "site_not_read" };
      const started = await fanOutPreviewRuns(tenant_id, previewSlugs);
      return started.length > 0
        ? { ran: true, channel_slug: started[0]!, preview_slugs: started }
        : { ran: false, reason: "preview_not_started" };
    }
    if (await hasEverRunAChannel(tenant_id))
      return { ran: false, reason: "already_ran" };

    const slug = pickFirstRun(bets);
    if (!slug) return { ran: false, reason: "no_bets" };

    if (!(await siteWasRead(tenant_id)))
      return { ran: false, reason: "site_not_read" };

    const key = firstRunKey(tenant_id);
    const result = await runChannelRecipe(
      tenant_id,
      slug,
      {
        channelContext: defaultChannelContext,
        enqueue: async (input) =>
          enqueueAgentRun({
            agent_slug: input.slug,
            tenant_id: input.tenant_id,
            trigger: "channel_recipe",
            payload: input.payload,
            cron_dedupe_key: key,
          }),
      },
      undefined,
      undefined,
      key,
    );

    if (!result.ok) {
      return { ran: false, reason: result.reason };
    }
    return { ran: true, channel_slug: slug };
  } catch {
    return { ran: false, reason: "threw" };
  }
}

export async function previewCandidates(tenant_id: string): Promise<string[]> {
  const gate = createTierGate();
  const out: string[] = [];
  for (const ch of CHANNELS) {
    if (!isTierGatedChannel(ch.slug)) continue;
    if ((ch as { plan_only?: boolean }).plan_only) continue;
    if (RETIRED_CHANNEL_SLUGS.has(ch.slug)) continue;
    try {
      if (await isChannelLocked(ch.slug)) continue;
      const d = await gate.decide(tenant_id, ch.slug);
      if (!d.allowed && d.required_tier === "starter") out.push(ch.slug);
    } catch {
      return [];
    }
  }
  return out;
}

export const PREVIEW_AT_SIGNUP = 2;

export function pickPreviewSlugs(
  candidates: readonly string[],
  bets: readonly FirstRunBet[],
  n: number = PREVIEW_AT_SIGNUP,
): string[] {
  const can = new Set(candidates);
  const planned = bets.map((b) => b.channel_slug).filter((s) => can.has(s));
  return [...new Set([...planned, ...candidates])].slice(0, n);
}

export async function startPreviewOnOpen(
  tenant_id: string,
  slug: string,
): Promise<{ started: boolean; reason: string }> {
  try {
    if (!(await tenantIsNew(tenant_id))) return { started: false, reason: "tenant_not_new" };
    if (!(await previewCandidates(tenant_id)).includes(slug)) return { started: false, reason: "not_previewable" };
    if (await previewEverStarted(tenant_id, slug)) return { started: false, reason: "already_previewed" };
    if (!(await siteWasRead(tenant_id))) return { started: false, reason: "site_not_read" };
    const r = await startPreviewRun(tenant_id, slug);
    if (!r.started) return { started: false, reason: r.reason };
    if (r.duplicate) return { started: false, reason: r.run_id ? "already_previewed" : "already_starting" };
    return { started: true, reason: "started" };
  } catch {
    return { started: false, reason: "threw" };
  }
}

async function previewEverStarted(tenant_id: string, slug: string): Promise<boolean> {
  try {
    const key = previewRunKey(tenant_id, slug);
    const done = key.replace(PREVIEW_RUN_KEY_PREFIX, "first-run-preview-done:");
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id")
      .in("cron_dedupe_key", [key, done])
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  } catch {
    return true;
  }
}

export type PreviewStart =
  | { started: true; duplicate?: boolean; run_id?: string | null }
  | { started: false; permanent: boolean; reason: string };

export async function startPreviewRun(
  tenant_id: string,
  slug: string,
  opts: { claimSuffix?: string } = {},
): Promise<PreviewStart> {
  const key = previewRunKey(tenant_id, slug);
  try {
    const result = await runChannelRecipe(
      tenant_id,
      slug,
      {
        channelContext: defaultChannelContext,
        enqueue: async (input) =>
          enqueueAgentRun({
            agent_slug: input.slug,
            tenant_id: input.tenant_id,
            trigger: "channel_recipe",
            payload: input.payload,
            cron_dedupe_key: key,
          }),
      },
      undefined,
      undefined,
      `${key}${opts.claimSuffix ?? ""}`,
    );
    if (result.ok) return result.duplicate ? { started: true, duplicate: true, run_id: result.run_id } : { started: true };
    return { started: false, permanent: result.reason !== "budget_unavailable", reason: result.reason };
  } catch (e) {
    return { started: false, permanent: false, reason: `error: ${(e as Error).message}` };
  }
}

export async function fanOutPreviewRuns(tenant_id: string, slugs: readonly string[]): Promise<string[]> {
  const started: string[] = [];
  for (const slug of slugs) {
    if ((await startPreviewRun(tenant_id, slug)).started) started.push(slug);
  }
  return started;
}
