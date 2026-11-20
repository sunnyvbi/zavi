
import { signActionMedia } from "@/services/channels/action-media";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";
import { servedCardWords, withoutFrozenPeople } from "@/services/channels/channel-actions";
import type { CardKind } from "@/services/channels/card-presentation";
import { adChangeHeadline } from "@zavi/shared";

export type ActionSource = "decision" | "channel_action";

export type ReadableClient = { from: (table: string) => unknown };

type SelectBuilder = {
  select: (columns: string) => {
    eq: (column: string, value: string) => SelectFilter;
  };
};
type SelectFilter = {
  eq: (column: string, value: string) => SelectFilter;
  order: (column: string, opts: { ascending: boolean }) => SelectFilter;
  limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type ChannelActionApprovalRow = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown> | null;
  status: string;
  autonomy_at_emit: string | null;
  handler: string | null;
  emitted_at: string;
  approved_at: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
  channel_slug: string;
  run_group: { run_id: string; position: number; of: number } | null;
  click_allowlistable: false;
  action_source: "channel_action";
  exec_class: string | null;
  exec_status: string | null;
  card_kind: string | null;
  primary_label: string | null;
  done_label: string | null;
  how_to: string[];
  steps_done: number[];
};

export const CHANNEL_ACTION_ROW_COLUMNS =
  "id, channel_slug, run_id, position, run_of, body, status, proposed_at, action_type, exec_class, exec_status, exec_payload, card_kind, primary_label, done_label, how_to, steps_done";

type RawChannelAction = {
  id: string;
  channel_slug: string;
  run_id: string | null;
  position: number | null;
  run_of: number | null;
  body: Record<string, unknown> | null;
  status: string;
  proposed_at: string;
  action_type?: string | null;
  exec_class: string | null;
  exec_status?: string | null;
  exec_payload?: unknown;
  card_kind?: string | null;
  primary_label?: string | null;
  done_label?: string | null;
  how_to?: unknown;
  steps_done?: unknown;
};

function withAdStepTitle(body: Record<string, unknown> | null, exec_class: string | null, exec_payload: unknown): Record<string, unknown> | null {
  const title = exec_class ? adChangeHeadline(exec_class, exec_payload) : null;
  if (!title || !body) return body;
  const step = body.step && typeof body.step === "object" && !Array.isArray(body.step) ? (body.step as Record<string, unknown>) : null;
  return step ? { ...body, step: { ...step, title } } : body;
}

export function toApprovalRow(a: RawChannelAction): ChannelActionApprovalRow {
  return {
    id: a.id,
    agent_run_id: a.run_id ?? null,
    decision_class: "channel.recipe_step",
    body: withoutFrozenPeople(withAdStepTitle(a.body ?? null, a.exec_class, a.exec_payload), a.exec_class),
    status: a.status,
    autonomy_at_emit: "approval",
    handler: null,
    emitted_at: a.proposed_at,
    approved_at: null,
    dispatched_at: null,
    dispatch_error: null,
    channel_slug: a.channel_slug,
    run_group:
      a.run_id && typeof a.position === "number" && typeof a.run_of === "number"
        ? { run_id: a.run_id, position: a.position, of: a.run_of }
        : null,
    click_allowlistable: false,
    action_source: "channel_action",
    exec_class: a.exec_class ?? null,
    exec_status: a.exec_status ?? null,
    ...servedCardWords(a.card_kind as CardKind | null | undefined, a.primary_label, a.done_label, a.how_to, a.action_type ?? "", a.body, a.exec_class),
    steps_done: Array.isArray(a.steps_done) ? a.steps_done.filter((x): x is number => Number.isInteger(x)) : [],
  };
}

export async function readOpenChannelActions(
  sb: ReadableClient,
  tenantId: string,
  channelFilter: string | null,
  limit: number,
): Promise<ChannelActionApprovalRow[]> {
  try {
    let q = (sb.from(OPEN_CHANNEL_ACTIONS_VIEW) as SelectBuilder)
      .select(CHANNEL_ACTION_ROW_COLUMNS)
      .eq("tenant_id", tenantId);
    if (channelFilter) q = q.eq("channel_slug", channelFilter);
    const { data, error } = await q.order("proposed_at", { ascending: false }).limit(limit);
    if (error || !Array.isArray(data)) {
      if (error) {
        console.warn(
          `[approvals] open channel actions read failed for ${tenantId}: ${
            (error as { message?: string }).message ?? String(error)
          }`,
        );
      }
      return [];
    }
    return (await signActionMedia(tenantId, data as RawChannelAction[])).map(toApprovalRow);
  } catch (e) {
    console.warn(`[approvals] open channel actions read threw for ${tenantId}: ${(e as Error).message}`);
    return [];
  }
}

export async function readOpenChannelActionSlugs(
  sb: ReadableClient,
  tenantId: string,
  cap: number,
): Promise<Array<{ channel_slug: string }>> {
  try {
    const { data, error } = await (sb.from(OPEN_CHANNEL_ACTIONS_VIEW) as SelectBuilder)
      .select("channel_slug")
      .eq("tenant_id", tenantId)
      .limit(cap);
    if (error || !Array.isArray(data)) return [];
    return data as Array<{ channel_slug: string }>;
  } catch {
    return [];
  }
}

export function channelActionCounts(
  rows: ReadonlyArray<{ channel_slug: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.channel_slug] = (counts[r.channel_slug] ?? 0) + 1;
  return counts;
}

export function mergeCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [slug, n] of Object.entries(b)) out[slug] = (out[slug] ?? 0) + n;
  return out;
}
