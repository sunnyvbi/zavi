
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { toExecProgress } from "@/services/channels/exec-progress";
import { actionExecReceipt } from "@/services/channels/exec-receipt";
import { campaignTitleFor, cardSubject, parseEmailSendBody, sealedCredentialOf } from "@/services/connectors/email-campaign/execute-send";
import { bulkOutboundSendBody } from "@/services/comms/bulk-outbound/dispatch";
import type { EmailCardRail } from "@/services/email-cards/cards";
import { computeWinLine, type WinLine } from "./win-line";

export type StartInput = { tenant_id: string; rail: EmailCardRail; card_id: string; sent?: number | null; total?: number | null };

export type ResultRow = {
  route: "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
  provider_ref: string;
  account_ref: Record<string, unknown> | null;
  campaign_title: string | null;
  list_id: string | null;
  list_name: string | null;
  subject: string;
  campaign_slug: string | null;
  sent_count: number;
  total_count: number | null;
  started_at: string;
  finished_at: string;
  ga_property_id: string | null;
  win_line: WinLine;
  provider_group: string;
};

type CardRead = {
  class: string;
  body: Record<string, unknown>;
  progress: unknown;
  ended_at: string | null;
  receipt_line?: string | null;
};
type BulkRead = { id: string; status: string; sent: number; total: number; created_at: string; finished_at: string | null };

export type StartDeps = {
  readCard: (tenantId: string, rail: EmailCardRail, id: string) => Promise<CardRead | null>;
  readRef: (tenantId: string, rail: EmailCardRail, id: string) => Promise<string | null>;
  readBulk: (tenantId: string, decisionId: string) => Promise<BulkRead | null>;
  gaProperty: (tenantId: string) => Promise<string | null>;
  winLine: typeof computeWinLine;
  slugTaken: (tenantId: string, slug: string, rail: EmailCardRail, cardId: string) => Promise<boolean>;
  rpc: (tenantId: string, row: ResultRow, input: StartInput) => Promise<{ ok: boolean; created?: boolean; code?: string }>;
  now: () => Date;
};

async function liveReadCard(tenantId: string, rail: EmailCardRail, id: string): Promise<CardRead | null> {
  const db = tenantClient(asTenantId(tenantId));
  if (rail === "channel_actions") {
    const { data, error } = await db.from("channel_actions").select("exec_class, exec_payload, exec_progress, exec_result, executed_at").eq("id", id).maybeSingle();
    if (error) throw new Error("channel_actions read failed");
    const r = data as { exec_class?: string; exec_payload?: Record<string, unknown>; exec_progress?: unknown; exec_result?: unknown; executed_at?: string | null } | null;
    return r
      ? { class: r.exec_class ?? "", body: r.exec_payload ?? {}, progress: r.exec_progress ?? null, ended_at: r.executed_at ?? null, receipt_line: actionExecReceipt(r.exec_class, r.exec_result)?.line ?? null }
      : null;
  }
  const { data, error } = await db.from("decisions").select("decision_class, body, dispatched_at").eq("id", id).maybeSingle();
  if (error) throw new Error("decisions read failed");
  const r = data as { decision_class?: string; body?: Record<string, unknown>; dispatched_at?: string | null } | null;
  return r ? { class: r.decision_class ?? "", body: r.body ?? {}, progress: null, ended_at: r.dispatched_at ?? null } : null;
}

const LIVE: StartDeps = {
  readCard: liveReadCard,
  readRef: async (tenantId, rail, id) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_send_refs").select("provider_ref").eq("rail", rail).eq("card_id", id).maybeSingle();
    if (error) throw new Error("email_send_refs read failed");
    return (data as { provider_ref?: string } | null)?.provider_ref ?? null;
  },
  readBulk: async (tenantId, decisionId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_sends")
      .select("id, status, sent, total, created_at, finished_at")
      .eq("decision_id", decisionId)
      .maybeSingle();
    if (error) throw new Error("email_bulk_sends read failed");
    return (data as BulkRead | null) ?? null;
  },
  gaProperty: async (tenantId) => {
    const { googleAnalyticsCreds } = await import("@/services/tools/google-analytics/_client");
    for (let attempt = 1; ; attempt++) {
      try {
        return (await googleAnalyticsCreds(tenantId)).property_id || null;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "google_analytics_not_connected") return null;
        if (attempt < 2) continue;
        if (!code || code === "google_analytics_unavailable") throw e;
        console.warn(`[email-results] GA property not read for ${tenantId}, starting without it: ${(e as Error).message}`);
        return null;
      }
    }
  },
  winLine: computeWinLine,
  slugTaken: async (tenantId, slug, rail, cardId) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_send_results").select("rail, card_id").eq("campaign_slug", slug).limit(2);
    if (error) throw new Error("email_send_results read failed");
    return ((data ?? []) as Array<{ rail: string; card_id: string }>).some((r) => !(r.rail === rail && r.card_id === cardId));
  },
  rpc: async (tenantId, row, input) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "start_email_send_result", { p_rail: input.rail, p_card_id: input.card_id, p_row: row });
    if (error) throw new Error("start_email_send_result failed");
    return data as { ok: boolean; created?: boolean; code?: string };
  },
  now: () => new Date(),
};

export function providerGroup(route: ResultRow["route"], tenantId: string, account: Record<string, unknown> | null): string {
  if (route === "zavi_list") return `zavi_list:${tenantId}`;
  if (account?.kind === "composio" && typeof account.connected_account_id === "string") {
    const config = typeof account.auth_config_id === "string" && account.auth_config_id ? `:${account.auth_config_id}` : "";
    return `${route}:${account.connected_account_id}${config}`.slice(0, 200);
  }
  if (account?.kind === "sendgrid_key" && typeof account.key_digest === "string") return `sendgrid:${account.key_digest.slice(0, 32)}`;
  return `${route}:${tenantId}`;
}

export function legacyProviderGroup(key: string): string | null {
  const m = /^(mailchimp|klaviyo):([^:]+):[^:]+$/.exec(key);
  return m ? `${m[1]}:${m[2]}` : null;
}

export function rowFromCard(
  input: StartInput,
  card: CardRead,
  ref: string | null,
  bulk: BulkRead | null,
  now: Date,
): { ok: true; row: Omit<ResultRow, "ga_property_id" | "win_line"> } | { ok: false; reason: string } {
  const slugOf = (b: Record<string, unknown>) => {
    const s = (b.template_snapshot as { campaign_slug?: unknown } | undefined)?.campaign_slug;
    return typeof s === "string" && s ? s : null;
  };
  if (card.class === "bulk_outbound.send") {
    const b = bulkOutboundSendBody.safeParse(card.body);
    if (!b.success || !Array.isArray(b.data.variants)) return { ok: false, reason: "not_a_versions_card" };
    if (!bulk) return { ok: false, reason: "no_send" };
    const n = b.data.chosen_variant ?? 1;
    const subject = b.data.variants[n - 1]?.content.subject ?? "";
    const sent = bulk.sent;
    if (!(sent > 0)) return { ok: false, reason: "nothing_sent" };
    return {
      ok: true,
      row: {
        route: "zavi_list",
        provider_ref: bulk.id,
        account_ref: null,
        campaign_title: null,
        list_id: b.data.list_id,
        list_name: b.data.list_name,
        subject,
        campaign_slug: slugOf(card.body),
        sent_count: sent,
        total_count: bulk.status === "done" ? null : (bulk.total ?? input.total ?? null),
        started_at: bulk.created_at,
        finished_at: bulk.finished_at ?? now.toISOString(),
        provider_group: providerGroup("zavi_list", input.tenant_id, null),
      },
    };
  }
  const b = parseEmailSendBody(card.body);
  if (!b || !Array.isArray(b.variants)) return { ok: false, reason: "not_a_versions_card" };
  const campaignId = toExecProgress(card.progress)?.campaign_id ?? ref;
  if (!campaignId) return { ok: false, reason: "no_campaign_id" };
  const cred = sealedCredentialOf(b) as Record<string, unknown> | null;
  const subject = cardSubject(b);
  const receipt = card.receipt_line?.match(/^(?:Sent to|(?:SendGrid|Mailchimp|Klaviyo) accepted this send for(?: a list of)?) ([\d,]+) /);
  const receiptSent = receipt ? Number(receipt[1].replace(/,/g, "")) : 0;
  const sent = input.sent && input.sent > 0 ? input.sent : receiptSent > 0 ? receiptSent : (b.approved_count ?? b.audience_count);
  const ended = card.ended_at ?? now.toISOString();
  return {
    ok: true,
    row: {
      route: b.tool,
      provider_ref: campaignId,
      account_ref: cred,
      campaign_title: campaignTitleFor(input.card_id, subject),
      list_id: b.audience_id,
      list_name: b.audience_name,
      subject,
      campaign_slug: slugOf(card.body),
      sent_count: sent,
      total_count: input.total ?? null,
      started_at: ended,
      finished_at: ended,
      provider_group: providerGroup(b.tool, input.tenant_id, cred),
    },
  };
}

export type StartOutcome = { started: boolean; reason?: string };

export async function startEmailSendResult(input: StartInput, depsIn: Partial<StartDeps> = {}): Promise<StartOutcome> {
  const deps = { ...LIVE, ...depsIn };
  const card = await deps.readCard(input.tenant_id, input.rail, input.card_id);
  if (!card) return { started: false, reason: "no_card" };
  const isBulk = card.class === "bulk_outbound.send";
  const hasProgress = input.rail === "channel_actions" && toExecProgress(card.progress) !== null;
  const ref = isBulk || hasProgress ? null : await deps.readRef(input.tenant_id, input.rail, input.card_id);
  const bulk = isBulk ? await deps.readBulk(input.tenant_id, input.card_id) : null;
  const base = rowFromCard(input, card, ref, bulk, deps.now());
  if (!base.ok) return { started: false, reason: base.reason };
  const slug = base.row.campaign_slug;
  const ownTag = slug !== null && !(await deps.slugTaken(input.tenant_id, slug, input.rail, input.card_id));
  const gaProperty = slug ? await deps.gaProperty(input.tenant_id) : null;
  const win_line = await deps.winLine(input.tenant_id, {
    route: base.row.route,
    listId: base.row.list_id,
    tagged: ownTag,
    gaConnected: gaProperty !== null,
  });
  const out = await deps.rpc(input.tenant_id, { ...base.row, ga_property_id: gaProperty, win_line }, input);
  return out.ok ? { started: out.created === true } : { started: false, reason: out.code ?? "refused" };
}
