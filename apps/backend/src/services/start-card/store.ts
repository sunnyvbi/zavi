
import { createHash, randomBytes } from "crypto";
import {
  START_CARD_PART_KEYS,
  START_CARD_LOCALES,
  type StartCard,
  type StartCardLocale,
  type StartCardPart,
  type StartCardPartKey,
  type StartCardParts,
  type StartCardScore,
  type StartCardStatus,
} from "@zavi/shared";
import { globalClient, startCardRpc } from "@/services/tenant-client";

const CARDS = "start_cards";
const QUEUE = "start_card_email_queue";

export type StartCardRow = {
  id: string;
  public_id: string;
  domain: string;
  locale: string;
  search_term: string | null;
  status: StartCardStatus;
  parts: StartCardParts;
  score: StartCardScore | null;
  scorer_version: string;
  evidence: Record<string, unknown>;
  ip_hash: string | null;
  referrer_card_id: string | null;
  budget_day: string | null;
  reserved_usd: number | string;
  spent_usd: number | string;
  revoked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  funding_kind?: CardFundingKind | null;
  funding_tenant_id?: string | null;
  requested_by_run_id?: string | null;
  tool_call_id?: string | null;
  delivery_state?: CardDeliveryState | null;
  delivery_target?: CardDeliveryTarget | null;
  funding_settled_at?: string | null;
  seed_run_id?: string | null;
  notice_sent_at?: string | null;
};

export type CardFundingKind = "public_budget" | "tenant_credits" | "seed";

export type CardDeliveryState = "waiting" | "returned" | "pending" | "delivered";

export type CardDeliveryTarget =
  | { kind: "chat"; thread_id: string }
  | { kind: "slack"; channel_id: string; thread_ts: string; team_id: string | null }
  | { kind: "none" };

export function isTenantFunded(row: Pick<StartCardRow, "funding_kind">): boolean {
  return row.funding_kind === "tenant_credits";
}

export type QueueRow = {
  id: string;
  email: string;
  domain: string;
  confirm_token_hash: string;
  ip_hash: string | null;
  confirmed_at: string | null;
  card_id: string | null;
  created_at: string;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generatePublicId(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

export const PUBLIC_ID_RE = /^[A-Za-z0-9]{16,32}$/;

export function hashIp(ip: string): string {
  return createHash("sha256").update(`start-card:${ip}`, "utf8").digest("hex").slice(0, 32);
}

export function generateConfirmToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function pendingParts(): StartCardParts {
  const parts: StartCardParts = {};
  for (const key of START_CARD_PART_KEYS) {
    (parts as Record<string, StartCardPart<unknown>>)[key] = { state: "pending", evidence: null, fetched_at: null };
  }
  return parts;
}

export type ClaimFunding =
  | {
      kind: "public_budget";
      budget_day: string;
      reserved_usd: number;
      ip_hash: string | null;
      referrer_card_id: string | null;
    }
  | {
      kind: "tenant_credits";
      tenant_id: string;
      run_id: string;
      tool_call_id: string;
      reserved_usd: number;
      delivery_target: CardDeliveryTarget;
      run_cap: number;
    };

export type ClaimResult =
  | { outcome: "created" | "reused" | "same_call"; id: string; public_id: string; status: StartCardStatus }
  | { outcome: "run_cap" | "run_not_running" };

export async function claimCard(input: { domain: string; since_iso: string; funding: ClaimFunding }): Promise<ClaimResult> {
  const f = input.funding;
  const { data, error } = await startCardRpc("start_card_claim", {
    p_domain: input.domain,
    p_since: input.since_iso,
    p_public_id: generatePublicId(),
    p_parts: pendingParts(),
    p_ip_hash: f.kind === "public_budget" ? f.ip_hash : null,
    p_referrer_card_id: f.kind === "public_budget" ? f.referrer_card_id : null,
    p_budget_day: f.kind === "public_budget" ? f.budget_day : null,
    p_reserved_usd: f.reserved_usd,
    p_funding_kind: f.kind,
    p_tenant_id: f.kind === "tenant_credits" ? f.tenant_id : null,
    p_run_id: f.kind === "tenant_credits" ? f.run_id : null,
    p_tool_call_id: f.kind === "tenant_credits" ? f.tool_call_id : null,
    p_delivery_target: f.kind === "tenant_credits" ? f.delivery_target : null,
    p_run_cap: f.kind === "tenant_credits" ? f.run_cap : null,
  });
  if (error) throw new Error(`start_card_claim failed: ${error.message}`);
  const r = (data ?? {}) as { outcome?: string; id?: string; public_id?: string; status?: StartCardStatus };
  if (r.outcome === "run_cap" || r.outcome === "run_not_running") return { outcome: r.outcome };
  if ((r.outcome === "created" || r.outcome === "reused" || r.outcome === "same_call") && r.id && r.public_id) {
    return { outcome: r.outcome, id: r.id, public_id: r.public_id, status: r.status ?? "running" };
  }
  throw new Error(`start_card_claim returned an unexpected result: ${String(r.outcome)}`);
}

export type SeedClaimResult =
  | { outcome: "created" | "same_run"; id: string; public_id: string; status: StartCardStatus }
  | { outcome: "suppressed" | "run_closed" | "not_reserved" };

export async function claimSeedCard(input: { run_id: string; domain: string }): Promise<SeedClaimResult> {
  const { data, error } = await startCardRpc("start_card_seed_claim", {
    p_run_id: input.run_id,
    p_domain: input.domain,
    p_public_id: generatePublicId(),
    p_parts: pendingParts(),
  });
  if (error) throw new Error(`start_card_seed_claim failed: ${error.message}`);
  const r = (data ?? {}) as { outcome?: string; id?: string; public_id?: string; status?: StartCardStatus };
  if (r.outcome === "suppressed" || r.outcome === "run_closed" || r.outcome === "not_reserved") return { outcome: r.outcome };
  if ((r.outcome === "created" || r.outcome === "same_run") && r.id && r.public_id) {
    return { outcome: r.outcome, id: r.id, public_id: r.public_id, status: r.status ?? "running" };
  }
  throw new Error(`start_card_seed_claim returned an unexpected result: ${String(r.outcome)}`);
}

export async function transitionDelivery(
  id: string,
  from: CardDeliveryState,
  to: CardDeliveryState,
): Promise<boolean> {
  const { data, error } = await globalClient()
    .from(CARDS)
    .update({ delivery_state: to, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("funding_kind", "tenant_credits")
    .eq("delivery_state", from)
    .select("id");
  if (error) throw new Error(`start_card delivery update failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function listUnsettledTenantCards(olderThanIso: string, limit: number): Promise<string[]> {
  const { data, error } = await globalClient()
    .from(CARDS)
    .select("id")
    .eq("funding_kind", "tenant_credits")
    .in("status", ["done", "failed"])
    .is("funding_settled_at", null)
    .lt("updated_at", olderThanIso)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`start_card unsettled list failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function getCardById(id: string): Promise<StartCardRow | null> {
  const { data, error } = await globalClient().from(CARDS).select("*").eq("id", id).maybeSingle<StartCardRow>();
  if (error) throw new Error(`start_card read failed: ${error.message}`);
  return data ?? null;
}

export function isHiddenSeedCard(row: Pick<StartCardRow, "funding_kind" | "notice_sent_at">): boolean {
  return row.funding_kind === "seed" && !row.notice_sent_at;
}

export async function getPublicCardByPublicId(publicId: string): Promise<StartCardRow | null> {
  const row = await getCardByPublicId(publicId);
  if (!row || isHiddenSeedCard(row)) return null;
  if (row.funding_kind === "seed" && (await isSeedDomainSuppressed(row.domain))) return null;
  return row;
}

async function isSeedDomainSuppressed(domain: string): Promise<boolean> {
  const { data, error } = await globalClient()
    .from("seed_suppressions")
    .select("domain")
    .eq("domain", domain.toLowerCase().replace(/^www\./, ""))
    .maybeSingle<{ domain: string }>();
  if (error) throw new Error(`seed suppression read failed: ${error.message}`);
  return !!data;
}

export async function getCardByPublicId(publicId: string): Promise<StartCardRow | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const { data, error } = await globalClient()
    .from(CARDS)
    .select("*")
    .eq("public_id", publicId)
    .maybeSingle<StartCardRow>();
  if (error) throw new Error(`start_card read failed: ${error.message}`);
  return data ?? null;
}

export async function findRecentCardForDomain(domain: string, sinceIso: string): Promise<StartCardRow | null> {
  const { data, error } = await globalClient()
    .from(CARDS)
    .select("*")
    .eq("domain", domain)
    .gte("created_at", sinceIso)
    .in("status", ["running", "done"])
    .is("revoked_at", null)
    .neq("funding_kind", "seed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<StartCardRow>();
  if (error) throw new Error(`start_card dedupe read failed: ${error.message}`);
  return data ?? null;
}

export async function updateCard(id: string, patch: Partial<StartCardRow>): Promise<void> {
  const { error } = await globalClient()
    .from(CARDS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`start_card update failed: ${error.message}`);
}

export async function setCardPart(id: string, key: StartCardPartKey, part: StartCardPart<unknown>): Promise<void> {
  const { error } = await startCardRpc("start_card_set_part", { p_card_id: id, p_key: key, p_part: part });
  if (error) throw new Error(`start_card_set_part failed: ${error.message}`);
}

function publicStatus(row: StartCardRow, now: Date): StartCardStatus {
  if (row.revoked_at) return "removed";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return row.status;
}

function asLocale(v: string): StartCardLocale {
  return (START_CARD_LOCALES as readonly string[]).includes(v) ? (v as StartCardLocale) : "US";
}

export function toPublicCard(row: StartCardRow, now: Date = new Date()): StartCard {
  const status = publicStatus(row, now);
  const hidden = status === "removed" || status === "expired";
  return {
    public_id: row.public_id,
    domain: row.domain,
    locale: asLocale(row.locale),
    search_term: hidden ? null : row.search_term,
    status,
    parts: hidden ? {} : row.parts ?? {},
    score: hidden ? null : row.score ?? null,
    scorer_version: row.scorer_version,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function tickIpBucket(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await startCardRpc("tick_enrichment_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function findPendingQueueRow(email: string, domain: string): Promise<QueueRow | null> {
  const { data, error } = await globalClient()
    .from(QUEUE)
    .select("*")
    .eq("email", email)
    .eq("domain", domain)
    .is("card_id", null)
    .limit(1)
    .maybeSingle<QueueRow>();
  if (error) throw new Error(`start_card queue read failed: ${error.message}`);
  return data ?? null;
}

export async function insertQueueRow(input: {
  email: string;
  domain: string;
  confirm_token_hash: string;
  ip_hash: string | null;
}): Promise<string> {
  const { data, error } = await globalClient()
    .from(QUEUE)
    .insert(input)
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`start_card queue insert failed: ${error?.message ?? "no row"}`);
  return data.id;
}

export async function insertAccountQueueRow(input: { email: string; domain: string; card_id: string | null }): Promise<boolean> {
  const base = globalClient().from(QUEUE).select("id").eq("email", input.email);
  const scoped = input.card_id ? base.eq("card_id", input.card_id) : base.eq("domain", input.domain).is("card_id", null);
  const { data: existing, error: readError } = await scoped.limit(1).maybeSingle<{ id: string }>();
  if (readError) throw new Error(`start_card queue read failed: ${readError.message}`);
  if (existing) {
    const { error } = await globalClient()
      .from(QUEUE)
      .update({ confirmed_at: new Date().toISOString() })
      .eq("id", existing.id)
      .is("confirmed_at", null);
    if (error) throw new Error(`start_card queue confirm failed: ${error.message}`);
    return false;
  }
  const { error } = await globalClient()
    .from(QUEUE)
    .insert({
      ...input,
      confirm_token_hash: hashToken(generateConfirmToken()),
      ip_hash: null,
      confirmed_at: new Date().toISOString(),
    });
  if (error) throw new Error(`start_card queue insert failed: ${error.message}`);
  return true;
}

export async function confirmQueueRow(tokenHash: string, notBeforeIso: string): Promise<QueueRow | null> {
  const { data, error } = await globalClient()
    .from(QUEUE)
    .update({ confirmed_at: new Date().toISOString() })
    .eq("confirm_token_hash", tokenHash)
    .is("confirmed_at", null)
    .gte("created_at", notBeforeIso)
    .select("*")
    .maybeSingle<QueueRow>();
  if (error) throw new Error(`start_card queue confirm failed: ${error.message}`);
  return data ?? null;
}

export async function listConfirmedQueueRows(limit: number): Promise<QueueRow[]> {
  const { data, error } = await globalClient()
    .from(QUEUE)
    .select("*")
    .not("confirmed_at", "is", null)
    .is("card_id", null)
    .order("confirmed_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`start_card queue list failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

export async function listCardsAwaitingEmail(limit: number): Promise<string[]> {
  const { data, error } = await globalClient()
    .from(QUEUE)
    .select("card_id")
    .not("confirmed_at", "is", null)
    .not("card_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`start_card queue list failed: ${error.message}`);
  return [...new Set((data ?? []).map((r) => (r as { card_id: string }).card_id))];
}

export async function listQueueRowsForCard(cardId: string): Promise<QueueRow[]> {
  const { data, error } = await globalClient().from(QUEUE).select("*").eq("card_id", cardId);
  if (error) throw new Error(`start_card queue read failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

export async function attachQueueRowToCard(queueId: string, cardId: string): Promise<void> {
  const { error } = await globalClient().from(QUEUE).update({ card_id: cardId }).eq("id", queueId);
  if (error) throw new Error(`start_card queue attach failed: ${error.message}`);
}

export async function detachQueueRow(queueId: string): Promise<void> {
  const { error } = await globalClient().from(QUEUE).update({ card_id: null }).eq("id", queueId);
  if (error) throw new Error(`start_card queue detach failed: ${error.message}`);
}

export async function deleteQueueRow(queueId: string): Promise<void> {
  const { error } = await globalClient().from(QUEUE).delete().eq("id", queueId);
  if (error) throw new Error(`start_card queue delete failed: ${error.message}`);
}

export async function purgeStaleQueueRows(beforeIso: string): Promise<number> {
  const { data, error } = await globalClient().from(QUEUE).delete().lt("created_at", beforeIso).select("id");
  if (error) throw new Error(`start_card queue purge failed: ${error.message}`);
  return (data ?? []).length;
}

const REPORTS = "start_card_reports";

export async function insertRemovalRequest(cardId: string, tokenHash: string): Promise<string> {
  const { data, error } = await globalClient()
    .from(REPORTS)
    .insert({ card_id: cardId, kind: "removal", verify_token_hash: tokenHash })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`start_card removal insert failed: ${error?.message ?? "no row"}`);
  return data.id;
}

export async function insertStaffReport(input: { card_id: string; email: string; reason: string }): Promise<void> {
  const { error } = await globalClient()
    .from(REPORTS)
    .insert({ card_id: input.card_id, kind: "report", email: input.email, reason: input.reason });
  if (error) throw new Error(`start_card report insert failed: ${error.message}`);
}

export async function deleteReportRow(id: string): Promise<void> {
  const { error } = await globalClient().from(REPORTS).delete().eq("id", id);
  if (error) throw new Error(`start_card report delete failed: ${error.message}`);
}

export async function findRemovalToken(tokenHash: string, notBeforeIso: string): Promise<string | null> {
  const { data, error } = await globalClient()
    .from(REPORTS)
    .select("card_id")
    .eq("verify_token_hash", tokenHash)
    .eq("kind", "removal")
    .gte("created_at", notBeforeIso)
    .maybeSingle<{ card_id: string }>();
  if (error) throw new Error(`start_card removal read failed: ${error.message}`);
  return data?.card_id ?? null;
}

export async function deleteRemovalToken(tokenHash: string): Promise<void> {
  const { error } = await globalClient().from(REPORTS).delete().eq("verify_token_hash", tokenHash).eq("kind", "removal");
  if (error) throw new Error(`start_card removal delete failed: ${error.message}`);
}

export async function revokeCard(cardId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await globalClient()
    .from(CARDS)
    .update({ revoked_at: now, updated_at: now })
    .eq("id", cardId)
    .is("revoked_at", null);
  if (error) throw new Error(`start_card revoke failed: ${error.message}`);
}
