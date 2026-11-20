
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { rationaleOptional } from "@/services/tools/_shared/rationale";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { learningsReadForRun, type LearningsRead } from "@/services/email-learnings/note";
import { isNoWriteEmitError } from "@/services/agents/emit-no-write";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId } from "@/services/tenant-client";
import { accountCall, credentialFor, resolveEmailTool, type EmailToolAccount } from "@/services/connectors/email-campaign/account";
import { EMAIL_ADDRESS, EMAIL_SEND_CLASS } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, EmailToolError, type Audience, type EmailTool, type ProviderCall } from "@/services/connectors/email-campaign/providers";
import { EmailRenderError, RENDERER_VERSION, type EmailContent, type EmailRoute, type EmailTemplate } from "@/services/email-templates/render";
import { getEmailTemplate, saveEmailTemplate } from "@/services/email-templates/store";
import { draftTemplateFromBrand } from "@/services/email-templates/draft-from-brand";
import { campaignSlugFor, emailContentSchema, newSlugSuffix, oneLineField, readTestListKeys, resealVariant, sealedVariantSchema, sealVariants, templateSnapshotSchema, TEST_LIST_REFUSAL, testListKey } from "@/services/email-cards/variants";
import { BULK_COHORT_HARD_CAP, resolveCohort, type CohortSource } from "@/services/comms/bulk-outbound/cohort";
import { makeListCohortSource } from "@/services/comms/bulk-outbound/list-source";
import { listSummaries, type ListSummary } from "@/services/comms/bulk-outbound/lists";
import { checkBulkSender, readEmailSettingText } from "@/services/comms/bulk-outbound/readiness";
import { resolveBulkReplyTo } from "@/services/comms/bulk-outbound/reply-to";
import { maskAddress } from "@/services/comms/bulk-outbound/mask";
import { planRefusal } from "@/services/email-plan/messages";
import { copyCardEmails, latestRedraftId } from "@/services/channels/card-context";
import type { RecipeStepDecisionBody } from "@/agents/lib/channel-recipe-step";

export const BULK_SEND_CLASS = "bulk_outbound.send";

const ROUTES = ["sendgrid", "mailchimp", "klaviyo", "zavi_list"] as const;

const CONTENT_FIELDS = ["subject", "preview_text", "title", "hero", "paragraphs", "button", "cards"] as const;

const inputSchema = z.object({
  route: z
    .enum(ROUTES)
    .describe("Where it goes out: the founder's SendGrid, Mailchimp or Klaviyo, or zavi_list for a contact list Zavi keeps."),
  audience_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "audience_id must be a bare list id")
    .optional()
    .describe("SendGrid, Mailchimp or Klaviyo: the list id from email_campaign__list_audiences."),
  list_id: z.string().uuid().optional().describe("zavi_list: the list id from outbound__list_email_lists."),
  variants: z
    .array(emailContentSchema.partial())
    .min(1)
    .max(3)
    .describe(
      "1 to 3 versions of the same email, each a different angle. Content only, never HTML: subject, preview_text, title, " +
        "optional hero {big, small}, paragraphs, one button {label, url (https)}, optional cards (real items from the " +
        "workspace's own data only).",
    ),
  rationale: rationaleOptional().describe(
    "Why this email, to this list, now, in plain words shown on the card to the founder, who is \"you\": never write \"the founder\". Never mention runs, reads, pages checked, tools or your instructions.",
  ),
  replaces: z
    .object({ rail: z.enum(["channel_actions", "decisions"]), id: z.string().uuid() })
    .optional()
    .describe(
      "A redraft: the email card this one replaces, closed if nobody approved it yet. Needs changes.",
    ),
  changes: z
    .array(z.enum(CONTENT_FIELDS))
    .min(1)
    .max(CONTENT_FIELDS.length)
    .optional()
    .describe(
      "With replaces: only the fields the founder asked to change. Every other field is kept word for word from the same version of that card, whatever a version gives for it, so a version may give only these.",
    ),
  from_name: oneLineField("sender name", 0, 100).optional().describe("Email tool routes only: the sender name. Leave out to use the tool's default sender."),
  from_email: z
    .string()
    .max(320)
    .optional()
    .describe("Email tool routes only, and only when the tool has no default sender (it answers email_sender_unknown)."),
});

const copyEditSchema = z.object({
  email: z.number().int().min(1).max(20).optional().describe("Which email in the sequence, counted from 1. Leave out on a card with one email."),
  find: z.string().min(1).max(4000).describe("The exact words to change, copied from email_copy on the card, long enough to appear once in that email."),
  replace: z.string().max(4000).describe("The words that go in their place. Empty removes them."),
});

const callSchema = inputSchema.partial({ route: true, variants: true }).extend({
  edits: z
    .array(copyEditSchema)
    .min(1)
    .max(20)
    .optional()
    .describe(
      "A redraft of a copy-and-send email card (one with email_copy): replaces is that card, and every change the founder asked for goes in this one call as find and replace. Route, audience and variants stay out. Everything else on the card is kept byte for byte.",
    ),
});

type Input = z.infer<typeof inputSchema>;
type CallInput = z.infer<typeof callSchema>;
type CopyEdit = z.infer<typeof copyEditSchema>;

export type CopyCardRow = {
  id: string;
  channel_slug: string;
  status: string | null;
  exec_class: string | null;
  exec_status: string | null;
  edited_body: unknown;
  redo_of?: string | null;
  position: number | null;
  run_of: number | null;
  body: unknown;
};

export type CopyRedraftResult = { new_id: string | null; closed: boolean };

const NOT_CHANGED = "Nothing changed on the card, so do not tell the founder it did.";

function copyRefusal(code: string, why: string): ExpectedToolError {
  return new ExpectedToolError(code, `${why} ${NOT_CHANGED}`);
}

function exactlyOnce(text: string, find: string): number {
  return text.split(find).length - 1;
}

function swapOnce(text: string, find: string, replace: string): string {
  const at = text.indexOf(find);
  return `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`;
}

export function applyCopyEdits(body: unknown, edits: readonly CopyEdit[]): { body: Record<string, unknown>; emails: number[] } {
  const card = body as { step: { deliverable: { content?: unknown; parts?: unknown } } };
  const deliverable = card.step.deliverable;
  const emails = copyCardEmails("email_marketing", null, body) ?? [];
  const before = new Map(emails.map((e) => [e.email, e.text]));
  const after = new Map(before);
  for (const edit of edits) {
    const n = edit.email ?? (emails.length === 1 ? 1 : 0);
    if (!n) throw copyRefusal("email_copy_email_required", `This card has ${emails.length} emails, so each edit needs email, counted from 1.`);
    const text = after.get(n);
    if (text === undefined) throw copyRefusal("email_copy_email_missing", `This card has no email ${n}; it has ${emails.length}.`);
    const hits = exactlyOnce(text, edit.find);
    if (hits === 0) throw copyRefusal("email_copy_find_missing", `Email ${n} does not contain that exact text. Copy it from email_copy.`);
    if (hits > 1) throw copyRefusal("email_copy_find_ambiguous", `Email ${n} contains that text ${hits} times. Use a longer run of its words so it appears once.`);
    after.set(n, swapOnce(text, edit.find, edit.replace));
  }
  const changed = [...after].filter(([n, text]) => text !== before.get(n)).map(([n]) => n);
  if (changed.length === 0) throw copyRefusal("email_copy_no_change", "The edits leave every email as it was.");
  let content = deliverable.content;
  for (const n of changed) {
    const old = before.get(n) as string;
    if (typeof content !== "string" || exactlyOnce(content, old) !== 1) {
      throw copyRefusal("email_copy_card_mismatch", "This card's email text does not line up, so it cannot be redrafted from chat. Ask the founder to run the card again.");
    }
    content = swapOnce(content, old, after.get(n) as string);
  }
  let seen = 0;
  const parts = Array.isArray(deliverable.parts)
    ? (deliverable.parts as Array<{ content?: unknown }>).map((p) => {
        if (typeof p?.content !== "string" || !p.content.trim()) return p;
        seen += 1;
        return emails.length >= 2 && changed.includes(seen) ? { ...p, content: after.get(seen) } : p;
      })
    : deliverable.parts;
  const nextDeliverable = { ...deliverable, content, ...(deliverable.parts === undefined ? {} : { parts }) };
  return {
    body: { ...(body as Record<string, unknown>), step: { ...card.step, deliverable: nextDeliverable } },
    emails: changed,
  };
}

async function withOriginalSummary(
  tenantId: string,
  card: CopyCardRow,
  body: Record<string, unknown>,
  deps: Pick<ProposeCampaignDeps, "originalCopyBody">,
): Promise<Record<string, unknown>> {
  if (!card.redo_of) return body;
  let origin: unknown;
  try {
    origin = await deps.originalCopyBody(tenantId, card);
  } catch {
    throw copyRefusal("email_replaced_unreadable", "Zavi could not read the card's first version. Try again.");
  }
  if (!origin) throw copyRefusal("email_replaced_unreadable", "Zavi could not read the card's first version. Try again.");
  const originStep = (origin as { step?: { body?: unknown } } | null)?.step;
  const same = copyCardEmails("email_marketing", null, origin)?.length === copyCardEmails("email_marketing", null, body)?.length;
  const step = (body as { step: Record<string, unknown> }).step;
  if (!same || !originStep || originStep.body === step.body) return body;
  const { body: _carried, ...rest } = step;
  return { ...body, step: typeof originStep.body === "string" ? { ...rest, body: originStep.body } : rest };
}

function refuseUnopenCopyCard(card: CopyCardRow): void {
  if ((card.status !== "pending" && card.status !== "snoozed") || card.exec_status) {
    throw copyRefusal("email_copy_card_closed", `This card is ${card.status ?? "closed"}, so it cannot be redrafted.`);
  }
  if (card.edited_body !== null && card.edited_body !== undefined) {
    throw copyRefusal("email_copy_card_edited", "The founder edited this card by hand, so Zavi leaves it as they wrote it.");
  }
}

const COPY_STEP_UNCHANGED = "Nothing changed on the card. Tell me the exact change and I'll try again.";

export async function redraftCopyCardFromStep(
  tenantId: string,
  runId: string,
  cardId: unknown,
  step: unknown,
  deps: Pick<ProposeCampaignDeps, "copyCard" | "redraftCopy" | "originalCopyBody"> = LIVE_PROPOSE_CAMPAIGN_DEPS,
): Promise<string | null> {
  if (typeof cardId !== "string" || !UUID.test(cardId)) return null;
  const asked = copyCardEmails("email_marketing", null, { step });
  if (!asked) return null;
  let card: CopyCardRow | null;
  try {
    card = await deps.copyCard(tenantId, cardId);
  } catch {
    return COPY_STEP_UNCHANGED;
  }
  const current = card ? copyCardEmails(card.channel_slug, card.exec_class, card.body) : null;
  if (!card || !current || current.length !== asked.length) return null;
  const edits = current.flatMap((e, i) => (e.text.trim() === asked[i].text.trim() ? [] : [{ email: e.email, find: e.text, replace: asked[i].text }]));
  if (edits.length === 0) return COPY_STEP_UNCHANGED;
  try {
    refuseUnopenCopyCard(card);
    const applied = applyCopyEdits(card.body, edits);
    const emails = applied.emails;
    const body = await withOriginalSummary(tenantId, card, applied.body, deps);
    const written = await deps.redraftCopy(tenantId, runId, card, body);
    if (!written.new_id) return COPY_STEP_UNCHANGED;
    const which = `${emails.length === 1 ? "email" : "emails"} ${emails.join(", ")}`;
    return written.closed
      ? `Done. The new card in this channel's Actions list has the change to ${which}, and the old one is closed. Nothing is loaded or sent.`
      : `The new card in this channel's Actions list has the change to ${which}, but the old one could not be closed, so dismiss it. Nothing is loaded or sent.`;
  } catch {
    return COPY_STEP_UNCHANGED;
  }
}

const WHOLE_FIELDS = ["subject", "preview_text", "title", "paragraphs", "button"] as const;

function isWhole(v: Input["variants"][number]): v is EmailContent {
  return WHOLE_FIELDS.every((k) => v[k] !== undefined);
}

const REPLACED_CARD = z.object({
  variants: z.array(sealedVariantSchema).min(1).max(3),
  template_snapshot: templateSnapshotSchema,
});

export type ProposeCampaignDeps = {
  resolveTool: typeof resolveEmailTool;
  callFor: (a: EmailToolAccount) => ProviderCall;
  template: (tenantId: string) => Promise<EmailTemplate | null>;
  draftAndSave: (tenantId: string) => Promise<EmailTemplate>;
  company: (tenantId: string) => Promise<{ name: string | null; website: string | null }>;
  testLists: (tenantId: string) => Promise<ReadonlySet<string>>;
  checkSender: typeof checkBulkSender;
  lists: typeof listSummaries;
  source: (list: { listId: string; versionId: string }) => CohortSource;
  replyTo: (tenantId: string) => Promise<string | null>;
  setting: (tenantId: string, fieldId: string) => Promise<string | null>;
  railOf: (tenantId: string, id: string) => Promise<"channel_actions" | "decisions">;
  replaceCard: (tenantId: string, old: { rail: string; id: string }, fresh: { rail: string; id: string }) => Promise<boolean | ReplaceOutcome>;
  cardBody: (tenantId: string, card: { rail: string; id: string }) => Promise<unknown>;
  copyCard: (tenantId: string, id: string) => Promise<CopyCardRow | null>;
  originalCopyBody: (tenantId: string, card: CopyCardRow) => Promise<unknown | null>;
  redraftCopy: (tenantId: string, runId: string, old: CopyCardRow, body: Record<string, unknown>) => Promise<CopyRedraftResult>;
  runContext: (tenantId: string, runId: string) => Promise<PlanRunContext>;
  attachPlanned: (tenantId: string, a: { item_id: string; version: number; run_id: string; rail: string; id: string }) => Promise<{ ok: boolean; code?: string }>;
  discardPlanned: (tenantId: string, card: { rail: string; id: string }) => Promise<boolean>;
  redraftPlan: (tenantId: string, old: { rail: string; id: string }) => Promise<RedraftPlan | null>;
  rebindPlanned: (tenantId: string, a: { item_id: string; version: number; old: { rail: string; id: string }; rail: string; id: string }) => Promise<{ ok: boolean; code?: string }>;
  now: () => Date;
  reserveCard: (tenantId: string, runId: string | null) => Promise<{ ok: true; id: string } | { ok: false; code: "run_cap" | "tenant_cap"; count: number }>;
  releaseCard: (tenantId: string, id: string) => Promise<void>;
  settleCard: (tenantId: string, id: string, cardId: string) => Promise<void>;
  learningsRead?: (tenantId: string, runId: string | null | undefined) => Promise<LearningsRead | null>;
};

export const EMAIL_CARD_CAP_PER_RUN = 3;
export const EMAIL_CARD_CAP_PER_TENANT_24H = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function liveReserveCard(
  tenantId: string,
  runId: string | null,
): Promise<{ ok: true; id: string } | { ok: false; code: "run_cap" | "tenant_cap"; count: number }> {
  const { tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "reserve_email_card", {
    p_run_id: runId && UUID.test(runId) ? runId : null,
    p_run_cap: EMAIL_CARD_CAP_PER_RUN,
    p_tenant_cap: EMAIL_CARD_CAP_PER_TENANT_24H,
  });
  if (error) throw new Error("reserve_email_card failed");
  const r = (data ?? {}) as { ok?: boolean; id?: string; code?: string; count?: number };
  if (r.ok === true && typeof r.id === "string") return { ok: true, id: r.id };
  if (r.ok === false && (r.code === "run_cap" || r.code === "tenant_cap")) return { ok: false, code: r.code, count: Number(r.count ?? 0) };
  throw new Error(`reserve_email_card refused: ${r.code ?? "unknown"}`);
}

async function reservationRpc(tenantId: string, name: "release_email_card_reservation" | "settle_email_card_reservation", args: Record<string, unknown>): Promise<void> {
  try {
    const { tenantRpc } = await import("@/services/tenant-client");
    const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
    if (error || (data as { ok?: boolean } | null)?.ok !== true) throw new Error(error?.message ?? "refused");
  } catch (e) {
    const { logEvent } = await import("@/services/logging/logEvent");
    void logEvent({
      level: "warn",
      source: "email_propose_campaign",
      code: "email_card_reservation_rpc_failed",
      message: `${name} failed: ${(e as Error).message}. The slot stays counted until it ages out.`,
      tenant_id: tenantId,
    }).catch(() => undefined);
  }
}

async function liveReleaseCard(tenantId: string, id: string): Promise<void> {
  await reservationRpc(tenantId, "release_email_card_reservation", { p_id: id });
}

async function liveSettleCard(tenantId: string, id: string, cardId: string): Promise<void> {
  if (!UUID.test(cardId)) return;
  await reservationRpc(tenantId, "settle_email_card_reservation", { p_id: id, p_card_id: cardId });
}

export type PlanRunContext = {
  found: boolean;
  mode: "weekly_plan" | "planned_draft" | null;
  item_id?: string;
  version?: number;
  stale?: boolean;
  route?: string;
  list_id?: string;
};

type PlanBinding = { item_id: string; version: number; redraft?: CardRef };

export type RedraftPlan = { item_id: string; version: number; status: string; open: boolean };

async function liveRailOf(tenantId: string, id: string): Promise<"channel_actions" | "decisions"> {
  const { tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("channel_actions").select("id").eq("id", id).maybeSingle();
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  return data ? "channel_actions" : "decisions";
}

export type ReplaceOutcome =
  | { replaced: true; instead?: { rail: string; id: string } }
  | { replaced: false; reason: "superseded_by_this" | "closed_by_other" | "closed_unchecked" | "not_found" | "decided"; status?: string | null }
  | { replaced: false; reason: "several_open"; count: number };

type CardRef = { rail: string; id: string };

function replacedBy(body: unknown): boolean {
  return !!(body as { replaced_by?: unknown } | null)?.replaced_by;
}

function pointsAt(body: unknown, fresh: CardRef): boolean {
  const ptr = (body as { replaced_by?: { rail?: unknown; id?: unknown } } | null)?.replaced_by;
  return !!ptr && ptr.id === fresh.id && ptr.rail === fresh.rail;
}

async function liveSupersededByThis(tenantId: string, old: CardRef, fresh: CardRef): Promise<"superseded_by_this" | "closed_by_other" | "decided"> {
  const { tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenantId));
  if (old.rail === "channel_actions") {
    const { data: row, error } = await db
      .from("channel_actions")
      .select("status, exec_status, approved_by, exec_payload")
      .eq("id", old.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error || !row) return "decided";
    const r = row as { status?: string | null; exec_status?: string | null; approved_by?: string | null; exec_payload?: unknown };
    if (r.approved_by || r.exec_status) return "decided";
    if (r.status === "rejected") return pointsAt(r.exec_payload, fresh) ? "superseded_by_this" : replacedBy(r.exec_payload) ? "closed_by_other" : "decided";
    if (r.status !== "stale") return "decided";
    const { data: ev, error: evError } = await db
      .from("channel_action_events")
      .select("id")
      .eq("action_id", old.id)
      .eq("tenant_id", tenantId)
      .eq("event_key", `replaced:${fresh.id}`)
      .limit(1);
    if (evError) return "decided";
    return Array.isArray(ev) && ev.length > 0 ? "superseded_by_this" : "closed_by_other";
  }
  const { data: row, error } = await db.from("decisions").select("status, approved_by, body").eq("id", old.id).eq("tenant_id", tenantId).maybeSingle();
  if (error || !row) return "decided";
  const d = row as { status?: string | null; approved_by?: string | null; body?: unknown };
  if (d.approved_by) return "decided";
  if (d.status !== "rejected") return "decided";
  return pointsAt(d.body, fresh) ? "superseded_by_this" : replacedBy(d.body) ? "closed_by_other" : "decided";
}

type CardTarget = { audience_id: string; tool: string | null } | { list_id: string };

function targetOf(body: unknown): CardTarget | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.audience_id === "string" && b.audience_id) return { audience_id: b.audience_id, tool: typeof b.tool === "string" ? b.tool : null };
  if (typeof b.list_id === "string" && b.list_id) return { list_id: b.list_id };
  return null;
}

async function liveCardBody(tenantId: string, card: CardRef): Promise<unknown> {
  const { tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenantId));
  if (card.rail === "channel_actions") {
    const { data, error } = await db.from("channel_actions").select("exec_payload").eq("id", card.id).eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new Error(`channel_actions read failed: ${error.message}`);
    return (data as { exec_payload?: unknown } | null)?.exec_payload ?? null;
  }
  const { data, error } = await db.from("decisions").select("body").eq("id", card.id).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error(`decisions read failed: ${error.message}`);
  return (data as { body?: unknown } | null)?.body ?? null;
}

async function liveCopyCard(tenantId: string, id: string): Promise<CopyCardRow | null> {
  const { tenantClient } = await import("@/services/tenant-client");
  const current = await latestRedraftId(tenantId, id);
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id, channel_slug, status, exec_class, exec_status, edited_body, redo_of, position, run_of, body")
    .eq("id", current)
    .maybeSingle();
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  return (data as CopyCardRow | null) ?? null;
}

const ORIGIN_HOPS = 10;

async function liveOriginalCopyBody(tenantId: string, card: CopyCardRow): Promise<unknown | null> {
  const { tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenantId));
  let at: string | null | undefined = card.redo_of;
  let origin: unknown = null;
  for (let hop = 0; at && hop < ORIGIN_HOPS; hop++) {
    const { data, error } = await db.from("channel_actions").select("id, redo_of, body").eq("id", at).maybeSingle();
    if (error) throw new Error(`channel_actions read failed: ${error.message}`);
    const row = data as { redo_of?: string | null; body: unknown } | null;
    if (!row) break;
    origin = row.body;
    at = row.redo_of;
  }
  return origin;
}

const CARRIED_FIGURES = { ledgerIsEmpty: () => false, figureWasRead: () => true };

async function liveRedraftCopy(tenantId: string, runId: string, old: CopyCardRow, body: Record<string, unknown>): Promise<CopyRedraftResult> {
  const { healChatRunStamp } = await import("@/services/channels/direct-run");
  const { recordChannelRunActions } = await import("@/services/channels/channel-actions");
  const stamped = await healChatRunStamp(tenantId, runId);
  if (stamped !== old.channel_slug) throw new Error(`chat run not stamped for ${old.channel_slug}`);
  const recorded = await recordChannelRunActions(
    {
      tenantId,
      runId,
      channelSlug: old.channel_slug,
      envelope: null,
      bodies: [body as RecipeStepDecisionBody],
      redo: { redo_of_action_id: old.id, origin_position: old.position, origin_of: old.run_of, note: "Changed from chat." },
    },
    { ledger: CARRIED_FIGURES as never },
  );
  return { new_id: recorded.inserted > 0 ? (recorded.ids[0]?.id ?? null) : null, closed: recorded.redone };
}

async function liveRedraftPlan(tenantId: string, old: CardRef): Promise<RedraftPlan | null> {
  const { tenantClient, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "email_planned_for_card", { p_rail: old.rail, p_card_id: old.id });
  if (error) throw new Error("email_planned_for_card failed");
  const item = data as { id: string; status: string; content_version: number } | null;
  if (!item) return null;
  const db = tenantClient(asTenantId(tenantId));
  if (old.rail === "channel_actions") {
    const row = await db.from("channel_actions").select("status, exec_status, approved_by").eq("id", old.id).eq("tenant_id", tenantId).maybeSingle();
    if (row.error) throw new Error(`channel_actions read failed: ${row.error.message}`);
    const c = row.data as { status?: string; exec_status?: string | null; approved_by?: string | null } | null;
    const open = !!c && (c.status === "pending" || c.status === "snoozed") && c.exec_status == null && c.approved_by == null;
    return { item_id: item.id, version: item.content_version, status: item.status, open };
  }
  const row = await db.from("decisions").select("status, approved_by").eq("id", old.id).eq("tenant_id", tenantId).maybeSingle();
  if (row.error) throw new Error(`decisions read failed: ${row.error.message}`);
  const c = row.data as { status?: string; approved_by?: string | null } | null;
  return { item_id: item.id, version: item.content_version, status: item.status, open: !!c && c.status === "proposed" && c.approved_by == null };
}

async function liveOpenCardsFor(tenantId: string, target: CardTarget): Promise<CardRef[]> {
  const { tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenantId));
  const keys: Array<[string, string]> =
    "list_id" in target ? [["list_id", target.list_id]] : [["audience_id", target.audience_id], ...(target.tool ? [["tool", target.tool] as [string, string]] : [])];
  let ca = db
    .from("channel_actions")
    .select("id, exec_payload")
    .eq("tenant_id", tenantId)
    .eq("exec_class", EMAIL_SEND_CLASS)
    .in("status", ["pending", "snoozed"])
    .is("exec_status", null)
    .is("approved_by", null);
  for (const [k, val] of keys) ca = ca.eq(`exec_payload->>${k}`, val);
  let dec = db
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenantId)
    .in("decision_class", [EMAIL_SEND_CLASS, BULK_SEND_CLASS])
    .eq("status", "proposed")
    .is("approved_by", null);
  for (const [k, val] of keys) dec = dec.eq(`body->>${k}`, val);
  const [caRes, decRes] = await Promise.all([ca.limit(20), dec.limit(20)]);
  if (caRes.error) throw new Error(`channel_actions read failed: ${caRes.error.message}`);
  if (decRes.error) throw new Error(`decisions read failed: ${decRes.error.message}`);
  const unplanned = (body: unknown) => !(body as { planned_send_id?: unknown } | null)?.planned_send_id;
  return [
    ...((caRes.data ?? []) as Array<{ id: string; exec_payload?: unknown }>).filter((r) => unplanned(r.exec_payload)).map((r) => ({ rail: "channel_actions", id: r.id })),
    ...((decRes.data ?? []) as Array<{ id: string; body?: unknown }>).filter((r) => unplanned(r.body)).map((r) => ({ rail: "decisions", id: r.id })),
  ];
}

async function liveReplaceOpenTwin(tenantId: string, old: CardRef, fresh: CardRef): Promise<ReplaceOutcome | null> {
  const targets = [targetOf(await liveCardBody(tenantId, old)), targetOf(await liveCardBody(tenantId, fresh))].filter((t): t is CardTarget => t !== null);
  const open = new Map<string, CardRef>();
  for (const t of targets) {
    for (const c of await liveOpenCardsFor(tenantId, t)) if (c.id !== fresh.id && !(c.rail === old.rail && c.id === old.id)) open.set(`${c.rail}:${c.id}`, c);
  }
  if (open.size === 0) return null;
  if (open.size > 1) return { replaced: false, reason: "several_open", count: open.size };
  const twin = [...open.values()][0];
  const { tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "replace_email_card", {
    p_rail: twin.rail,
    p_id: twin.id,
    p_new_rail: fresh.rail,
    p_new_id: fresh.id,
  });
  if (error) throw new Error("replace_email_card failed");
  return (data as { replaced?: boolean } | null)?.replaced === true ? { replaced: true, instead: twin } : null;
}

async function closedOrTwin(tenantId: string, old: CardRef, fresh: CardRef, closed: ReplaceOutcome): Promise<ReplaceOutcome> {
  try {
    return (await liveReplaceOpenTwin(tenantId, old, fresh)) ?? closed;
  } catch {
    return closed.replaced === false && closed.reason === "closed_by_other" ? { ...closed, reason: "closed_unchecked" } : closed;
  }
}

async function liveReplaceCard(tenantId: string, old: CardRef, fresh: CardRef): Promise<ReplaceOutcome> {
  const { tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "replace_email_card", {
    p_rail: old.rail,
    p_id: old.id,
    p_new_rail: fresh.rail,
    p_new_id: fresh.id,
  });
  if (error) throw new Error("replace_email_card failed");
  const r = (data ?? {}) as { ok?: boolean; replaced?: boolean; code?: string; status?: string | null };
  if (r.replaced === true) return { replaced: true };
  if (r.ok === false && r.code === "not_found") return closedOrTwin(tenantId, old, fresh, { replaced: false, reason: "not_found" });
  const status = r.status ?? null;
  const closedWithoutDecision = status === null || status === "stale" || status === "rejected";
  if (!closedWithoutDecision) return { replaced: false, reason: "decided", status };
  const reason = await liveSupersededByThis(tenantId, old, fresh).catch(() => "decided" as const);
  if (reason === "closed_by_other") return closedOrTwin(tenantId, old, fresh, { replaced: false, reason, status });
  return { replaced: false, reason, status };
}

export function keptNote(kept: readonly string[]): string {
  if (kept.length === 0) return "";
  return ` Kept ${kept.join(", ")} word for word from the card it replaces, because changes did not list ${kept.length === 1 ? "it" : "them"}. Do not tell the founder ${kept.length === 1 ? "it" : "they"} changed.`;
}

export function replaceNote(outcome: boolean | ReplaceOutcome): { replaced: boolean; note: string } {
  const o: ReplaceOutcome = typeof outcome === "boolean" ? (outcome ? { replaced: true } : { replaced: false, reason: "decided" }) : outcome;
  if (o.replaced && o.instead) {
    return { replaced: true, note: " The card named as the previous draft was already closed, so Zavi closed the draft for this list that was still open instead." };
  }
  if (o.replaced) return { replaced: true, note: " The previous draft is closed." };
  switch (o.reason) {
    case "superseded_by_this":
      return { replaced: true, note: " The previous draft is closed." };
    case "several_open":
      return {
        replaced: false,
        note: ` The card named as the previous draft was already closed, and ${o.count} other drafts for this list are still open, so none of them was closed. Ask the founder which one this replaces.`,
      };
    case "closed_by_other":
      return { replaced: false, note: " The previous draft was already closed, and no other draft for this list is open, so nothing else was closed." };
    case "closed_unchecked":
      return { replaced: false, note: " The previous draft was already closed. Zavi could not check whether another draft for this list is still open, so tell the founder to check the lane." };
    case "not_found":
      return { replaced: false, note: " The previous card was not found, so nothing else was closed." };
    default:
      return { replaced: false, note: " The previous card was already decided, so it was left as it is." };
  }
}

async function liveCompany(tenantId: string): Promise<{ name: string | null; website: string | null }> {
  const { getCompanyFacts } = await import("@/services/company/facts");
  const f = await getCompanyFacts(tenantId);
  return { name: f.nameIsWorkspaceLabel ? null : f.name, website: f.website };
}

async function planRpc<T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

export const LIVE_PROPOSE_CAMPAIGN_DEPS: ProposeCampaignDeps = {
  resolveTool: resolveEmailTool,
  callFor: (a) => accountCall(a),
  template: (tenantId) => getEmailTemplate(asTenantId(tenantId)),
  draftAndSave: async (tenantId) => {
    const { company_name: _name, ...draft } = await draftTemplateFromBrand(tenantId);
    return saveEmailTemplate(asTenantId(tenantId), null, draft);
  },
  company: liveCompany,
  testLists: readTestListKeys,
  checkSender: checkBulkSender,
  lists: listSummaries,
  source: makeListCohortSource,
  replyTo: resolveBulkReplyTo,
  setting: readEmailSettingText,
  railOf: liveRailOf,
  replaceCard: liveReplaceCard,
  cardBody: liveCardBody,
  copyCard: liveCopyCard,
  originalCopyBody: liveOriginalCopyBody,
  redraftCopy: liveRedraftCopy,
  runContext: (tenantId, runId) => planRpc<PlanRunContext>(tenantId, "email_plan_run_context", { p_run_id: runId }),
  attachPlanned: (tenantId, a) =>
    planRpc(tenantId, "attach_email_planned_card", { p_id: a.item_id, p_version: a.version, p_run_id: a.run_id, p_rail: a.rail, p_card_id: a.id }),
  discardPlanned: async (tenantId, card) => (await planRpc<boolean>(tenantId, "discard_email_planned_card", { p_rail: card.rail, p_id: card.id })) === true,
  redraftPlan: liveRedraftPlan,
  rebindPlanned: (tenantId, a) =>
    planRpc(tenantId, "rebind_email_planned_card", { p_id: a.item_id, p_version: a.version, p_old_rail: a.old.rail, p_old_id: a.old.id, p_new_rail: a.rail, p_new_id: a.id }),
  now: () => new Date(),
  reserveCard: liveReserveCard,
  releaseCard: liveReleaseCard,
  settleCard: liveSettleCard,
};

export function hostOf(website: string | null): string | null {
  if (!website?.trim()) return null;
  const raw = website.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

function proposedNote(people: number, listName: string, versions: number): string {
  return (
    `Proposed for approval with ${versions} ${versions === 1 ? "version" : "versions"}. Nothing has been sent. An owner or admin ` +
    `picks a version, sends themselves a test, and approves; then it goes to ${people.toLocaleString("en-US")} ` +
    `${people === 1 ? "person" : "people"} on "${listName}". Tell the founder it is waiting for them. Do not say it was sent.`
  );
}

export function makeProposeCampaignTool(depsIn: Partial<ProposeCampaignDeps> = {}): ToolSpec<CallInput, Record<string, unknown>> {
  const deps: ProposeCampaignDeps = { ...LIVE_PROPOSE_CAMPAIGN_DEPS, ...depsIn };

  async function redraftCopyCard(ctx: ToolContext, call: CallInput) {
    const old = call.replaces;
    if (!old || old.rail !== "channel_actions") {
      throw copyRefusal("email_copy_replaces_missing", "edits needs replaces: the card's rail channel_actions and its id.");
    }
    if (ctx.run_trigger !== "chat" || ctx.chat_answer_turn || ctx.writes_suppressed || !ctx.run_id) {
      throw copyRefusal("email_copy_not_this_run", "A copy-and-send card is redrafted only on a founder's chat turn that asked for the change.");
    }
    let card: CopyCardRow | null;
    try {
      card = await deps.copyCard(ctx.tenant_id, old.id);
    } catch {
      throw copyRefusal("email_replaced_unreadable", "Zavi could not read the card. Try again.");
    }
    if (!card || !copyCardEmails(card.channel_slug, card.exec_class, card.body)) {
      throw copyRefusal("email_replaced_not_found", "That is not a copy-and-send email card in this workspace.");
    }
    refuseUnopenCopyCard(card);
    const applied = applyCopyEdits(card.body, call.edits ?? []);
    const emails = applied.emails;
    const body = await withOriginalSummary(ctx.tenant_id, card, applied.body, deps);
    let written: CopyRedraftResult;
    try {
      written = await deps.redraftCopy(ctx.tenant_id, ctx.run_id, card, body);
    } catch {
      throw copyRefusal("email_copy_not_saved", "Zavi could not save the new draft. Try again.");
    }
    if (!written.new_id) throw copyRefusal("email_copy_not_saved", "Zavi did not save a new draft. Put every change in one call; a second redraft in the same turn is not saved.");
    return {
      action_id: written.new_id,
      card: { rail: "channel_actions", id: written.new_id },
      status: "draft_replaced",
      emails_changed: emails,
      replaced_previous: written.closed,
      note: written.closed
        ? "The new draft is saved and the old card is closed. Only the words you named changed, and it is not loaded or sent anywhere. You may tell the founder the change is on the new card in the channel's Actions list, which is not in this chat. Do not also reply with steps."
        : "The new draft is saved, but the old card could not be closed, so both are on the lane. Tell the founder to dismiss the old one. Do not also reply with steps.",
    };
  }

  async function sealKept(tenantId: string, route: EmailRoute, args: Input) {
    const old = args.replaces;
    if (!old) return null;
    const asked = new Set<string>(args.changes ?? []);
    if (WHOLE_FIELDS.every((f) => asked.has(f)) && args.variants.every(isWhole)) return null;
    let raw: unknown;
    try {
      raw = await deps.cardBody(tenantId, old);
    } catch {
      throw new ExpectedToolError("email_replaced_unreadable", "Zavi could not read the card this replaces, so it could not keep its fields. Try again, or write every field of each version. Nothing was proposed.");
    }
    const parsed = REPLACED_CARD.safeParse(raw);
    if (!parsed.success) {
      throw new ExpectedToolError("email_replaced_not_found", "The card this replaces is not an email card in this workspace, so no field could be kept from it. Write every field of each version, or use edits if it is a copy-and-send card. Nothing was proposed.");
    }
    const kept = new Set<string>();
    const removed = (["hero", "cards"] as const).filter((f) => asked.has(f) && args.variants.every((v) => v[f] === undefined));
    const removeOnly = args.variants.every((v) => Object.values(v).every((value) => value === undefined));
    const contents = args.variants.map((v, i): EmailContent => {
      const base = parsed.data.variants[i]?.content as Record<string, unknown> | undefined;
      if (!base && isWhole(v)) return v;
      if (!base) {
        throw new ExpectedToolError("email_replaced_version_missing", `The card this replaces has no version ${i + 1} to keep fields from. Write every field of that version. Nothing was proposed.`);
      }
      const next: Record<string, unknown> = { ...base };
      for (const [f, value] of Object.entries(v)) {
        if (value === undefined) continue;
        if (asked.has(f)) next[f] = value;
        else if (!isDeepStrictEqual(value, base[f])) kept.add(f);
      }
      if (removeOnly || Object.values(v).some((value) => value !== undefined)) for (const f of removed) delete next[f];
      const merged = emailContentSchema.safeParse(next);
      if (!merged.success) throw new ExpectedToolError("email_content_invalid", `Version ${i + 1}: ${merged.error.issues[0]?.message ?? "a field is not valid"}. Nothing was proposed.`);
      return merged.data as EmailContent;
    });
    const snapshot = { ...parsed.data.template_snapshot, campaign_slug: campaignSlugFor(contents[0].subject, deps.now(), newSlugSuffix()) };
    try {
      return { variants: contents.map((c) => resealVariant(snapshot, route, c)), template_snapshot: snapshot, renderer_version: RENDERER_VERSION, kept: [...kept] };
    } catch (e) {
      if (e instanceof EmailRenderError) throw new ExpectedToolError(`email_render_${e.code}`, `${e.message} Nothing was proposed.`);
      throw e;
    }
  }

  async function seal(tenantId: string, route: EmailRoute, args: Input) {
    const redraft = await sealKept(tenantId, route, args);
    if (redraft) return redraft;
    const variants = args.variants as EmailContent[];
    let template = await deps.template(tenantId);
    if (!template) {
      try {
        template = await deps.draftAndSave(tenantId);
      } catch {
        throw new ExpectedToolError(
          "email_template_missing",
          "This workspace has no saved email template, and Zavi could not draft one from the brand. The founder saves one in Email campaigns settings. Nothing was proposed.",
        );
      }
    }
    const company = await deps.company(tenantId).catch(() => ({ name: null, website: null }));
    try {
      return { ...sealVariants(template, variants, { route, companyName: company.name, ownHost: hostOf(company.website), now: deps.now() }), kept: [] as string[] };
    } catch (e) {
      if (e instanceof EmailRenderError) throw new ExpectedToolError(`email_render_${e.code}`, `${e.message} Nothing was proposed.`);
      throw e;
    }
  }

  async function refuseTestList(tenantId: string, key: string): Promise<void> {
    let marked: ReadonlySet<string>;
    try {
      marked = await deps.testLists(tenantId);
    } catch {
      throw new ExpectedToolError("email_test_lists_unreadable", "Zavi could not check the founder's test lists, so nothing was proposed. Try again.");
    }
    if (marked.has(key)) throw new ExpectedToolError("email_test_list", TEST_LIST_REFUSAL.replace("Nothing was sent.", "Nothing was proposed."));
  }

  async function pinnedSendgridSender(tenantId: string, call: ProviderCall): Promise<{ id: string; email: string; name: string | null } | null> {
    let id: string | null;
    try {
      id = await deps.setting(tenantId, "sendgrid_sender_id");
    } catch {
      throw new ExpectedToolError("email_settings_unreadable", "Zavi could not read the sender picked in Email campaigns settings, so nothing was proposed. Try again in a minute.");
    }
    if (!id) return null;
    const r = await call("SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } });
    if (!r.ok) throw new ExpectedToolError("email_tool_read_failed", "SendGrid could not be read just now, so the sender picked in Email campaigns settings could not be checked. Nothing was proposed. Try again in a minute.");
    const rows = r.ok && Array.isArray((r.data as { results?: unknown } | null)?.results) ? ((r.data as { results: Array<Record<string, unknown>> }).results) : [];
    const s = rows.find((x) => String(x.id) === id && x.verified === true && typeof x.from_email === "string");
    if (!s) {
      throw new ExpectedToolError("email_sender_unknown", "The sender picked in Email campaigns settings is no longer a verified sender in SendGrid. Pick another one there. Nothing was proposed.");
    }
    return { id, email: String(s.from_email).toLowerCase(), name: typeof s.from_name === "string" && s.from_name.trim() ? s.from_name.trim() : null };
  }

  async function pinnedSendgridGroup(tenantId: string, call: ProviderCall): Promise<string | null> {
    let id: string | null;
    try {
      id = await deps.setting(tenantId, "sendgrid_suppression_group_id");
    } catch {
      throw new ExpectedToolError("email_settings_unreadable", "Zavi could not read the unsubscribe group picked in Email campaigns settings, so nothing was proposed. Try again in a minute.");
    }
    if (!id) return null;
    const r = await call("SENDGRID_SUPPRESSION_GROUPS", {});
    if (!r.ok) throw new ExpectedToolError("email_tool_read_failed", "SendGrid could not be read just now, so the unsubscribe group picked in Email campaigns settings could not be checked. Nothing was proposed. Try again in a minute.");
    const rows = r.ok && Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
    if (!rows.some((g) => String(g.id) === id)) {
      throw new ExpectedToolError("email_sender_unknown", "The unsubscribe group picked in Email campaigns settings is no longer in SendGrid. Pick another one there. Nothing was proposed.");
    }
    return id;
  }

  async function defaultSendgridGroup(call: ProviderCall): Promise<string> {
    const r = await call("SENDGRID_SUPPRESSION_GROUPS", {});
    if (!r.ok) throw new EmailToolError("SendGrid could not be read just now", false);
    const def = (Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : []).filter((g) => g.is_default === true);
    if (def.length !== 1) throw new EmailToolError("no unsubscribe group is picked for SendGrid, and the account has no single default one", false);
    return String(def[0].id);
  }

  async function proposeToTool(ctx: ToolContext, args: Input, tool: EmailTool, plan: PlanBinding | null) {
    if (!args.audience_id || args.list_id) {
      throw new ExpectedToolError("email_list_required", "For SendGrid, Mailchimp or Klaviyo, name the list with audience_id (and no list_id).");
    }
    const resolved = await deps.resolveTool(ctx.tenant_id, tool);
    const call = deps.callFor(resolved);
    const label = EMAIL_TOOL_LABEL[tool];
    await refuseTestList(ctx.tenant_id, testListKey(tool, args.audience_id));
    let audience: Audience | null;
    try {
      audience = await EMAIL_PROVIDERS[tool].getAudience(call, args.audience_id);
    } catch (e) {
      if (e instanceof EmailToolError) throw new ExpectedToolError("email_tool_read_failed", `${label} could not be read: ${e.message}`);
      throw e;
    }
    if (!audience) {
      throw new ExpectedToolError("email_audience_missing", `No list ${args.audience_id} in the connected ${label} account. Read the lists with email_campaign__list_audiences.`);
    }
    if (audience.member_count === null) {
      throw new ExpectedToolError("email_audience_size_unknown", `${label} did not report how many people are on "${audience.name}", so the card cannot show it. Nothing was proposed.`);
    }
    if (audience.member_count === 0) {
      throw new ExpectedToolError("email_audience_empty", `"${audience.name}" has nobody on it in ${label}, so there is nobody to send to.`);
    }
    let fallback: { name: string | null; email: string | null };
    try {
      fallback = await EMAIL_PROVIDERS[tool].defaultSender(call, audience);
    } catch {
      fallback = { name: null, email: null };
    }
    const pinned = tool === "sendgrid" ? await pinnedSendgridSender(ctx.tenant_id, call) : null;
    if (pinned) fallback = { name: pinned.name, email: pinned.email };
    let fromName = (pinned?.name || (tool === "sendgrid" ? fallback.name || args.from_name?.trim() : args.from_name?.trim() || fallback.name) || "").slice(0, 100);
    const fromEmail = (fallback.email || args.from_email?.trim() || "").toLowerCase();
    if (!fromName || !EMAIL_ADDRESS.test(fromEmail)) {
      throw new ExpectedToolError(
        "email_sender_unknown",
        `${label} has no default sender ${fromName ? "address" : "name and address"} for this list. Ask the founder which name and address to send from, then call again with from_name and from_email. Nothing was proposed.`,
      );
    }
    let sendIds: { sender_id: string; suppression_group_id: string } | null = null;
    if (tool === "sendgrid") {
      const group = await pinnedSendgridGroup(ctx.tenant_id, call);
      if (pinned && group) {
        sendIds = { sender_id: pinned.id, suppression_group_id: group };
      } else {
        const resolveIds = EMAIL_PROVIDERS.sendgrid.resolveSendIds;
        if (!resolveIds) throw new ExpectedToolError("email_sender_unknown", `${label} cannot name a sender. Nothing was proposed.`);
        let ids: { sender_id: string; suppression_group_id: string; sender_name?: string | null };
        try {
          ids = pinned ? { sender_id: pinned.id, suppression_group_id: await defaultSendgridGroup(call) } : await resolveIds(call, fromEmail, group);
        } catch (e) {
          if (!(e instanceof EmailToolError)) throw e;
          throw new ExpectedToolError(
            "email_sender_unknown",
            `${label}: ${e.message}. The founder can pick a sender and an unsubscribe group in Email campaigns settings. Nothing was proposed.`,
          );
        }
        sendIds = { sender_id: pinned?.id ?? ids.sender_id, suppression_group_id: group ?? ids.suppression_group_id };
        if (!pinned && ids.sender_name) fromName = ids.sender_name.slice(0, 100);
      }
    }
    const { kept, ...sealed } = await seal(ctx.tenant_id, tool, args);
    const body = {
      tool,
      credential: credentialFor(resolved),
      audience_id: audience.id,
      audience_name: audience.name.slice(0, 300),
      audience_count: audience.member_count,
      from_name: fromName,
      from_email: fromEmail,
      reply_to: null,
      ...(sendIds ? { sendgrid_sender_id: sendIds.sender_id, sendgrid_suppression_group_id: sendIds.suppression_group_id } : {}),
      ...sealed,
      rationale: args.rationale?.trim() ? args.rationale : null,
      ...(await learningsFor(ctx)),
      ...(plan ? { planned_send_id: plan.item_id, plan_version: plan.version } : {}),
    };
    const action_id = await ctx.emit_decision!(EMAIL_SEND_CLASS, body);
    return {
      action_id,
      status: "waiting_for_founder",
      route: tool,
      audience: { id: audience.id, name: audience.name, member_count: audience.member_count },
      versions: sealed.variants.length,
      note: `${proposedNote(audience.member_count, audience.name, sealed.variants.length)}${keptNote(kept)}`,
    };
  }

  async function learningsFor(ctx: ToolContext): Promise<{ learnings_read?: LearningsRead }> {
    const read = await (deps.learningsRead ?? learningsReadForRun)(ctx.tenant_id, ctx.run_id).catch((): LearningsRead => ({ status: "snapshot_failed", items: [] }));
    return read ? { learnings_read: read } : {};
  }

  async function proposeToZaviList(ctx: ToolContext, args: Input, plan: PlanBinding | null) {
    if (!args.list_id || args.audience_id) {
      throw new ExpectedToolError("email_list_required", "For zavi_list, name the list with list_id from outbound__list_email_lists (and no audience_id).");
    }
    if (args.from_name || args.from_email) {
      throw new ExpectedToolError("email_sender_fixed", "A Zavi list always sends from the workspace's verified sending address. Leave out from_name and from_email.");
    }
    const sender = await deps.checkSender(ctx.tenant_id);
    if (!sender.ok) throw new ExpectedToolError(sender.code, `${sender.sentence} Nothing was proposed. Tell the founder exactly this, in these words, without any error code or field name.`);
    const lists = await deps.lists(ctx.tenant_id);
    const list: ListSummary | undefined = lists.find((l) => l.id === args.list_id);
    if (!list) {
      throw new ExpectedToolError("list_not_found", "No contact list with that id in this workspace. Read the lists with outbound__list_email_lists.");
    }
    await refuseTestList(ctx.tenant_id, testListKey("zavi_list", list.id));
    if (!list.active || (list.needs_consent && !plan)) {
      throw new ExpectedToolError(
        "list_not_consented",
        `The list "${list.name}" cannot be emailed yet: nobody has confirmed that the people on its latest import agreed to hear from the business. The founder confirms that in Email campaigns settings.`,
      );
    }
    if (list.active.sendable === 0) {
      throw new ExpectedToolError("list_empty", `There is nobody on "${list.name}" who can be emailed. Do not invent recipients.`);
    }
    const cohort = await resolveCohort(ctx.tenant_id, { segment: list.name }, "opt_in", deps.source({ listId: list.id, versionId: list.active.id }));
    if (cohort.est_recipient_count === 0) {
      throw new ExpectedToolError("list_empty", `There is nobody on "${list.name}" who can be emailed. Do not invent recipients.`);
    }
    const { kept, ...sealed } = await seal(ctx.tenant_id, "zavi_list", args);
    const replyTo = await deps.replyTo(ctx.tenant_id).catch(() => {
      throw new ExpectedToolError("bulk_check_failed", "Zavi could not check where replies to this email go, so nothing was proposed. Try again in a minute.");
    });
    const body = {
      list_id: list.id,
      list_version_id: list.active.id,
      list_name: list.name,
      from_address: sender.sender.from_address,
      reply_to: replyTo,
      est_recipient_count: cohort.est_recipient_count,
      list_source: list.active.source_kind,
      sample_recipients:
        list.active.source_kind === "database" ? cohort.sample_recipients.map((e) => maskAddress(e) ?? "•••") : cohort.sample_recipients,
      ...(list.active.unsubscribed_or_bounced > 0 ? { will_be_skipped: list.active.unsubscribed_or_bounced } : {}),
      ...(cohort.capped ? { capped_at: BULK_COHORT_HARD_CAP } : {}),
      ...sealed,
      rationale: args.rationale?.trim() ? args.rationale : null,
      ...(await learningsFor(ctx)),
      ...(plan ? { planned_send_id: plan.item_id, plan_version: plan.version } : {}),
    };
    const decision_id = await ctx.emit_decision!(BULK_SEND_CLASS, body);
    return {
      action_id: decision_id,
      status: "waiting_for_founder",
      route: "zavi_list",
      list: { id: list.id, name: list.name, people: cohort.est_recipient_count },
      from_address: sender.sender.from_address,
      versions: sealed.variants.length,
      note: `${proposedNote(cohort.est_recipient_count, list.name, sealed.variants.length)}${keptNote(kept)}`,
    };
  }

  async function planBinding(ctx: ToolContext, args: Input): Promise<PlanBinding | null> {
    if (!ctx.run_id) return null;
    let rc: PlanRunContext;
    try {
      rc = await deps.runContext(ctx.tenant_id, ctx.run_id);
    } catch {
      throw new ExpectedToolError("plan_unreadable", `${planRefusal("plan_unreadable")} Nothing was proposed.`);
    }
    if (rc.mode === "weekly_plan") throw new ExpectedToolError("plan_run_plans_only", planRefusal("plan_run_plans_only"));
    if (rc.mode !== "planned_draft") return null;
    if (rc.stale || !rc.item_id || typeof rc.version !== "number") {
      throw new ExpectedToolError("email_plan_changed", `${planRefusal("plan_changed")} Nothing was proposed.`);
    }
    const listId = args.route === "zavi_list" ? args.list_id?.toLowerCase() : args.audience_id;
    const planned = rc.route === "zavi_list" ? rc.list_id?.toLowerCase() : rc.list_id;
    if (args.route !== rc.route || !listId || listId !== planned) {
      throw new ExpectedToolError("email_wrong_list", `${planRefusal("wrong_list")} Nothing was proposed.`);
    }
    if (args.replaces) {
      throw new ExpectedToolError("email_plan_no_replace", "A planned draft is a new card for its planned email; it does not replace another. Nothing was proposed.");
    }
    return { item_id: rc.item_id, version: rc.version };
  }

  async function redraftBinding(ctx: ToolContext, args: Input): Promise<PlanBinding | null> {
    if (!args.replaces) return null;
    let found: RedraftPlan | null;
    try {
      found = await deps.redraftPlan(ctx.tenant_id, args.replaces);
    } catch {
      throw new ExpectedToolError("plan_unreadable", `${planRefusal("plan_unreadable")} Nothing was proposed.`);
    }
    if (!found?.open) return null;
    if (found.status === "scheduled") throw new ExpectedToolError("email_plan_scheduled", `${planRefusal("redraft_scheduled")} Nothing was proposed.`);
    return ["ready", "skipped", "blocked"].includes(found.status) ? { item_id: found.item_id, version: found.version, redraft: args.replaces } : null;
  }

  return {
    name: "email_propose_campaign",
    effect: "write",
    description:
      "Propose ONE email to ONE list, in 1 to 3 versions, on one approval card. route is the founder's SendGrid, Mailchimp or Klaviyo " +
      "(audience_id from email_campaign__list_audiences) or zavi_list (list_id from outbound__list_email_lists). Write content, never HTML: " +
      "Zavi renders each version in the workspace's saved email template with the postal address and unsubscribe link, and seals it. " +
      "A redraft (replaces) keeps the old card's template and must list the changed fields in changes. " +
      "A card with email_copy is a copy-and-send card: redraft it with replaces and edits, never by writing the emails out again. " +
      "Nothing is sent until an owner or admin picks a version, sends themselves a test and approves. Say a send happened only after the card " +
      "reports it. Refuses a list marked as a test list, and a list nobody can be emailed on. With no saved template, Zavi drafts one from the brand and saves it first.",
    input_schema: callSchema,
    async execute(ctx, input) {
      const call = callSchema.parse(input);
      if (call.edits) return redraftCopyCard(ctx, call);
      const whole = inputSchema.safeParse(call);
      if (!whole.success) {
        throw new ExpectedToolError(
          "email_route_required",
          "route and variants are required, except for a redraft of a copy-and-send card, which takes replaces and edits. Nothing was proposed.",
        );
      }
      const args = whole.data;
      if (typeof ctx.emit_decision !== "function") {
        throw new ExpectedToolError(
          "email_campaign_propose_unavailable",
          "This run cannot file an approval card, so nothing was proposed. Write the email as a draft for the founder instead.",
        );
      }
      if (!args.replaces && !args.variants.every(isWhole)) {
        throw new ExpectedToolError(
          "email_content_incomplete",
          "Each version needs subject, preview_text, title, paragraphs and button. Only a redraft (replaces) may leave fields out to keep them from the card it replaces. Nothing was proposed.",
        );
      }
      const runPlan = await planBinding(ctx, args);
      if (args.replaces && !args.changes?.length) {
        throw new ExpectedToolError(
          "email_redraft_changes_missing",
          "A redraft needs changes: the fields the founder asked to change, such as [\"subject\"]. Every other field is kept from the card it replaces. Nothing was proposed.",
        );
      }
      const plan = runPlan ?? (await redraftBinding(ctx, args));
      let reserved: Awaited<ReturnType<ProposeCampaignDeps["reserveCard"]>>;
      try {
        reserved = await deps.reserveCard(ctx.tenant_id, ctx.run_id ?? null);
      } catch {
        throw new ExpectedToolError(
          "email_card_count_unavailable",
          "Zavi could not check how many email cards were already filed, so nothing was proposed. Stop here and tell the founder what you wanted to send.",
        );
      }
      if (!reserved.ok) {
        throw new ExpectedToolError(
          "email_card_cap_reached",
          reserved.code === "run_cap"
            ? `This run already filed ${reserved.count} email cards, the most one run may file. Nothing was proposed. Stop proposing emails and summarise for the founder what is waiting on them.`
            : `This workspace already has ${reserved.count} email cards from the last 24 hours, the most allowed. Nothing was proposed. Stop proposing emails and summarise for the founder what is waiting on them.`,
        );
      }
      let emitted = false;
      let emitRefused = false;
      const run = ctx.emit_decision as NonNullable<ToolContext["emit_decision"]>;
      const tracked: ToolContext = {
        ...ctx,
        emit_decision: async (cls: string, body: unknown) => {
          emitted = true;
          try {
            return await run(cls, body);
          } catch (e) {
            if (isNoWriteEmitError(e)) emitRefused = true;
            throw e;
          }
        },
      };
      let filed: Awaited<ReturnType<typeof proposeToTool>> | Awaited<ReturnType<typeof proposeToZaviList>>;
      try {
        filed = args.route === "zavi_list" ? await proposeToZaviList(tracked, args, plan) : await proposeToTool(tracked, args, args.route, plan);
      } catch (e) {
        if (!emitted || emitRefused) await deps.releaseCard(ctx.tenant_id, reserved.id).catch(() => undefined);
        throw e;
      }
      await deps.settleCard(ctx.tenant_id, reserved.id, String(filed.action_id)).catch(() => undefined);
      const id = String(filed.action_id);
      const rail = args.route === "zavi_list" ? "decisions" : await deps.railOf(ctx.tenant_id, id).catch(() => deps.railOf(ctx.tenant_id, id)).catch(() => "decisions" as const);
      if (plan) {
        const old = plan.redraft;
        const link = () =>
          old
            ? deps.rebindPlanned(ctx.tenant_id, { item_id: plan.item_id, version: plan.version, old, rail, id })
            : deps.attachPlanned(ctx.tenant_id, { item_id: plan.item_id, version: plan.version, run_id: ctx.run_id!, rail, id });
        const attached = await link().catch(() => link()).catch(() => ({ ok: false, code: "plan_unreadable" }));
        if (!attached.ok) {
          let closed = false;
          for (let i = 0; i < 2 && !closed; i++) closed = await deps.discardPlanned(ctx.tenant_id, { rail, id }).catch(() => false);
          const code = attached.code === "wrong_list" ? "wrong_list" : "plan_changed";
          throw new ExpectedToolError(
            `email_${code}`,
            closed
              ? `${planRefusal(code)} Nothing was proposed.`
              : `${planRefusal(code)} A card was filed, and Zavi could not confirm whether it was closed or linked to the planned email. Tell the founder to check Coming up before approving anything.`,
          );
        }
        return {
          ...filed,
          card: { rail, id },
          planned: true,
          ...(old ? { replaced_previous: true } : {}),
          note: `${filed.note.replace(/ Tell the founder it is waiting for them\..*$/, "")}${old ? " The previous draft is closed." : ""} It is planned: it goes at its planned time only if an owner or admin approves it for that time, or Auto send allows it. Do not say it was sent.`,
        };
      }
      const out = { ...filed, card: { rail, id } };
      if (!args.replaces) return out;
      try {
        const r = replaceNote(await deps.replaceCard(ctx.tenant_id, args.replaces, { rail, id }));
        return { ...out, replaced_previous: r.replaced, note: `${out.note}${r.note}` };
      } catch {
        return { ...out, replaced_previous: false, note: `${out.note} The previous draft could not be closed; it is still open.` };
      }
    },
  };
}

export const emailProposeCampaignTool = makeProposeCampaignTool();
