
import { z } from "zod";
import { BULK_COHORT_HARD_CAP } from "./cohort";
import { defaultFanoutDeps, runBulkChunk, type ChunkResult, type FanoutDeps } from "./fanout";
import { bulkSendLine, SENDING_ADDRESS_NOT_VERIFIED, type BulkSendState } from "./notices";
import { BULK_REFUSAL_SENTENCES, type BulkRefusalCode } from "./readiness";
import type { SendCounts } from "./store";
import { hasUnsubscribeSlot } from "./wire";
import { chosenVersion, readTestListKeys, sealedVariantFields, TEST_LIST_REFUSAL, testListKey } from "@/services/email-cards/variants";

export const BULK_OUTBOUND_SEND_GATED_CODE = "bulk_outbound_send_gated";

const template = z.object({
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(50_000),
});

export const bulkOutboundSendBody = z.object({
  list_id: z.string().uuid(),
  list_version_id: z.string().uuid(),
  list_name: z.string().min(1).max(120),
  from_address: z.string().email().max(320),
  reply_to: z.string().email().max(320).nullable().optional(),
  template: template.optional(),
  variants: sealedVariantFields.variants.optional(),
  template_snapshot: sealedVariantFields.template_snapshot.optional(),
  renderer_version: sealedVariantFields.renderer_version.optional(),
  chosen_variant: sealedVariantFields.chosen_variant,
  approved_count: sealedVariantFields.approved_count,
  est_recipient_count: z.number().int().nonnegative().optional(),
  sample_recipients: z.array(z.string()).max(50).optional(),
  will_be_skipped: z.number().int().nonnegative().optional(),
  list_source: z.enum(["csv", "database"]).optional(),
  capped_at: z.number().int().positive().optional(),
});

export type BulkOutboundSendBody = z.infer<typeof bulkOutboundSendBody>;

export function isListSendBody(body: unknown): boolean {
  return !!body && typeof body === "object" && typeof (body as { list_version_id?: unknown }).list_version_id === "string";
}

export type BulkDispatchResult =
  | {
      ok: true;
      send_id: string;
      state: BulkSendState;
      counts: SendCounts;
      line: string;
    }
  | {
      ok: false;
      status: "legacy" | "invalid_body" | "refused" | "failed";
      code: string;
      sentence: string;
    }
  | {
      ok: false;
      status: "held";
      code: "bulk_sending_paused";
      sentence: string;
    }
  | {
      ok: false;
      status: "unconfirmed";
      code: string;
      send_id: string;
      state: "done" | "held";
      counts: SendCounts;
      sentence: string;
    };

export type BulkDispatchDeps = Partial<FanoutDeps> & {
  enqueueFanout?: (sendId: string) => Promise<void>;
  testListKeys?: typeof readTestListKeys;
};

type Frozen = { subject: string; bodyText: string; bodyHtml: string | null; renderSha: string | null };

function contentToFreeze(body: BulkOutboundSendBody): { ok: true; c: Frozen } | { ok: false; code: string; sentence: string } {
  const versions = body.variants !== undefined;
  if (versions === (body.template !== undefined) || (versions && (!body.template_snapshot || !body.renderer_version))) {
    return { ok: false, code: "bulk_outbound_invalid_body", sentence: "This bulk email draft was incomplete. Ask the agent to draft it again." };
  }
  if (!versions) return { ok: true, c: { subject: body.template!.subject, bodyText: body.template!.body_text, bodyHtml: null, renderSha: null } };
  const picked = chosenVersion({ variants: body.variants!, renderer_version: body.renderer_version!, chosen_variant: body.chosen_variant });
  if (!picked.ok) return { ok: false, code: "email_version_not_chosen", sentence: `${picked.reason} Nothing was sent. Open the email in Zavi and approve a version there.` };
  const v = picked.version;
  if (!hasUnsubscribeSlot(v.html, v.text)) {
    return { ok: false, code: "bulk_outbound_invalid_body", sentence: "This email has no unsubscribe link, so Zavi did not send it. Ask the agent to draft it again." };
  }
  return { ok: true, c: { subject: v.subject, bodyText: v.text, bodyHtml: v.html, renderSha: v.render_sha } };
}

function refused(code: string, sentence: string): BulkDispatchResult {
  return { ok: false, status: "refused", code, sentence };
}

const FREEZE_REFUSALS: Record<string, [string, string]> = {
  not_approved: ["not_approved", "This bulk email was not approved by a person."],
  list_archived: ["list_archived", BULK_REFUSAL_SENTENCES.list_archived],
  version_not_consented: ["list_not_consented", BULK_REFUSAL_SENTENCES.list_not_consented],
  abuse_hold: ["bulk_abuse_hold", BULK_REFUSAL_SENTENCES.bulk_abuse_hold],
  error: ["bulk_check_failed", BULK_REFUSAL_SENTENCES.bulk_check_failed],
  list_version_changed: [
    "planned_list_version_changed",
    "Autopilot did not send this planned email: the list was imported again after it was drafted, and the draft is for the earlier import. Nothing was sent. Approve it yourself if it is still right.",
  ],
  audience_over_limit: [
    "planned_audience_over_limit",
    "Autopilot did not send this planned email: the list has more than 1,000 people. Nothing was sent. Approve it yourself if it is still right.",
  ],
};

export async function executeBulkOutboundDispatch(args: {
  tenant_id: string;
  decision_id: string;
  approved_by: string | null | undefined;
  body: unknown;
  deps?: BulkDispatchDeps;
  requireVersions?: boolean;
}): Promise<BulkDispatchResult> {
  if (!args.approved_by) {
    return refused(...FREEZE_REFUSALS.not_approved);
  }
  if (!isListSendBody(args.body)) {
    return {
      ok: false,
      status: "legacy",
      code: BULK_OUTBOUND_SEND_GATED_CODE,
      sentence: "This draft was written before Zavi could send bulk email. Ask the agent to propose it again.",
    };
  }
  const parsed = bulkOutboundSendBody.safeParse(args.body);
  if (!parsed.success) {
    return {
      ok: false,
      status: "invalid_body",
      code: "bulk_outbound_invalid_body",
      sentence: "This bulk email draft was incomplete. Ask the agent to draft it again.",
    };
  }
  const body = parsed.data;
  if (args.requireVersions && body.variants === undefined) {
    return refused("bulk_outbound_redraft_required", "This email was drafted before emails had versions and a test send. Nobody was emailed. Ask Zavi to draft it again.");
  }
  const content = contentToFreeze(body);
  if (!content.ok) {
    return content.code === "bulk_outbound_invalid_body"
      ? { ok: false, status: "invalid_body", code: content.code, sentence: content.sentence }
      : refused(content.code, content.sentence);
  }
  if (content.c.bodyHtml !== null) {
    let marked: ReadonlySet<string>;
    try {
      marked = await (args.deps?.testListKeys ?? readTestListKeys)(args.tenant_id);
    } catch {
      return refused("bulk_check_failed", BULK_REFUSAL_SENTENCES.bulk_check_failed);
    }
    if (marked.has(testListKey("zavi_list", body.list_id))) return refused("email_test_list", TEST_LIST_REFUSAL);
  }
  const given: BulkDispatchDeps = args.deps ?? {};
  const complete = (["store", "wire", "checkReady", "unsubToken", "shutOff", "unverifyDomain", "replyTo"] as const).every((k) => given[k]);
  const deps = (complete ? given : { ...(await defaultFanoutDeps()), ...given }) as FanoutDeps;

  const ready = await deps.checkReady(args.tenant_id, body.list_id, body.list_version_id);
  if (!ready.ok && ready.code === "bulk_sending_paused") return { ok: false, status: "held", code: ready.code, sentence: ready.sentence };
  if (!ready.ok) return refused(ready.code, ready.sentence);
  if (ready.sender.from_address.toLowerCase() !== body.from_address.toLowerCase()) {
    return refused(
      "sending_domain_changed",
      "Your sending address changed after this was approved. Ask the agent to propose it again.",
    );
  }

  let replyTo: string | null;
  try {
    replyTo = (await deps.replyTo(args.tenant_id)) ?? null;
  } catch {
    return refused("bulk_check_failed", BULK_REFUSAL_SENTENCES.bulk_check_failed);
  }
  if ((replyTo ?? "").toLowerCase() !== (body.reply_to ?? "").toLowerCase()) {
    return refused(
      "reply_to_changed",
      "Where replies go changed after this was approved. Ask the agent to propose it again.",
    );
  }

  const frozen = await deps.store.freeze({
    tenantId: args.tenant_id,
    decisionId: args.decision_id,
    listId: body.list_id,
    versionId: body.list_version_id,
    subject: content.c.subject,
    bodyText: content.c.bodyText,
    bodyHtml: content.c.bodyHtml,
    renderSha: content.c.renderSha,
    fromAddress: ready.sender.from_address,
    replyTo,
    cap: BULK_COHORT_HARD_CAP,
  });
  if (!frozen.ok) return refused(...(FREEZE_REFUSALS[frozen.reason] ?? FREEZE_REFUSALS.error));
  if (frozen.total === 0) {
    await deps.store.settleSend(args.tenant_id, frozen.send_id, "done");
    return refused("list_empty", BULK_REFUSAL_SENTENCES.list_empty);
  }

  if (frozen.created && content.c.bodyHtml !== null) {
    let marked: ReadonlySet<string> | null = null;
    try {
      marked = await (args.deps?.testListKeys ?? readTestListKeys)(args.tenant_id);
    } catch {
      marked = null;
    }
    if (marked === null || marked.has(testListKey("zavi_list", body.list_id))) {
      await deps.store.settleSend(args.tenant_id, frozen.send_id, "held", marked === null ? "test_list_check_failed" : "email_test_list");
      return marked === null
        ? refused("bulk_check_failed", BULK_REFUSAL_SENTENCES.bulk_check_failed)
        : refused("email_test_list", TEST_LIST_REFUSAL);
    }
  }

  if (args.deps?.enqueueFanout) await args.deps.enqueueFanout(frozen.send_id);

  let chunk: ChunkResult;
  if (frozen.created) {
    chunk = await runBulkChunk({ tenantId: args.tenant_id, sendId: frozen.send_id }, deps);
  } else {
    const counts = await deps.store.settleSend(args.tenant_id, frozen.send_id, null);
    const state: BulkSendState =
      counts.status === "sending" ? "more" : counts.status === "waiting_for_tomorrow" ? "waiting_for_tomorrow" : counts.status;
    chunk = { state, counts };
  }
  if (chunk.state === "missing") return refused(...FREEZE_REFUSALS.error);
  if (chunk.state === "failed") {
    return { ok: false, status: "failed", code: "bulk_outbound_provider_refused", sentence: bulkSendLine("failed", chunk.counts) };
  }
  if (chunk.state === "held" && chunk.counts.sent === 0 && chunk.counts.hold_reason !== "email_paused") {
    const code = (chunk.counts.hold_reason ?? "bulk_check_failed") as BulkRefusalCode;
    if (chunk.counts.unknown === 0) await deps.store.closeHeldSend(args.tenant_id, frozen.send_id);
    if (chunk.counts.unknown > 0) {
      return { ok: false, status: "unconfirmed", code, send_id: frozen.send_id, state: "held", counts: chunk.counts, sentence: bulkSendLine("held", chunk.counts) };
    }
    if (chunk.counts.hold_reason === "sending_address_not_verified") return refused(chunk.counts.hold_reason, SENDING_ADDRESS_NOT_VERIFIED);
    return refused(code, BULK_REFUSAL_SENTENCES[code] ?? bulkSendLine("held", chunk.counts));
  }
  if (chunk.state === "done" && chunk.counts.sent === 0 && chunk.counts.unknown > 0) {
    return { ok: false, status: "unconfirmed", code: "bulk_outbound_unconfirmed", send_id: frozen.send_id, state: "done", counts: chunk.counts, sentence: bulkSendLine("done", chunk.counts) };
  }
  if (chunk.state === "done" && chunk.counts.sent === 0) {
    return { ok: false, status: "failed", code: "bulk_outbound_nobody_sent", sentence: bulkSendLine("done", chunk.counts) };
  }
  return {
    ok: true,
    send_id: frozen.send_id,
    state: chunk.state,
    counts: chunk.counts,
    line: bulkSendLine(chunk.state, chunk.counts, chunk.days_left, chunk.warming_up),
  };
}
