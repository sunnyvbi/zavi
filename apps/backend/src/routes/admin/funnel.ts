
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { SIGNUP_ATTRIBUTION_KEY } from "@/services/tenants/signup-attribution";

import { resolveSignupSource, type SignupSource } from "@/services/tenants/signup-source";
export { signupSource } from "@/services/tenants/signup-source";

type FunnelRow = {
  tenant_id: string;
  signed_up_at: string;
  first_run_at: string | null;
  first_feedback_at: string | null;
  source: Omit<FunnelSource, "signups">;
};

type FunnelTotals = { signed_up: number; ran: number; gave_feedback: number };

export type FunnelTenant = { id: string; created_at: string; kind?: string | null; slug?: string | null };
export type FunnelAttribution = { tenant_id: string; value: unknown };
export type FunnelSource = SignupSource & { signups: number };

export type FunnelReferral = { tenant_id: string; member_id: string; display_name?: string | null };

export function funnelCohort(tenants: FunnelTenant[], includeInternal: boolean): FunnelTenant[] {
  return tenants.filter(t => t.kind !== "launch_video_shell" && (includeInternal || (t.kind !== "test" && !DOGFOOD_SLUGS.has(t.slug ?? ""))));
}
export type FunnelRunInput = {
  tenant_id: string;
  started_at: string | null;
  enqueued_at: string | null;
};
export type FunnelFeedbackInput = { tenant_id: string; created_at: string };

export function aggregateFunnel(
  tenants: FunnelTenant[],
  runs: FunnelRunInput[],
  feedback: FunnelFeedbackInput[],
  attribution: FunnelAttribution[] = [],
  referrals: FunnelReferral[] = [],
): { totals: FunnelTotals; rows: FunnelRow[]; sources: FunnelSource[] } {
  const firstRun = new Map<string, string>();
  for (const r of runs) {
    const ts = r.started_at ?? r.enqueued_at;
    if (!ts) continue;
    const cur = firstRun.get(r.tenant_id);
    if (!cur || ts < cur) firstRun.set(r.tenant_id, ts);
  }
  const firstFb = new Map<string, string>();
  for (const f of feedback) {
    const cur = firstFb.get(f.tenant_id);
    if (!cur || f.created_at < cur) firstFb.set(f.tenant_id, f.created_at);
  }

  const byTenant = new Map(attribution.map(a => [a.tenant_id, a.value]));
  const byReferral = new Map(referrals.map(r => [r.tenant_id, r]));
  const sourceFor = (tenantId: string): SignupSource =>
    resolveSignupSource(byTenant.get(tenantId), byReferral.get(tenantId));
  const rows: FunnelRow[] = tenants.map((t) => ({
    tenant_id: t.id,
    signed_up_at: t.created_at,
    source: sourceFor(t.id),
    first_run_at: firstRun.get(t.id) ?? null,
    first_feedback_at: firstFb.get(t.id) ?? null,
  }));
  const totals = rows.reduce<FunnelTotals>(
    (acc, r) => ({
      signed_up: acc.signed_up + 1,
      ran: acc.ran + (r.first_run_at ? 1 : 0),
      gave_feedback: acc.gave_feedback + (r.first_feedback_at ? 1 : 0),
    }),
    { signed_up: 0, ran: 0, gave_feedback: 0 },
  );
  const bySource = new Map<string, FunnelSource>();
  for (const tenant of tenants) {
    const source = sourceFor(tenant.id);
    const key = JSON.stringify([source.kind, source.source, source.creator_id]);
    const row = bySource.get(key) ?? { ...source, signups: 0 };
    row.signups++;
    bySource.set(key, row);
  }
  const sources = [...bySource.values()].sort((a, b) => b.signups - a.signups || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
  return { totals, rows, sources };
}

const PAGE = 500;
export async function readPages<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const result = await read(from, from + PAGE - 1);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < PAGE) return rows;
  }
  throw new Error("Too many records for this window. Choose fewer days.");
}

export async function staffFunnel(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const rawDays = Number(req.query?.days ?? 30);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, Math.floor(rawDays))) : 30;
  const includeInternal = req.query?.include_internal === "1";
  const until = new Date().toISOString();
  const since = new Date(Date.parse(until) - days * 86_400_000).toISOString();
  const sb = staffCrossTenantClient("admin/funnel: signup sources and milestones for a bounded workspace cohort");
  try {
    const [created, claims] = await Promise.all([
      readPages<FunnelTenant>((from, to) => sb.from("tenants")
        .select("id, created_at, kind, slug").gte("created_at", since).lt("created_at", until).order("id").range(from, to)),
      readPages<{ tenant_id: string; claimed_at: string }>((from, to) => sb.from("launch_video_public_jobs")
        .select("tenant_id, claimed_at").gte("claimed_at", since).lt("claimed_at", until).order("id").range(from, to)),
    ]);
    const byTenant = new Map(created.map(t => [t.id, t]));
    const claimedAt = new Map<string, string>();
    for (const claim of claims) {
      const previous = claimedAt.get(claim.tenant_id);
      if (!previous || claim.claimed_at < previous) claimedAt.set(claim.tenant_id, claim.claimed_at);
    }
    const olderIds = [...claimedAt.keys()].filter(id => !byTenant.has(id));
    for (let at = 0; at < olderIds.length; at += 100) {
      const rows = await readPages<FunnelTenant>((from, to) => sb.from("tenants")
        .select("id, created_at, kind, slug").in("id", olderIds.slice(at, at + 100)).order("id").range(from, to));
      for (const tenant of rows) byTenant.set(tenant.id, tenant);
    }
    const all = [...byTenant.values()].map(t => ({ ...t, created_at: claimedAt.get(t.id) ?? t.created_at }));
    const tenants = funnelCohort(all, includeInternal);
    const runs: FunnelRunInput[] = [];
    const feedback: FunnelFeedbackInput[] = [];
    const attribution: FunnelAttribution[] = [];
    const referrals: FunnelReferral[] = [];
    for (let at = 0; at < tenants.length; at += 100) {
      const ids = tenants.slice(at, at + 100).map(t => t.id);
      const [r, f, a, refs] = await Promise.all([
        readPages<FunnelRunInput>((from, to) => sb.from("agent_runs").select("tenant_id, started_at, enqueued_at")
          .in("tenant_id", ids).not("enqueued_at", "is", null).gte("enqueued_at", since).order("id").range(from, to)),
        readPages<FunnelFeedbackInput>((from, to) => sb.from("agent_feedback").select("tenant_id, created_at")
          .in("tenant_id", ids).order("id").range(from, to)),
        readPages<FunnelAttribution>((from, to) => sb.from("tenant_app_setting").select("tenant_id, value")
          .eq("key", SIGNUP_ATTRIBUTION_KEY).in("tenant_id", ids).order("tenant_id").range(from, to)),
        readPages<FunnelReferral>((from, to) => sb.from("affiliate_referrals").select("tenant_id, member_id")
          .in("tenant_id", ids).order("tenant_id").range(from, to)),
      ]);
      referrals.push(...refs);
      runs.push(...r); feedback.push(...f); attribution.push(...a);
    }
    const names = new Map<string, string | null>();
    const creatorIds = [...new Set(referrals.map(r => r.member_id))];
    for (let at = 0; at < creatorIds.length; at += 100) {
      const members = await readPages<{ id: string; display_name: string | null }>((from, to) =>
        sb.from("human_members").select("id, display_name").in("id", creatorIds.slice(at, at + 100)).order("id").range(from, to));
      for (const member of members) names.set(member.id, member.display_name);
    }
    const namedReferrals = referrals.map(r => ({ ...r, display_name: names.get(r.member_id) }));
    res.json({ ...aggregateFunnel(tenants, runs, feedback, attribution, namedReferrals), windowDays: days, since, until,
      includeInternal, excluded: all.length - tenants.length });
  } catch (error) {
    res.status(500).json({ error: { code: "funnel_read_failed", message: (error as Error).message } });
  }
}
