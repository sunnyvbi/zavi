
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { stripReservedRunPayloadKeys } from "@/services/agents/reserved-payload";
import {
  listAgentRuns,
  getAgentRunById,
  enqueueAgentRun,
  AgentNotFoundError,
  BROWSER_OPERATOR_ALLOWED_TRIGGERS,
} from "@/services/agents/runner";
import { listAgents } from "@/services/agents/registry";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { filterPlanEntitledAgents } from "@/services/agents/entitlement";
import { canUserAccessAgent } from "@/services/auth/members";
import { lockedChannelMessageForAgent } from "@/services/channels/lock";
import { serviceClient } from "@/services/supabase";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import { buildRunFetchText } from "@/services/mcp/server/run-fetch-text";
import { MCP_AGENT_CATALOG } from "@/services/mcp/server/agent-catalog";
import { callerHasScope } from "@/services/auth/pat";
import type { McpCaller } from "@/services/auth/oauth/verifier";
import type { AgentRun } from "@/services/agents/types";
import type { TenantId } from "@/services/tenant-client";
import { webBaseUrl } from "@/services/web-base";
import { assistantRefusalForError } from "@/services/mcp/assistant-policy";
import { assistantVisibleRunError } from "@/services/agents/error-body";
import { logEvent } from "@/services/logging/logEvent";
import { tenantClient, tenantRpc } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { isCustomerChannelAction, savedPostDraftSchema, postDraftContentSchema } from "@zavi/shared";
import { DELIVERABLE_KINDS, DELIVERABLE_PARTS_MAX, DELIVERABLE_CONTENT_MAX, LONG_FORM_CONTENT_MAX, TARGET_KINDS } from "@/agents/lib/channel-recipe-step";
import { parseMoveTest } from "@/services/growth/cgo-test-shape";
import { readDueTests } from "@/services/growth/cgo-tests";
import { writeAutopilotGoal } from "@/services/growth/goal-write";
import { syncGoalWork } from "@/services/growth/goal-owner";
import { FOUNDER_ENTERED_SOURCE } from "@/services/autopilot/goal-measurement";
import { recordMetricSnapshot } from "@/services/analytics/record-metric-snapshot";
import { askStartsOnGrowthAgent } from "@/services/mcp/server/ask-route";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

const READ_ONLY: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
function stripAssistantRunMode<T>(slug: string, payload: T): T {
  if (slug !== "cgo" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { stage, ...rest } = payload as Record<string, unknown>;
  return (stage === "own_goals" ? rest : payload) as T;
}

const STARTS_RUN: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const RECORDS: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const SPECS = {
  zavi_list_agents: {
    title: "List Zavi agents",
    annotations: READ_ONLY,
    description: "List the agents visible to your tenant (slug, name, description, can_run).",
    schema: z.object({}),
  },
  zavi_run_agent: {
    title: "Run a Zavi agent",
    annotations: STARTS_RUN,
    description:
      "Start a run of one Zavi agent by its slug, as listed by zavi_list_agents. Returns {run_id} immediately; zavi_get_run_status returns the run's status and result.",
    schema: z.object({
      slug: z.string().min(1).describe("The agent's slug, from zavi_list_agents."),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional input for the agent, as a JSON object."),
    }),
  },
  zavi_ask: {
    title: "Ask Zavi",
    annotations: STARTS_RUN,
    description:
      "Send a question or growth task to Zavi. A growth question goes to Zavi's growth agent; anything else goes to the operator agent, which answers it or hands it to a specialist agent. Waits about 40 seconds and returns the answer if it is ready; otherwise returns {run_id, status: \"running\"}: then call zavi_get_run_status with that run_id straight away, which waits again and returns the result, including a specialist's result after a handoff.",
    schema: z.object({ message: z.string().min(1).describe("The question or task, in plain words.") }),
  },
  zavi_get_run_status: {
    title: "Get run status",
    annotations: READ_ONLY,
    description:
      "Get one agent run by run_id: its status, result text and error. When the run handed off to a specialist agent, returns the specialist's run, with delegated_from set to the run_id you asked for. While the run is still going, waits about 40 seconds for it to finish; if it is still going then, returns {run_id, status: \"running\"}, so call it again.",
    schema: z.object({ run_id: z.string().min(1).describe("The run_id returned when the run started.") }),
  },
  zavi_recent_runs: {
    title: "List recent runs",
    annotations: READ_ONLY,
    description:
      "List your workspace's recent agent runs, newest first: run_id, agent, status and times, without results.",
    schema: z.object({
      limit: z.number().int().min(1).max(50).default(10).describe("How many runs to return."),
      slug: z.string().optional().describe("Only runs of this agent."),
    }),
  },
  zavi_read_brain: {
    title: "Read company brain",
    annotations: READ_ONLY,
    description: "Read your tenant's company-brain memory notes (optional query/slug filter).",
    schema: z.object({
      query: z.string().optional().describe("Words to search the notes for."),
      slug: z.string().optional().describe("Read the one note with this slug."),
      limit: z.number().int().min(1).max(30).default(10).describe("How many notes to return."),
    }),
  },
  zavi_search: {
    title: "Search Zavi workspace",
    annotations: READ_ONLY,
    description:
      "Search your Zavi workspace (company-brain notes + recent agent runs). Returns {results:[{id,title,url}]}.",
    schema: z.object({ query: z.string().min(1).describe("What to search for.") }),
  },
  zavi_fetch: {
    title: "Fetch a search result",
    annotations: READ_ONLY,
    description:
      "Fetch the full content of one search result by its id (note:<id> or run:<id>).",
    schema: z.object({ id: z.string().min(1).describe("A result id from zavi_search, note:<id> or run:<id>.") }),
  },
  zavi_next_step: {
    title: "Get the next growth step",
    annotations: READ_ONLY,
    description:
      "Read your workspace's active goals (target, current number and how old it is), the open growth steps Zavi wants done (what to do, why, and the test behind it), and the tests whose results are due to be read. Each step says done_by \"you\" (a step you or your AI do) or \"zavi\" (a change Zavi makes itself once it is approved in Zavi).",
    schema: z.object({}),
  },
  zavi_mark_step_done: {
    title: "Mark a growth step done",
    annotations: RECORDS,
    description:
      "Record that a step from zavi_next_step was done, and what changed. Zavi counts it as launched for the step's test.",
    schema: z.object({
      action_id: z.string().uuid().describe("The step's action_id, from zavi_next_step."),
      what_changed: z.string().trim().min(1).max(600).describe("What was changed, in plain words."),
      link: z.string().trim().url().max(300).optional().describe("Optional link to the change (a post, a page, a commit)."),
    }),
  },
  zavi_report_number: {
    title: "Report a goal's number",
    annotations: { ...RECORDS, idempotentHint: false },
    description:
      "Save the current number for one goal from zavi_next_step, as given by the founder or read from a tool they connected. Saved as the founder's own number. Refused for a goal Zavi measures from a connected source.",
    schema: z.object({
      goal_id: z.string().uuid().describe("The goal's goal_id, from zavi_next_step."),
      value: z.number().finite().describe("The goal's current number."),
    }),
  },
} as const;

export type ToolName = keyof typeof SPECS;

function zodSchemaToJson(s: z.ZodTypeAny): Tool["inputSchema"] {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;
  return schema as Tool["inputSchema"];
}

export const ZAVI_INBOUND_TOOL_LIST: readonly Tool[] = (Object.keys(SPECS) as ToolName[]).map(
  (name) => {
    const s = SPECS[name];
    return {
      name,
      title: s.title,
      description: s.description,
      inputSchema: zodSchemaToJson(s.schema),
      annotations: { title: s.title, ...s.annotations },
    };
  },
);

const runUrl = (runId: string) => `${webBaseUrl()}/workspace?run=${runId}`;
const noteUrl = (noteId: string) => `${webBaseUrl()}/memory/${encodeURIComponent(noteId)}`;

function runListEntry(run: AgentRun) {
  return {
    run_id: run.id,
    agent_slug: run.agent_slug,
    status: run.status,
    presentation_status: run.presentation_status ?? null,
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
  };
}

function runResult(run: AgentRun): string | null {
  const text = (run.output_text ?? "").trim();
  if (text) return text;
  const parsed = run.parsed;
  const empty = parsed == null || (typeof parsed === "object" && Object.keys(parsed).length === 0);
  return empty ? null : JSON.stringify(parsed, null, 2);
}

function runDetail(run: AgentRun) {
  return {
    ...runListEntry(run),
    result: runResult(run),
    error: run.error == null ? null : assistantVisibleRunError(run.error),
  };
}

async function singleHandoffChildId(tenantId: TenantId, runId: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("parent_run_id", runId)
    .in("trigger", ["mcp", "handoff"])
    .limit(2);
  if (error || !Array.isArray(data)) {
    throw new Error("This run's specialist could not be looked up just now. Call zavi_get_run_status again in a few seconds.");
  }
  if (data.length !== 1) return null;
  const id = (data[0] as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

async function readRunFollowingHandoff(tenantId: TenantId, runId: string) {
  const run = await getAgentRunById(tenantId, runId);
  if (!run) return null;
  const linked = (run.input_payload_raw as { delegated_child_run_id?: unknown } | null)
    ?.delegated_child_run_id;
  const childId =
    typeof linked === "string" && linked ? linked : run.trigger === "mcp" ? await singleHandoffChildId(tenantId, runId) : null;
  if (typeof childId === "string" && childId && childId !== runId) {
    const child = await getAgentRunById(tenantId, childId);
    if (child) return { ...runDetail(child), delegated_from: runId };
  }
  return runDetail(run);
}

export const ZAVI_ASK_WAIT_MS = 40_000;
const ASK_POLL_MS = 1_000;
export const READ_CAP_MS = 5_000;
const STILL_WORKING =
  `Zavi is still working on this; a growth answer can take a few minutes. Call zavi_get_run_status with this run_id now, before you reply: it waits about ${ZAVI_ASK_WAIT_MS / 1000} seconds for the answer. Keep calling it while the status is running. If you have to reply before it finishes, say the answer is still being written and that they can ask you for it in a minute, not that Zavi failed or did not answer. Then call zavi_get_run_status again when they next write.`;
const stillRunning = (runId: string) => ok({ run_id: runId, status: "running", next: STILL_WORKING });

const TIMED_OUT = Symbol("timed out");

async function readBefore<T>(cutoff: number, read: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, cutoff - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readRun(tenantId: TenantId, runId: string, deadline: number, failFast = false) {
  const tries: ReturnType<typeof readRunFollowingHandoff>[] = [];
  for (;;) {
    tries.push(readRunFollowingHandoff(tenantId, runId));
    const first = failFast
      ? Promise.race(tries)
      : Promise.any(tries).catch((e: AggregateError) => {
          throw e.errors[e.errors.length - 1];
        });
    const detail = await readBefore(Math.min(deadline, Date.now() + READ_CAP_MS), first);
    if (detail !== TIMED_OUT) return detail;
    if (Date.now() >= deadline) return TIMED_OUT;
    void logEvent({ level: "warn", source: "zavi-inbound", code: "mcp.wait_read_slow", tenant_id: tenantId, run_id: runId });
  }
}

async function waitForAnswer(tenantId: TenantId, runId: string, deadline: number): Promise<ToolResult> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(ASK_POLL_MS, left)));
    const started = Date.now();
    let detail: Awaited<ReturnType<typeof readRun>>;
    try {
      detail = await readRun(tenantId, runId, deadline);
    } catch (error) {
      void logEvent({
        level: "warn",
        source: "zavi-inbound",
        code: "mcp.wait_read_failed",
        error,
        tenant_id: tenantId,
        run_id: runId,
        meta: { ms: Date.now() - started },
      });
      continue;
    }
    if (detail === TIMED_OUT) break;
    if (!detail) {
      void logEvent({
        level: "warn",
        source: "zavi-inbound",
        code: "mcp.wait_read_missing",
        tenant_id: tenantId,
        run_id: runId,
        meta: { ms: Date.now() - started },
      });
      break;
    }
    if (detail.presentation_status !== "running") return ok(detail);
  }
  return stillRunning(runId);
}

const agentNotFound = (slug: string) => err(`agent ${slug} not found`);

const GROWTH_AGENT_NOT_RUNNABLE = new Set(["AgentNotFoundError", "SafetyGateError", "PlanUpgradeRequiredError"]);
async function startGrowthAnswer(caller: McpCaller, message: string): Promise<string | null> {
  try {
    const { run_id } = await enqueueAgentRun({
      agent_slug: "cgo",
      tenant_id: caller.tenant_id,
      trigger: "mcp",
      payload: {
        intent: message,
        message,
        current_user_text_raw: message,
        user_id: caller.user_id,
        source: "mcp",
        conversation_answer: true,
      },
      actor_user_id: caller.user_id,
    });
    return run_id;
  } catch (e) {
    if (GROWTH_AGENT_NOT_RUNNABLE.has((e as Error)?.name)) return null;
    throw e;
  }
}

function withObjectPayload(rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object") return rawArgs;
  const { payload, ...rest } = rawArgs as { payload?: unknown };
  if (payload === null) return rest;
  if (typeof payload !== "string") return rawArgs;
  if (!payload.trim()) return rest;
  try {
    const decoded: unknown = JSON.parse(payload);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return { ...rest, payload: decoded };
    }
  } catch {
  }
  return { ...rest, payload: { message: payload } };
}

const CGO_MOVE_CLASS = "cgo.dispatch-specialist";
const NEXT_STEP_CARDS = 10;
const NEXT_STEP_GOALS = 10;
const NEXT_STEP_CANDIDATES = 200;
const DAY_MS = 86_400_000;

const NOTHING_OPEN =
  "Nothing is open for you right now. Call zavi_ask and ask Zavi for a growth plan for your goal; it files the next steps, then call zavi_next_step again.";

const short = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

type OpenCardRow = {
  id: string;
  run_id: string | null;
  channel_slug: string;
  title: string;
  step: Record<string, unknown> | null;
  edited_body?: unknown;
  how_to: unknown;
  exec_class: string | null;
  score: number | null;
};

const manualDeliverableSchema = z.object({
  kind: z.enum(DELIVERABLE_KINDS),
  label: z.string().max(80),
  content: z.string().max(LONG_FORM_CONTENT_MAX),
  parts: z.array(z.object({ label: z.string().max(80), content: z.string().max(DELIVERABLE_CONTENT_MAX) }))
    .max(DELIVERABLE_PARTS_MAX).optional(),
});
const manualTargetSchema = z.object({ kind: z.enum(TARGET_KINDS), ref: z.string().max(300) });
const variantTextSchema = postDraftContentSchema.pick({ text: true, thread: true });

function manualStepDetails(c: OpenCardRow) {
  const parsed = manualDeliverableSchema.safeParse(c.step?.deliverable);
  const original = parsed.success ? parsed.data : null;
  const target = manualTargetSchema.safeParse(c.step?.target);
  const saved = savedPostDraftSchema.safeParse(c.edited_body);
  const unavailable = {
    deliverable: null,
    deliverable_note: "The saved draft is empty or unavailable. Review the card in Zavi before using its copy.",
    target: target.success ? target.data : null,
  };
  if (c.edited_body == null) {
    return { deliverable: original, target: target.success ? target.data : null };
  }
  if (!saved.success || !saved.data.text.trim()) {
    return unavailable;
  }
  const edited = saved.data;
  let unreadableVariant = false;
  const parts = original?.kind !== "thread" && original?.parts && original.parts.length >= 2 && edited.variants
    ? original.parts.map((part, i) => {
        const raw = edited.variants?.[String(i)];
        const variant = variantTextSchema.safeParse(raw);
        if (raw !== undefined && !variant.success) unreadableVariant = true;
        return variant.success ? { label: part.label, content: variant.data.text, thread: variant.data.thread } : part;
      })
    : undefined;
  if (unreadableVariant) return unavailable;
  return {
    deliverable: {
      kind: original?.kind ?? "post",
      label: original?.label ?? "Saved draft",
      content: edited.text,
      thread: edited.thread,
      ...(parts ? { parts, variant_index: edited.variant_index } : {}),
      ...(edited.headline !== undefined ? { headline: edited.headline } : {}),
    },
    target: target.success ? target.data : null,
  };
}

function testView(raw: unknown) {
  const t = parseMoveTest(raw);
  if (!t) return null;
  return {
    variable: t.variable,
    baseline: t.baseline,
    success_if: t.success_if,
    stop_if: t.stop_if ?? null,
    readout_on: t.readout_on,
  };
}

async function readCardMoves(tid: TenantId, cards: OpenCardRow[]) {
  const out = new Map<string, { test: ReturnType<typeof testView>; goal_id: string | null }>();
  const runIds = [...new Set(cards.map((c) => c.run_id).filter((x): x is string => !!x))];
  if (runIds.length === 0) return out;
  const db = tenantClient(tid);
  const runs = await db.from("agent_runs").select("id, source_decision_id").eq("tenant_id", tid).in("id", runIds);
  if (runs.error) throw new Error(runs.error.message);
  const moveOfRun = new Map<string, string>();
  for (const r of (runs.data ?? []) as Array<{ id: string; source_decision_id: string | null }>) {
    if (r.source_decision_id) moveOfRun.set(r.id, r.source_decision_id);
  }
  const moveIds = [...new Set(moveOfRun.values())];
  if (moveIds.length === 0) return out;
  const moves = await db
    .from("decisions")
    .select("id, test:body->test, goal_id:body->>goal_id, dispatched_by:body->>dispatched_by")
    .eq("tenant_id", tid)
    .eq("decision_class", CGO_MOVE_CLASS)
    .in("id", moveIds);
  if (moves.error) throw new Error(moves.error.message);
  const byId = new Map<string, { test: ReturnType<typeof testView>; goal_id: string | null }>();
  for (const m of (moves.data ?? []) as Array<{ id: string; test: unknown; goal_id: string | null; dispatched_by: string | null }>) {
    if (m.dispatched_by !== "cgo") continue;
    byId.set(m.id, { test: testView(m.test), goal_id: m.goal_id ?? null });
  }
  for (const c of cards) {
    const move = c.run_id ? byId.get(moveOfRun.get(c.run_id) ?? "") : undefined;
    if (move) out.set(c.id, move);
  }
  return out;
}

export function anyWordQuery(query: string): string | null {
  const words = (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.toLowerCase() !== "or");
  const unique = [...new Set(words.map((w) => w.toLowerCase()))];
  return unique.length >= 2 ? unique.join(" or ") : null;
}

async function readWorkspaceName(tid: TenantId): Promise<string | null> {
  try {
    const { data } = await serviceClient().from("tenants").select("display_name").eq("id", tid).maybeSingle();
    return short((data as { display_name?: unknown } | null)?.display_name, 120);
  } catch {
    return null;
  }
}

async function readNextStep(tid: TenantId, now: Date) {
  const db = tenantClient(tid);
  const [workspace_name, goalsR, cardsR] = await Promise.all([
    readWorkspaceName(tid),
    db
      .from("autopilot_goals")
      .select("id, objective, target_metric, target_value, current_value, current_value_at, measurement_mode, due_date")
      .eq("tenant_id", tid)
      .eq("status", "active")
      .order("priority", { ascending: false })
      .limit(NEXT_STEP_GOALS),
    db
      .from("customer_visible_open_channel_actions")
      .select("id, run_id, channel_slug, title, step:body->step, edited_body, how_to, exec_class, score")
      .eq("tenant_id", tid)
      .order("score", { ascending: false })
      .limit(NEXT_STEP_CANDIDATES),
  ]);
  if (goalsR.error) throw new Error(`goals: ${goalsR.error.message}`);
  if (cardsR.error) throw new Error(`steps: ${cardsR.error.message}`);

  const goals = ((goalsR.data ?? []) as Array<Record<string, unknown>>).map((g) => {
    const at = typeof g.current_value_at === "string" ? Date.parse(g.current_value_at) : NaN;
    return {
      goal_id: String(g.id),
      objective: short(g.objective, 200),
      target_metric: short(g.target_metric, 120),
      target_value: g.target_value ?? null,
      due_date: g.due_date ?? null,
      current_value: g.current_value ?? null,
      current_value_at: g.current_value_at ?? null,
      number_age_days: Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / DAY_MS)) : null,
      measurement_mode: g.measurement_mode ?? null,
    };
  });

  const open = ((cardsR.data ?? []) as OpenCardRow[]).filter((c) => isCustomerChannelAction(c.channel_slug, { step: c.step }));
  const moves = await readCardMoves(tid, open);
  const rank = (c: OpenCardRow) => (c.exec_class ? 2 : 0) + (moves.has(c.id) ? 0 : 1);
  const ranked = open
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c)
    .slice(0, NEXT_STEP_CARDS);
  const steps = ranked.map((c) => {
    const move = moves.get(c.id);
    const howTo = Array.isArray(c.how_to) ? c.how_to.map((x) => short(x, 200)).filter((x): x is string => !!x).slice(0, 6) : [];
    return {
      action_id: c.id,
      channel: c.channel_slug,
      what_to_do: short(c.title, 300),
      why: short(c.step?.body, 600),
      how_to: howTo,
      done_by: c.exec_class ? "zavi" : "you",
      ...(!c.exec_class ? manualStepDetails(c) : {}),
      goal_id: move?.goal_id ?? null,
      test: move?.test ?? null,
    };
  });

  let due_readouts: Array<Record<string, unknown>> | null = null;
  try {
    const { due } = await readDueTests(tid, CGO_MOVE_CLASS, now);
    due_readouts = due.map((d) => ({
      move: d.intent,
      goal_id: d.goal_id,
      state: d.state,
      launched_on: d.launched_on,
      test: testView(d.test),
    }));
  } catch (e) {
    void logEvent({ level: "warn", source: "zavi-inbound", code: "mcp.next_step_due_unreadable", error: e, tenant_id: tid });
  }

  const next =
    steps.length === 0 && due_readouts === null
      ? "No steps are open, and the tests due for a readout could not be read just now. Call zavi_next_step again in a minute."
      : steps.length === 0 && due_readouts?.length === 0
      ? NOTHING_OPEN
      : steps.length > 0 && steps.every((s) => s.done_by === "zavi")
      ? "Every open step is a change Zavi makes itself once the founder approves it in Zavi, so there is nothing to mark done here. Call zavi_ask for a step the founder can do, or ask you to do."
      : "Show the founder a done_by \"you\" step. If they ask you to do it and you have a tool that can, show them the change first. Once it is done, call zavi_mark_step_done with what changed. On a test's readout_on date, get the goal's number from the founder, or read it with a connected tool if they ask, then call zavi_report_number.";
  return {
    ...(workspace_name ? { workspace_name } : {}),
    goals,
    steps,
    due_readouts,
    ...(due_readouts === null ? { due_readouts_note: "The tests due for a readout could not be read just now." } : {}),
    next,
  };
}

async function callerRole(caller: McpCaller): Promise<string | null> {
  try {
    return await loadTenantRoleFor(caller.user_id, caller.tenant_id);
  } catch {
    return null;
  }
}

async function markStepDone(
  caller: McpCaller,
  args: { action_id: string; what_changed: string; link?: string },
): Promise<ToolResult> {
  const tid = caller.tenant_id;
  const role = await callerRole(caller);
  if (!role || role === "viewer") return err("Your role in this workspace cannot mark steps done.");

  const { data: card, error: readErr } = await tenantClient(tid)
    .from("channel_actions")
    .select("id, status, snoozed_until, exec_class, exec_status")
    .eq("tenant_id", tid)
    .eq("id", args.action_id)
    .maybeSingle();
  if (readErr) return err("The step could not be read just now. Try again in a minute.");
  if (!card) return err(`step ${args.action_id} not found`);
  const row = card as { status: string; exec_class: string | null };
  if (row.status !== "pending" && row.status !== "snoozed") {
    return err(`This step is already closed (${row.status}). Call zavi_next_step for the open ones.`);
  }
  if (row.exec_class) {
    return err("Zavi makes this change itself once it is approved in Zavi, so it cannot be marked done from here.");
  }

  const note = `Done by your AI: ${args.what_changed}${args.link ? ` ${args.link}` : ""}`;
  const noteKey = createHash("sha256").update(note).digest("hex").slice(0, 16);
  const r = await tenantRpc(tid, "set_channel_action", {
    p_action_id: args.action_id,
    p_status: "acted",
    p_note: note,
    p_snoozed_until: null,
    p_event_key: `ai:${args.action_id}:${noteKey}`,
    p_actor_user_id: caller.user_id || null,
  });
  if (r.error) {
    void logEvent({ level: "warn", source: "zavi-inbound", code: "mcp.mark_done_failed", error: r.error, tenant_id: tid });
    return err("The step could not be marked done just now. Try again in a minute.");
  }
  const out = (r.data ?? {}) as { ok?: boolean; code?: string; replayed?: boolean; status?: string };
  if (out.ok && out.replayed && out.status !== "acted") {
    return err("This step was reopened after this was recorded. Describe what changed since, then mark it done again.");
  }
  if (out.ok) {
    return ok({
      action_id: args.action_id,
      status: "acted",
      replayed: out.replayed === true,
      next: "Saved. Call zavi_next_step for the next step.",
    });
  }
  switch (out.code) {
    case "not_found":
      return err(`step ${args.action_id} not found`);
    case "illegal_transition":
      return err("This step is already closed. Call zavi_next_step for the open ones.");
    case "exec_in_flight":
      return err("Zavi is making this change right now, so it cannot be marked done from here.");
    default:
      return err(`The step could not be marked done (${out.code ?? "refused"}).`);
  }
}

async function reportNumber(caller: McpCaller, args: { goal_id: string; value: number }): Promise<ToolResult> {
  const tid = caller.tenant_id;
  const role = await callerRole(caller);
  if (role !== "owner" && role !== "admin") {
    return err("Only an owner or admin of this workspace can report a goal's number.");
  }

  const { data: goal, error: readErr } = await tenantClient(tid)
    .from("autopilot_goals")
    .select("id, status, measurement_mode")
    .eq("tenant_id", tid)
    .eq("id", args.goal_id)
    .maybeSingle();
  if (readErr) return err("The goal could not be read just now. Try again in a minute.");
  if (!goal) return err(`goal ${args.goal_id} not found`);
  const row = goal as { status: string; measurement_mode: string | null };
  if (row.status === "met" || row.status === "missed") {
    return err(`This goal is closed (${row.status}), so its number cannot change.`);
  }
  if (row.measurement_mode === "auto") {
    return err("This goal is measured by a connected source, which counts its own way, so a reported number was not saved.");
  }

  const at = new Date().toISOString();
  const w = await writeAutopilotGoal(tid, {
    op: "update",
    goal_id: args.goal_id,
    values: { current_value: args.value, current_value_at: at, current_value_source: FOUNDER_ENTERED_SOURCE, updated_at: at },
    expect: { measurement_mode: row.measurement_mode },
    status_not_in: ["met", "missed"],
    actor: { source: "founder", user_id: caller.user_id, why: "Reported by the founder's own AI" },
  });
  if (w.status === "error") {
    void logEvent({ level: "warn", source: "zavi-inbound", code: "mcp.report_number_failed", error: new Error(w.error), tenant_id: tid });
    return err("The number could not be saved just now. Try again in a minute.");
  }
  if (w.status === "not_matched") {
    return err("The goal changed while saving (it may now be measured by a connected source, or be closed). Call zavi_next_step and try again.");
  }
  void recordMetricSnapshot({
    tenant_id: tid,
    metric_key: `goal:${args.goal_id}`,
    value: args.value,
    status: "measured",
    source: "founder_reported",
    window_kind: "point",
    window_end: at,
    meta: { actor_user_id: caller.user_id, via: "mcp_founder_ai" },
  });
  await syncGoalWork(tid, args.goal_id);
  return ok({ goal_id: args.goal_id, current_value: args.value, current_value_at: at, next: "Saved. Call zavi_next_step for the next step." });
}

export async function handleZaviTool(
  name: string,
  rawArgs: unknown,
  caller: McpCaller,
): Promise<ToolResult> {
  const deadline = Date.now() + ZAVI_ASK_WAIT_MS;
  const canonical = name.startsWith("praxis_") ? "zavi_" + name.slice("praxis_".length) : name;

  const spec = (SPECS as any)[canonical];
  if (!spec) return err(`unknown tool: ${name}`);

  if (!callerHasScope(caller, canonical)) {
    return { ...err(`scope_denied: tool ${name} requires a scope your PAT lacks`), isError: true };
  }

  const input = canonical === "zavi_run_agent" ? withObjectPayload(rawArgs) : rawArgs;
  const parsed = spec.schema.safeParse(input ?? {});
  if (!parsed.success) return err(`invalid args: ${parsed.error.message}`);
  const args = parsed.data;

  try {
    switch (canonical as ToolName) {
      case "zavi_list_agents": {
        const visible = await filterPlanEntitledAgents(
          await filterTenantVisibleAgents(listAgents(), caller.tenant_id),
          caller.tenant_id,
        );
        const listed = visible.filter((a) => MCP_AGENT_CATALOG[a.slug]);
        const withAccess = await Promise.all(
          listed.map(async (a) => ({
            slug: a.slug,
            name: MCP_AGENT_CATALOG[a.slug].name,
            description: MCP_AGENT_CATALOG[a.slug].description,
            can_run: await canUserAccessAgent(
              serviceClient(), caller.user_id, caller.tenant_id, a.slug,
            ),
          })),
        );
        return ok(withAccess);
      }

      case "zavi_run_agent": {
        if (args.slug === "browser-operator" && !BROWSER_OPERATOR_ALLOWED_TRIGGERS.has("mcp")) {
          return agentNotFound(args.slug);
        }
        const allowed = await canUserAccessAgent(
          serviceClient(), caller.user_id, caller.tenant_id, args.slug,
        );
        if (!allowed) {
          return err(`agent ${args.slug} not found, or your role is read-only`);
        }
        const comingSoon = await lockedChannelMessageForAgent(args.slug);
        if (comingSoon) return err(comingSoon);

        try {
          const { run_id } = await enqueueAgentRun({
            agent_slug: args.slug,
            tenant_id: caller.tenant_id,
            trigger: "mcp",
            payload: stripAssistantRunMode(args.slug, stripReservedRunPayloadKeys(args.payload)),
            actor_user_id: caller.user_id,
          });
          return ok({ run_id });
        } catch (e) {
          if (e instanceof AgentNotFoundError) return agentNotFound(args.slug);
          throw e;
        }
      }

      case "zavi_ask": {
        const allowed = await canUserAccessAgent(
          serviceClient(), caller.user_id, caller.tenant_id, "operator",
        );
        if (!allowed) {
          return err("operator agent not available for your tenant");
        }
        const run_id =
          (askStartsOnGrowthAgent(args.message) ? await startGrowthAnswer(caller, args.message) : null) ??
          (
            await enqueueAgentRun({
              agent_slug: "operator",
              tenant_id: caller.tenant_id,
              trigger: "mcp",
              payload: { message: args.message, source: "mcp" },
              actor_user_id: caller.user_id,
            })
          ).run_id;
        if (!callerHasScope(caller, "zavi_get_run_status")) return ok({ run_id });
        return await waitForAnswer(caller.tenant_id, run_id, deadline);
      }

      case "zavi_get_run_status": {
        const detail = await readRun(caller.tenant_id, args.run_id, deadline, true);
        if (detail === TIMED_OUT) return stillRunning(args.run_id);
        if (!detail) return err(`run ${args.run_id} not found`);
        if (detail.presentation_status === "running") return await waitForAnswer(caller.tenant_id, args.run_id, deadline);
        return ok(detail);
      }

      case "zavi_recent_runs": {
        const runs = await listAgentRuns({
          tenant_id: caller.tenant_id,
          agent_slug: args.slug,
          limit: args.limit,
        });
        return ok(runs.map(runListEntry));
      }

      case "zavi_read_brain": {
        let q = serviceClient()
          .from("memory_note")
          .select("id,title,body_markdown,slug,note_type,created_at")
          .eq("tenant_id", caller.tenant_id)
          .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
          .is("superseded_by", null);
        if (args.slug) q = q.eq("slug", args.slug);
        if (args.query) {
          q = q.textSearch("tsv", args.query, { type: "websearch" });
        }
        q = q.order("created_at", { ascending: false }).limit(args.limit);
        const { data, error } = await q;
        if (error) return err(error.message);
        return ok(data ?? []);
      }

      case "zavi_search": {
        const sb = serviceClient();
        const q = args.query as string;
        const searchNotes = (query: string) =>
          sb
            .from("memory_note")
            .select("id,title,body_markdown,created_at")
            .eq("tenant_id", caller.tenant_id)
            .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
            .is("superseded_by", null)
            .textSearch("tsv", query, { type: "websearch" })
            .limit(10);
        const [allWords, runs] = await Promise.all([
          searchNotes(q),
          sb
            .from("agent_runs")
            .select("id,agent_slug,status,enqueued_at")
            .eq("tenant_id", caller.tenant_id)
            .ilike("agent_slug", `%${q}%`)
            .order("enqueued_at", { ascending: false })
            .limit(10),
        ]);
        const anyWord = anyWordQuery(q);
        const notes =
          !allWords.error && (allWords.data ?? []).length === 0 && anyWord ? await searchNotes(anyWord) : allWords;
        if (notes.error) return err(notes.error.message);
        const results = [
          ...((notes.data ?? []).map((n: any) => ({
            id: `note:${n.id}`,
            title: n.title ?? "(untitled note)",
            url: noteUrl(n.id),
          }))),
          ...((runs.data ?? []).map((r: any) => ({
            id: `run:${r.id}`,
            title: `${r.agent_slug} run (${r.status})`,
            url: runUrl(r.id),
          }))),
        ];
        return { content: [{ type: "text", text: JSON.stringify({ results }) }], structuredContent: { results } };
      }

      case "zavi_fetch": {
        const id = args.id as string;
        const sep = id.indexOf(":");
        const kind = sep > 0 ? id.slice(0, sep) : "";
        const refId = sep > 0 ? id.slice(sep + 1) : "";
        const sb = serviceClient();
        let doc: { id: string; title: string; text: string; url: string } | null = null;
        if (kind === "note") {
          const { data } = await sb
            .from("memory_note")
            .select("id,title,body_markdown")
            .eq("tenant_id", caller.tenant_id)
            .eq("id", refId)
            .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
            .maybeSingle();
          if (data) {
            doc = {
              id,
              title: (data.title as string) ?? "(untitled note)",
              text: (data.body_markdown as string) ?? "",
              url: noteUrl(refId),
            };
          }
        } else if (kind === "run") {
          const { data } = await sb
            .from("agent_runs")
            .select("id,agent_slug,status,parsed,output_text")
            .eq("tenant_id", caller.tenant_id)
            .eq("id", refId)
            .maybeSingle();
          if (data) {
            doc = {
              id,
              title: `${data.agent_slug} run (${data.status})`,
              text: buildRunFetchText(data),
              url: runUrl(refId),
            };
          }
        }
        if (!doc) return err(`document ${id} not found`);
        return { content: [{ type: "text", text: JSON.stringify(doc) }], structuredContent: doc };
      }

      case "zavi_next_step": {
        const data = await readNextStep(caller.tenant_id, new Date());
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
      }

      case "zavi_mark_step_done": {
        const res = await markStepDone(caller, args);
        return res.isError ? res : { ...res, structuredContent: JSON.parse(res.content[0].text) };
      }

      case "zavi_report_number": {
        const res = await reportNumber(caller, args);
        return res.isError ? res : { ...res, structuredContent: JSON.parse(res.content[0].text) };
      }

      default:
        return err(`unhandled tool: ${name}`);
    }
  } catch (e) {
    return err(mcpSafeErrorMessage(e as Error));
  }
}

export function mcpSafeErrorMessage(e: Error): string {
  return assistantRefusalForError(e)?.message ?? e.message;
}
