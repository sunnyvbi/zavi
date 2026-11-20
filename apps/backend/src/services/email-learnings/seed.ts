
import { createHash } from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { resolveSendgridAccount } from "@/services/connectors/email-campaign/sendgrid-account";
import {
  EMAIL_PROVIDERS,
  EMAIL_TOOLS,
  NO_RESULTS,
  type CampaignResults,
  type EmailTool,
  type ProviderCall,
  type SentCampaign,
} from "@/services/connectors/email-campaign/providers";
import { liveToolCaller } from "@/services/email-test-lists/lists";
import { legacyProviderGroup, providerGroup } from "@/services/email-results/start";
import type { ObservationRow } from "./recompute";

export const SEED_CAP = 20;
export const SEED_DAYS = 180;
export const SEED_MAX_PAGES = 25;

export type SourceStatus = { route: EmailTool; status: "ok" | "partial" | "could_not_read" | "busy"; count: number; read_at: string };

export type StopReason = "budget" | "lease_lost";
export class SeedStopped extends Error {
  constructor(public readonly reason: StopReason = "budget") {
    super(`seed stopped early (${reason})`);
  }
}

export async function accountKeyFor(tenantId: string, tool: EmailTool): Promise<string | null> {
  if (tool === "sendgrid") {
    const sg = await resolveSendgridAccount(tenantId);
    return sg ? providerGroup("sendgrid", tenantId, { kind: "sendgrid_key", key_digest: sg.key_digest }) : null;
  }
  const acct = await resolveOwnedComposioAccount(tenantId, tool);
  return acct ? providerGroup(tool, tenantId, { kind: "composio", connected_account_id: acct.connected_account_id, auth_config_id: acct.auth_config_id }) : null;
}

export async function connectedAccountKeys(tenantId: string): Promise<string[]> {
  const keys = await Promise.all(EMAIL_TOOLS.map((t) => accountKeyFor(tenantId, t)));
  return [providerGroup("zavi_list", tenantId, null), ...keys.filter((k): k is string => k !== null)];
}

async function connectionRows(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("connector_metadata")
    .select("slug, team_id, composio_auth_config_id, connected_at")
    .in("slug", ["email", ...EMAIL_TOOLS.filter((t) => t !== "sendgrid").map((t) => `composio.${t}`)]);
  if (error) throw new Error("connector_metadata read failed");
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function emailToolConnected(tenantId: string): Promise<boolean> {
  return (await connectionRows(tenantId)).length > 0;
}

export async function connectedSourcesHash(tenantId: string): Promise<string> {
  const rows = (await connectionRows(tenantId))
    .map((r) => [r.slug, r.team_id, r.composio_auth_config_id, r.connected_at].map((v) => String(v ?? "")).join("|"))
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
}

export type SeedRequest = "queued" | "pending" | "done" | "failed_today" | "already_retried_today" | "not_authorized" | "failed";
const SEED_ANSWERS: readonly SeedRequest[] = ["queued", "pending", "done", "failed_today", "already_retried_today", "not_authorized"];

export async function requestSeed(tenantId: string, hash?: string): Promise<SeedRequest> {
  try {
    const h = hash ?? (await connectedSourcesHash(tenantId));
    const { data, error } = await tenantRpc(asTenantId(tenantId), "request_email_learn_seed", { p_sources_hash: h });
    if (error) return "failed";
    return SEED_ANSWERS.includes(data as SeedRequest) ? (data as SeedRequest) : "failed";
  } catch {
    return "failed";
  }
}

export async function retrySeed(tenantId: string, actorUserId: string, hash?: string): Promise<SeedRequest> {
  try {
    const h = hash ?? (await connectedSourcesHash(tenantId));
    const { data, error } = await tenantRpc(asTenantId(tenantId), "retry_email_learn_seed", { p_actor_user_id: actorUserId, p_sources_hash: h });
    if (error) return "failed";
    return SEED_ANSWERS.includes(data as SeedRequest) ? (data as SeedRequest) : "failed";
  } catch {
    return "failed";
  }
}

export type SeedGuard = () => Promise<void>;
const noGuard: SeedGuard = async () => undefined;

export async function readToolHistory(
  tool: EmailTool,
  call: ProviderCall,
  accountKey: string,
  now: Date,
  guard: SeedGuard = noGuard,
): Promise<{ rows: ObservationRow[]; complete: boolean; stopped?: StopReason }> {
  const p = EMAIL_PROVIDERS[tool];
  const since = new Date(now.getTime() - SEED_DAYS * 86_400_000).toISOString();
  const usable: SentCampaign[] = [];
  const seenIds = new Set<string>();
  const names = new Map<string, string | null>();
  const counts = new Map<string, CampaignResults>();
  const rowsSoFar = (): ObservationRow[] =>
    usable
      .filter((c) => counts.has(c.id))
      .map((c) => {
        const r = counts.get(c.id) ?? NO_RESULTS;
        const row: ObservationRow = {
          account_key: accountKey,
          route: tool,
          campaign_id: c.id,
          list_id: c.list_id,
          list_name: names.get(c.list_id as string) ?? null,
          subject: (c.subject ?? "").slice(0, 300),
          sent_at: c.sent_at,
          delivered: r.delivered,
          clicks: r.clicks,
        };
        return row;
      });
  try {
    return await read();
  } catch (e) {
    if (e instanceof SeedStopped) return { rows: e.reason === "lease_lost" ? [] : rowsSoFar(), complete: false, stopped: e.reason };
    throw e;
  }

  async function read(): Promise<{ rows: ObservationRow[]; complete: boolean }> {
    let cursor: string | null = null;
    let exhausted = false;
    let pages = 0;
    while (usable.length < SEED_CAP && pages < SEED_MAX_PAGES) {
      await guard();
      const page = await p.listSentCampaignsPage(call, { since, cursor, limit: SEED_CAP });
      pages++;
      for (const c of page.campaigns) {
        if (seenIds.has(c.id) || usable.length >= SEED_CAP) continue;
        seenIds.add(c.id);
        let full = c;
        if (c.subject === null || c.list_id === null) {
          await guard();
          const s = await p.getCampaign(call, c.id);
          if (!s) continue;
          full = { ...c, subject: s.envelope?.subject ?? c.subject, list_id: s.audience_ids.length === 1 ? s.audience_ids[0] : null, narrowed: s.narrowed || s.audience_ids.length > 1 };
        }
        if (full.list_id !== null && !full.narrowed) usable.push(full);
      }
      if (!page.next || page.next === cursor) {
        exhausted = true;
        break;
      }
      cursor = page.next;
    }
    const complete = usable.length >= SEED_CAP || exhausted;
    if (usable.length === 0) return { rows: [], complete };
    for (const id of new Set(usable.map((c) => c.list_id as string))) {
      await guard();
      names.set(id, (await p.getAudience(call, id).catch(() => null))?.name ?? null);
    }
    if (p.resultsMany) {
      await guard();
      for (const [id, r] of await p.resultsMany(call, usable.map((c) => c.id), accountKey)) counts.set(id, r);
    } else {
      for (const c of usable) {
        await guard();
        counts.set(c.id, await p.results(call, c.id));
      }
    }
    return { rows: rowsSoFar(), complete };
  }
}

export type SeedDeps = {
  accountKey: (tenantId: string, tool: EmailTool) => Promise<string | null>;
  caller: (tenantId: string, tool: EmailTool) => Promise<ProviderCall | null>;
  busy: (accountKey: string) => Promise<boolean>;
  record: (tenantId: string, rows: ObservationRow[]) => Promise<void>;
  sources: (tenantId: string, sources: Record<string, SourceStatus>, seeded: boolean, current: string[], authoritative: boolean) => Promise<void>;
  now: () => Date;
};

export async function seedLearnings(
  tenantId: string,
  deps: SeedDeps = LIVE,
  guard: SeedGuard = noGuard,
  stillOurs: () => Promise<boolean> = async () => true,
): Promise<{ complete: boolean; sources: Record<string, SourceStatus>; stopped?: StopReason }> {
  const sources: Record<string, SourceStatus> = {};
  const current: string[] = [];
  let authoritative = true;
  let complete = true;
  let stopped: StopReason | undefined;
  const now = deps.now();
  for (const tool of EMAIL_TOOLS) {
    let key: string | null;
    try {
      key = await deps.accountKey(tenantId, tool);
    } catch {
      complete = false;
      authoritative = false;
      continue;
    }
    if (!key) continue;
    current.push(key);
    if (stopped) continue;
    const at = now.toISOString();
    if (await deps.busy(key)) {
      sources[key] = { route: tool, status: "busy", count: 0, read_at: at };
      complete = false;
      continue;
    }
    try {
      const call = await deps.caller(tenantId, tool);
      if (!call) continue;
      const read = await readToolHistory(tool, call, key, now, guard);
      if (read.stopped === "lease_lost") return { complete: false, sources, stopped: "lease_lost" };
      if (read.rows.length > 0) {
        if (!(await stillOurs())) return { complete: false, sources, stopped: "lease_lost" };
        await deps.record(tenantId, read.rows);
      }
      sources[key] = { route: tool, status: read.complete ? "ok" : "partial", count: read.rows.length, read_at: at };
      if (!read.complete) complete = false;
      if (read.stopped) stopped = read.stopped;
    } catch (e) {
      sources[key] = { route: tool, status: "could_not_read", count: 0, read_at: at };
      complete = false;
      if (e instanceof SeedStopped) {
        if (e.reason === "lease_lost") return { complete: false, sources, stopped: "lease_lost" };
        stopped = e.reason;
        sources[key].status = "partial";
      }
    }
  }
  if (!(await stillOurs())) return { complete: false, sources, stopped: "lease_lost" };
  await deps.sources(tenantId, sources, complete, current, authoritative);
  return { complete, sources, ...(stopped ? { stopped } : {}) };
}

const LIVE: SeedDeps = {
  accountKey: accountKeyFor,
  caller: liveToolCaller,
  busy: async (accountKey) => {
    const { staffCrossTenantClient } = await import("@/services/tenant-client");
    const keys = [accountKey, legacyProviderGroup(accountKey)].filter((k): k is string => !!k);
    const { data, error } = await staffCrossTenantClient("email learnings seed: is the results worker reading this account now")
      .from("email_result_tasks")
      .select("id")
      .in("group_key", keys)
      .gt("lease_until", new Date().toISOString())
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  },
  record: async (tenantId, rows) => {
    const { error } = await tenantRpc(asTenantId(tenantId), "record_email_learn_observations", { p_rows: rows });
    if (error) throw new Error("record_email_learn_observations failed");
  },
  sources: async (tenantId, sources, seeded, current, authoritative) => {
    const { error } = await tenantRpc(asTenantId(tenantId), "record_email_learn_sources", {
      p_sources: sources,
      p_seeded: seeded,
      p_current: current,
      p_current_authoritative: authoritative,
    });
    if (error) throw new Error("record_email_learn_sources failed");
  },
  now: () => new Date(),
};
