
import { decideOnDecision } from "@/services/approvals/decide-service";

const EXCLUDED_CLASS_PREFIXES: readonly string[] = [
  "meta_ads.",
  "google_ads.",
  "stripe.",
  "browser.",
  "composio.",
];

const EXCLUDED_CLASS_SLUGS: ReadonlySet<string> = new Set([
  "send_email",
  "refund_stripe",
  "outbound.send",
  "fundraising.outbound.send",
  "social.publish",
  "social.publish.v2",
]);

const EXCLUDED_HANDLERS: ReadonlySet<string> = new Set([
  "email.send",
  "gmail.send",
  "outbound.send",
  "fundraising.outbound.send",
  "social.publish",
  "social.publish.v2",
  "stripe.refund",
  "stripe.create_connected_account",
  "stripe.submit_dispute_evidence",
  "browser.action",
  "composio.execute_tool",
]);

export function isBulkApprovable(d: {
  decision_class: string | null;
  handler: string | null;
  autonomy_at_emit?: string | null;
  never_auto?: boolean | null;
}): { ok: boolean; reason?: string } {
  const cls = d.decision_class ?? "";
  if (d.autonomy_at_emit === "forbidden") {
    return { ok: false, reason: "forbidden_class" };
  }
  if (d.never_auto === true) {
    return { ok: false, reason: "never_auto_class" };
  }
  for (const p of EXCLUDED_CLASS_PREFIXES) {
    if (cls.startsWith(p)) return { ok: false, reason: "money_or_customer_facing_class" };
  }
  if (EXCLUDED_CLASS_SLUGS.has(cls)) {
    return { ok: false, reason: "money_or_customer_facing_class" };
  }
  if (d.handler && EXCLUDED_HANDLERS.has(d.handler)) {
    return { ok: false, reason: "money_or_customer_facing_handler" };
  }
  return { ok: true };
}

export type BatchRowResult =
  | { decision_id: string; outcome: "approved" | "rejected"; changed: boolean }
  | { decision_id: string; outcome: "skipped"; reason: string }
  | { decision_id: string; outcome: "error"; reason: string };

export type BatchDecideResult = {
  total: number;
  approved?: number;
  rejected?: number;
  skipped: number;
  errored: number;
  results: BatchRowResult[];
  aborted?: { reason: string };
};

export type DecisionMeta = {
  decision_class: string | null;
  handler: string | null;
  autonomy_at_emit: string | null;
  never_auto: boolean | null;
};

export function neverAutoSlugSet(rows: Array<{ slug?: unknown }>): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    if (typeof row.slug === "string") set.add(row.slug);
  }
  return set;
}

export type DecisionMetaLoader = (
  ids: string[],
) => Promise<
  | { ok: true; meta: Map<string, DecisionMeta> }
  | { ok: false; error: string }
>;

export type RejectCapture = (decision_id: string) => Promise<void>;

export async function rejectBatch(args: {
  decision_ids: string[];
  tenant_id: string;
  actor_user_id: string;
  captureReject?: RejectCapture;
}): Promise<BatchDecideResult> {
  const { decision_ids, tenant_id, actor_user_id, captureReject } = args;
  const results: BatchRowResult[] = [];
  let rejected = 0;
  let errored = 0;
  for (const decision_id of decision_ids) {
    const r = await decideOnDecision({
      decision_id,
      tenant_id,
      action: "reject",
      actor: { user_id: actor_user_id },
    });
    if (r.ok) {
      rejected++;
      results.push({ decision_id, outcome: "rejected", changed: r.changed });
      if (r.changed && captureReject) {
        try {
          await captureReject(decision_id);
        } catch {
        }
      }
    } else {
      errored++;
      results.push({ decision_id, outcome: "error", reason: r.code });
    }
  }
  return { total: decision_ids.length, rejected, skipped: 0, errored, results };
}

export async function approveBatch(args: {
  decision_ids: string[];
  tenant_id: string;
  actor_user_id: string;
  loadMeta: DecisionMetaLoader;
}): Promise<BatchDecideResult> {
  const { decision_ids, tenant_id, actor_user_id, loadMeta } = args;

  const loaded = await loadMeta(decision_ids);
  if (!loaded.ok) {
    return {
      total: decision_ids.length,
      approved: 0,
      skipped: 0,
      errored: 0,
      results: [],
      aborted: { reason: `meta_lookup_failed: ${loaded.error}` },
    };
  }
  const meta = loaded.meta;
  const results: BatchRowResult[] = [];
  let approved = 0;
  let skipped = 0;
  let errored = 0;

  for (const decision_id of decision_ids) {
    const m = meta.get(decision_id);
    if (!m || !m.decision_class) {
      skipped++;
      results.push({ decision_id, outcome: "skipped", reason: "unresolved_class" });
      continue;
    }
    const elig = isBulkApprovable(m);
    if (!elig.ok) {
      skipped++;
      results.push({ decision_id, outcome: "skipped", reason: elig.reason ?? "excluded" });
      continue;
    }
    const r = await decideOnDecision({
      decision_id,
      tenant_id,
      action: "approve",
      actor: { user_id: actor_user_id },
    });
    if (r.ok) {
      approved++;
      results.push({ decision_id, outcome: "approved", changed: r.changed });
    } else {
      errored++;
      results.push({ decision_id, outcome: "error", reason: r.code });
    }
  }
  return { total: decision_ids.length, approved, skipped, errored, results };
}
