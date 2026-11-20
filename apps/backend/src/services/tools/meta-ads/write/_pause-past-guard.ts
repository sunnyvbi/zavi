
import { z } from "zod";
import { isNoWriteEmitError } from "@/services/agents/emit-no-write";
import { rationaleBody } from "@/services/tools/_shared/rationale";
import type { CampaignBrief } from "@/services/growth/perf-brief/brief";
import type { CutGuardVerdict } from "./_cut-guard";

export const PAUSE_PAST_GUARD_CLASS = "meta_ads.pause_past_cut_guard";
export const PAUSE_PAST_GUARD_ORIGIN = "cut_guard_override";

export const pausePastGuardBodySchema = z
  .object({
    object_id: z.string().regex(/^[0-9]{1,64}$/),
    level: z.literal("adset"),
    status: z.literal("PAUSED"),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    guard_code: z.string().regex(/^[a-z_]{1,80}$/),
    guard_reason: z.string().min(1).max(300),
    spend_7d_usd: z.number().nonnegative().nullable(),
    name: z.string().max(255).optional(),
    about: z.string().max(300).optional(),
    rationale: rationaleBody(),
    over_cap: z.literal(true),
    origin: z.literal(PAUSE_PAST_GUARD_ORIGIN),
  })
  .strict();
export type PausePastGuardBody = z.infer<typeof pausePastGuardBodySchema>;

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function founderGuardReason(verdict: Pick<CutGuardVerdict, "reason">, brief: CampaignBrief | null): string {
  const s = brief?.settled;
  switch (verdict.reason) {
    case "cut_blocked_no_brief_autopilot":
      return "Zavi could not read this ad set's results, and it does not pause anything without them.";
    case "cut_blocked_objective_not_conversions":
      return "It is bought on reach and clicks, so having no sales yet does not mean it is failing.";
    case "cut_blocked_top_funnel_working":
      return s
        ? `It is bringing sign-ups (${s.sign_ups} at $${n(s.cost_per_signup_usd ?? 0)} each); people drop off after they click.`
        : "It is bringing sign-ups; people drop off after they click.";
    case "cut_blocked_insufficient_settled_signal":
      return s
        ? `Still learning: ${s.days} settled days, $${n(s.spend_usd)} spent and ${s.clicks} clicks so far, too few to judge.`
        : "Still learning: too little data so far to judge it.";
    case "cut_blocked_brief_contradicts":
      return s
        ? `It is producing results (${s.purchases} purchases and ${s.sign_ups} sign-ups in the settled days).`
        : "It is producing results.";
    default:
      return "Zavi's check says it is too early, or the results do not support pausing it.";
  }
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export function pausePastGuardBody(args: {
  ad_set_id: string;
  at: Date;
  verdict: Pick<CutGuardVerdict, "reason">;
  brief: CampaignBrief | null;
  spend_7d_usd: number | null;
  name?: string;
  about?: string;
  rationale?: string;
}): PausePastGuardBody {
  return pausePastGuardBodySchema.parse({
    object_id: args.ad_set_id,
    level: "adset",
    status: "PAUSED",
    day: utcDay(args.at),
    guard_code: (args.verdict.reason ?? "cut_blocked").slice(0, 80),
    guard_reason: founderGuardReason(args.verdict, args.brief),
    spend_7d_usd: args.spend_7d_usd === null ? null : Math.round(args.spend_7d_usd * 100) / 100,
    ...(args.name ? { name: args.name.slice(0, 255) } : {}),
    ...(args.about ? { about: args.about.slice(0, 300) } : {}),
    rationale: args.rationale ?? "",
    over_cap: true,
    origin: PAUSE_PAST_GUARD_ORIGIN,
  });
}

export async function adSetSpend7d(tenant_id: string, ad_set_id: string): Promise<number | null> {
  try {
    const { fetchMetaDailySeries } = await import("../daily_series");
    const { rows, truncated } = await fetchMetaDailySeries(tenant_id, { level: "adset", date_preset: "last_7d", filter: { ad_set_id } });
    if (truncated) return null;
    return rows.filter((r) => r.ad_set_id === ad_set_id).reduce((sum, r) => sum + (Number(r.spend_usd) || 0), 0);
  } catch {
    return null;
  }
}

export const CLAIM_ORPHAN_MS = 5 * 60_000;

export async function pausePastGuardCardToday(tenant_id: string, ad_set_id: string, day: string): Promise<string | null> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const [ca, dec] = await Promise.all([
    db.from("channel_actions").select("id").eq("exec_class", PAUSE_PAST_GUARD_CLASS).eq("exec_payload->>object_id", ad_set_id).eq("exec_payload->>day", day).limit(1),
    db.from("decisions").select("id").eq("decision_class", PAUSE_PAST_GUARD_CLASS).eq("body->>object_id", ad_set_id).eq("body->>day", day).limit(1),
  ]);
  if (ca.error) throw new Error(`pause card read failed: ${ca.error.message}`);
  if (dec.error) throw new Error(`pause card read failed: ${dec.error.message}`);
  const row = ((ca.data ?? []) as Array<{ id: string }>)[0] ?? ((dec.data ?? []) as Array<{ id: string }>)[0];
  return row?.id ?? null;
}

export type ClaimResult = { state: "claimed"; token: string } | { state: "taken" } | { state: "in_progress" } | { state: "unreadable" };

export type ClaimStore = {
  insert: (tenant_id: string, ad_set_id: string, day: string, token: string) => Promise<"ok" | "exists" | "error">;
  read: (tenant_id: string, ad_set_id: string, day: string) => Promise<{ card_id: string | null; created_at: string; token: string } | null>;
  takeOver: (tenant_id: string, ad_set_id: string, day: string, oldToken: string, newToken: string, olderThanIso: string) => Promise<boolean>;
  stillMine: (tenant_id: string, ad_set_id: string, day: string, token: string) => Promise<boolean>;
  link: (tenant_id: string, ad_set_id: string, day: string, token: string, card_id: string) => Promise<boolean>;
  release: (tenant_id: string, ad_set_id: string, day: string, token: string) => Promise<void>;
  cardToday: typeof pausePastGuardCardToday;
};

const claims = async (tenant_id: string) => {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  return tenantClient(asTenantId(tenant_id)).from("pause_past_guard_claims");
};

export const liveClaimStore: ClaimStore = {
  insert: async (tenant_id, ad_set_id, day, token) => {
    const { error } = await (await claims(tenant_id)).insert({ object_id: ad_set_id, day, token, created_at: new Date().toISOString() });
    if (!error) return "ok";
    return (error as { code?: string }).code === "23505" ? "exists" : "error";
  },
  read: async (tenant_id, ad_set_id, day) => {
    const { data, error } = await (await claims(tenant_id)).select("card_id, created_at, token").eq("object_id", ad_set_id).eq("day", day).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { card_id: string | null; created_at: string; token: string } | null) ?? null;
  },
  takeOver: async (tenant_id, ad_set_id, day, oldToken, newToken, olderThanIso) => {
    const { data, error } = await (await claims(tenant_id))
      .update({ token: newToken, created_at: new Date().toISOString() })
      .eq("object_id", ad_set_id)
      .eq("day", day)
      .eq("token", oldToken)
      .is("card_id", null)
      .lt("created_at", olderThanIso)
      .select("object_id");
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown[]).length === 1;
  },
  stillMine: async (tenant_id, ad_set_id, day, token) => {
    const { data, error } = await (await claims(tenant_id)).select("object_id").eq("object_id", ad_set_id).eq("day", day).eq("token", token).is("card_id", null).maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  },
  link: async (tenant_id, ad_set_id, day, token, card_id) => {
    const { data, error } = await (await claims(tenant_id)).update({ card_id }).eq("object_id", ad_set_id).eq("day", day).eq("token", token).is("card_id", null).select("object_id");
    if (error) console.warn(`[pause-past-guard] ${tenant_id}/${ad_set_id}: card not linked to its claim: ${error.message}`);
    return !error && ((data ?? []) as unknown[]).length === 1;
  },
  release: async (tenant_id, ad_set_id, day, token) => {
    const { error } = await (await claims(tenant_id)).delete().eq("object_id", ad_set_id).eq("day", day).eq("token", token).is("card_id", null);
    if (error) console.warn(`[pause-past-guard] ${tenant_id}/${ad_set_id}: claim not released: ${error.message}`);
  },
  cardToday: pausePastGuardCardToday,
};

const newToken = (): string => globalThis.crypto.randomUUID();

export async function claimPausePastGuard(
  tenant_id: string,
  ad_set_id: string,
  day: string,
  store: ClaimStore = liveClaimStore,
  now: () => number = Date.now,
  token: () => string = newToken,
): Promise<ClaimResult> {
  try {
    const mine = token();
    const ins = await store.insert(tenant_id, ad_set_id, day, mine);
    if (ins === "error") return { state: "unreadable" };
    if (ins === "ok") {
      const existing = await store.cardToday(tenant_id, ad_set_id, day);
      if (existing) {
        await store.link(tenant_id, ad_set_id, day, mine, existing);
        return { state: "taken" };
      }
      return { state: "claimed", token: mine };
    }
    const row = await store.read(tenant_id, ad_set_id, day);
    if (!row) return { state: "unreadable" };
    if (row.card_id) return { state: "taken" };
    if (now() - Date.parse(row.created_at) < CLAIM_ORPHAN_MS) return { state: "in_progress" };
    if (await store.cardToday(tenant_id, ad_set_id, day)) return { state: "taken" };
    if (await store.takeOver(tenant_id, ad_set_id, day, row.token, mine, new Date(now() - CLAIM_ORPHAN_MS).toISOString())) return { state: "claimed", token: mine };
    const after = await store.read(tenant_id, ad_set_id, day);
    if (after?.card_id || (await store.cardToday(tenant_id, ad_set_id, day))) return { state: "taken" };
    if (!after) return { state: "unreadable" };
    return { state: "in_progress" };
  } catch {
    return { state: "unreadable" };
  }
}

export type FounderPauseCard = { filed: true; id: string } | { filed: false; why: "already_today" | "in_progress" | "not_filed" | "uncertain" };

export async function fileFounderPauseCard(
  emit: (decision_class: string, body: unknown) => Promise<string>,
  tenant_id: string,
  body: PausePastGuardBody,
  deps: { store?: ClaimStore; now?: () => number; token?: () => string } = {},
): Promise<FounderPauseCard> {
  const store = deps.store ?? liveClaimStore;
  const { object_id: ad_set, day } = body;
  const claim = await claimPausePastGuard(tenant_id, ad_set, day, store, deps.now, deps.token);
  if (claim.state === "taken") return { filed: false, why: "already_today" };
  if (claim.state === "in_progress") return { filed: false, why: "in_progress" };
  if (claim.state === "unreadable") {
    console.warn(`[pause-past-guard] ${tenant_id}/${ad_set}: could not claim today's card, none filed`);
    return { filed: false, why: "not_filed" };
  }
  const { token } = claim;
  let mine: boolean;
  try {
    mine = await store.stillMine(tenant_id, ad_set, day, token);
  } catch {
    return { filed: false, why: "not_filed" };
  }
  if (!mine) {
    try {
      if (await store.cardToday(tenant_id, ad_set, day)) return { filed: false, why: "already_today" };
      const row = await store.read(tenant_id, ad_set, day);
      if (row?.card_id) return { filed: false, why: "already_today" };
      return { filed: false, why: row ? "in_progress" : "not_filed" };
    } catch {
      return { filed: false, why: "not_filed" };
    }
  }
  let id: string;
  try {
    id = await emit(PAUSE_PAST_GUARD_CLASS, body);
  } catch (e) {
    console.warn(`[pause-past-guard] ${tenant_id}/${ad_set}: card not filed: ${(e as Error).message}`);
    let landed: string | null | undefined;
    try {
      landed = await store.cardToday(tenant_id, ad_set, day);
    } catch {
      landed = undefined;
    }
    if (landed) {
      await store.link(tenant_id, ad_set, day, token, landed).catch(() => false);
      return { filed: true, id: landed };
    }
    let certain = false;
    try {
      certain = landed === null && isNoWriteEmitError(e);
    } catch {
      certain = false;
    }
    if (!certain) return { filed: false, why: "uncertain" };
    await store.release(tenant_id, ad_set, day, token).catch(() => undefined);
    return { filed: false, why: "not_filed" };
  }
  await store.link(tenant_id, ad_set, day, token, id).catch(() => false);
  return { filed: true, id };
}
