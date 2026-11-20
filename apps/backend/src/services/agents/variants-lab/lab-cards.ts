
import type { SupabaseClient } from "@supabase/supabase-js";
import { actionsStoreFor } from "@zavi/shared";
import {
  channelRecipeStepEnvelopeSchema,
  hasRecipeSteps,
  stepDecisionBodies,
  type RecipeStepDecisionBody,
} from "@/agents/lib/channel-recipe-step";
import {
  loadScoreContext,
  overCapLoserIds,
  projectChannelPanel,
  recordChannelRunActions,
  type ChannelRedoTarget,
  type PanelRow,
  type RecordDeps,
  type StagedPost,
} from "@/services/channels/channel-actions";
import { asTenantId, type tenantRpc } from "@/services/tenant-client";

export type LabCard = {
  id: string | null;
  title: string;
  new: boolean;
  action_type: string | null;
  score: number | null;
  body: string | null;
  how_to: string[] | null;
  deliverable_label: string | null;
  deliverable: string | null;
};

export type LabCards = {
  store: "channel_actions" | "decisions";
  cards: LabCard[];
  more: number;
  retired: string[];
  displaced: string[];
  open_before: number;
  writer?: {
    inserted: number;
    kept: number;
    coerced: number;
    metrics: number;
    metrics_dropped: number;
    stale_accepted: number;
    stale_dropped: number;
  };
};

export type LabCardOutcome = { ok: true; value: LabCards } | { ok: false; reason: string };

let storeStatus: { ok: boolean; problems: string[] } = { ok: false, problems: ["lab card store not checked yet"] };

export function setLabCardStoreStatus(s: { ok: boolean; problems: string[] }): void {
  storeStatus = { ok: s.ok, problems: [...s.problems] };
}

export function labCardStoreStatus(): { ok: boolean; problems: string[] } {
  return storeStatus;
}

export async function checkLabCardStore(sb: SupabaseClient): Promise<{ ok: boolean; problems: string[] }> {
  const { data, error } = await sb.rpc("lab_card_parity");
  if (error) return { ok: false, problems: [`lab_card_parity failed: ${error.message}`] };
  const d = (data ?? {}) as { ok?: unknown; problems?: unknown };
  const problems = Array.isArray(d.problems) ? d.problems.map(String) : ["lab_card_parity returned no problems list"];
  return { ok: d.ok === true && problems.length === 0, problems };
}

let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function fromStepBody(b: unknown, fallbackTitle: string): Omit<LabCard, "id" | "new" | "action_type" | "score"> {
  const step = (b && typeof b === "object" ? (b as { step?: unknown }).step : null) as Record<string, unknown> | null;
  const deliverable = (step?.deliverable ?? null) as Record<string, unknown> | null;
  return {
    title: text(step?.title) ?? fallbackTitle,
    body: text(step?.body),
    how_to: Array.isArray(step?.how_to) ? (step!.how_to as unknown[]).map(String) : null,
    deliverable_label: text(deliverable?.label),
    deliverable: text(deliverable?.content),
  };
}

export type LabCardDeps = {
  record?: typeof recordChannelRunActions;
  loadScoreContext?: typeof loadScoreContext;
  recordDeps?: RecordDeps;
};

export async function labChannelCards(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    channelSlug: string;
    runId: string;
    sourceRunId: string;
    envelope: unknown;
    proposals?: ReadonlyArray<{ tool: string; input: string }>;
    payload?: unknown;
  },
  deps: LabCardDeps = {},
): Promise<LabCardOutcome> {
  const parsed = channelRecipeStepEnvelopeSchema.safeParse(args.envelope);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `schema_invalid: ${issue ? `${issue.path.join(".")} ${issue.message}` : "envelope"}` };
  }
  if (!hasRecipeSteps(parsed.data)) return { ok: false, reason: "no_steps" };
  const bodies: RecipeStepDecisionBody[] = stepDecisionBodies(parsed.data);

  if (actionsStoreFor(args.channelSlug) !== "channel_actions") {
    return {
      ok: true,
      value: {
        store: "decisions",
        cards: bodies.map((b) => ({
          id: null,
          new: true,
          action_type: null,
          score: null,
          ...fromStepBody(b, b.step.title),
        })),
        more: 0,
        retired: [],
        displaced: [],
        open_before: 0,
      },
    };
  }
  if (!storeStatus.ok) return { ok: false, reason: `lab_store_out_of_date: ${storeStatus.problems.join("; ")}` };

  return serialized(async () => {
    try {
      const seed = await sb.rpc("lab_card_seed", {
        p_tenant_id: args.tenantId,
        p_channel: args.channelSlug,
        p_run_id: args.runId,
        p_source_run_id: args.sourceRunId,
      });
      if (seed.error) return { ok: false, reason: `lab seed failed: ${seed.error.message}` };
      const before = await openRows(sb, args.tenantId, args.channelSlug);

      const labRpc = ((tid: string, name: string, rpcArgs: Record<string, unknown> = {}) =>
        name === "record_channel_run_actions"
          ? sb.rpc("lab_record_channel_run_actions", { ...rpcArgs, p_tenant_id: tid })
          : Promise.resolve({ data: null, error: { message: `variants lab: ${name} not run` } })) as unknown as typeof tenantRpc;
      const redo = labRedoOf(args.payload);
      const recorded = await (deps.record ?? recordChannelRunActions)(
        {
          tenantId: args.tenantId,
          runId: args.runId,
          channelSlug: args.channelSlug,
          envelope: parsed.data,
          bodies,
          redo,
        },
        {
          ...deps.recordDeps,
          rpc: labRpc,
          stagedPosts: async () => stagedFromProposals(args.proposals ?? []),
          log: async () => undefined,
          track: () => undefined,
          displace: async () => 0,
        },
      );

      const redone = redo?.redo_of_action_id ?? null;
      const afterAll = await openRows(sb, args.tenantId, args.channelSlug);
      const ctx = await (deps.loadScoreContext ?? loadScoreContext)(asTenantId(args.tenantId), args.channelSlug);
      const nowMs = Date.now();
      const kept = afterAll.filter((r) => r.id !== redone);
      const losers = new Set(
        overCapLoserIds(args.channelSlug, args.runId, projectChannelPanel(args.channelSlug, kept, ctx, { nowMs, all: true }).actions),
      );
      const after = kept.filter((r) => !losers.has(r.id));
      const panel = projectChannelPanel(args.channelSlug, after, ctx, { nowMs });
      const stillOpen = new Set(afterAll.map((r) => r.id));
      const rec = (recorded ?? {}) as Partial<{
        inserted: number;
        kept: unknown[];
        coerced: number;
        metrics: number;
        metrics_dropped: number;
        stale_accepted: number;
        stale_dropped: number;
      }>;
      return {
        ok: true,
        value: {
          store: "channel_actions",
          cards: panel.actions.map((a) => ({
            id: a.id,
            new: a.run_id === args.runId,
            action_type: a.action_type,
            score: a.score,
            ...fromStepBody(a.body, a.title),
            title: a.title,
          })),
          more: panel.more,
          retired: before.filter((r) => !stillOpen.has(r.id) || r.id === redone).map((r) => r.title),
          displaced: kept.filter((r) => losers.has(r.id)).map((r) => r.title),
          open_before: before.length,
          writer: {
            inserted: Number(rec.inserted ?? 0),
            kept: Array.isArray(rec.kept) ? rec.kept.length : 0,
            coerced: Number(rec.coerced ?? 0),
            metrics: Number(rec.metrics ?? 0),
            metrics_dropped: Number(rec.metrics_dropped ?? 0),
            stale_accepted: Number(rec.stale_accepted ?? 0),
            stale_dropped: Number(rec.stale_dropped ?? 0),
          },
        },
      };
    } catch (e) {
      return { ok: false, reason: `lab card step failed: ${(e as Error).message}` };
    } finally {
      const clear = await sb.rpc("lab_card_clear");
      if (clear.error) console.warn(`[variants-lab] lab_card_clear failed: ${clear.error.message}`);
    }
  });
}

async function openRows(sb: SupabaseClient, tenantId: string, channelSlug: string): Promise<PanelRow[]> {
  const { data, error } = await sb.rpc("lab_open_channel_actions", { p_tenant_id: tenantId, p_channel: channelSlug });
  if (error) throw new Error(`lab_open_channel_actions failed: ${error.message}`);
  return ((data ?? []) as unknown[]).filter((r): r is PanelRow => !!r && typeof r === "object");
}

export function stagedFromProposals(proposals: ReadonlyArray<{ tool: string; input: string }>): StagedPost[] {
  const out: StagedPost[] = [];
  for (const p of proposals) {
    if (!/(^|__)propose_post$/.test(p.tool)) continue;
    try {
      const v = JSON.parse(p.input) as { channel?: unknown; text?: unknown };
      if (typeof v.channel === "string" && typeof v.text === "string" && v.text.trim()) {
        out.push({ channel: v.channel, text: v.text.trim() });
      }
    } catch {
      const ch = /"channel"\s*:\s*"([a-z0-9_]+)"/.exec(p.input)?.[1];
      const text = /"text"\s*:\s*"([^"]{1,200})/.exec(p.input)?.[1];
      if (ch && text) out.push({ channel: ch, text });
    }
  }
  return out;
}

export function labRedoOf(payload: unknown): ChannelRedoTarget | null {
  const r = payload && typeof payload === "object" ? (payload as { redo?: unknown }).redo : null;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.redo_of_action_id !== "string" || !o.redo_of_action_id) return null;
  return {
    redo_of_action_id: o.redo_of_action_id,
    origin_position: typeof o.origin_position === "number" ? o.origin_position : null,
    origin_of: typeof o.origin_of === "number" ? o.origin_of : null,
    note: typeof o.note === "string" ? o.note : null,
  };
}
