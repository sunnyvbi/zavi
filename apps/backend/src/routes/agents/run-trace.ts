
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getAgentRunById, canCurrentUserReadRun } from "@/services/agents/runner";
import { tenantClient } from "@/services/tenant-client";
import { redactValue } from "@/services/redactor";
import type { ToolCallTrace } from "@/services/tools/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redactText(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined || s === "") return undefined;
  const out = redactValue("agent_trace_text", s);
  return typeof out === "string" ? out : String(out);
}

function isMachineEnvelope(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  if (/^<[a-z][a-z0-9_]*>/i.test(t)) return true;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return true;
    } catch {
    }
  }
  return false;
}

export type ProofPlan = { summary: string; steps: string[] };
export type ProofTimelineItem = { kind: "reasoning"; text: string };
export type ProofReceipt = { type: string; label: string; url?: string };
export type ProofAction = {
  kind: "action";
  name: string;
  status: "ok" | "error";
  ms: number;
  receipts: ProofReceipt[];
};
export type ProofDecision = {
  kind: "decision";
  decision_class: string;
  status: string;
  title?: string;
  dispatched_at?: string;
};
export type RunProofDTO = {
  run_id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  plan?: ProofPlan;
  timeline: ProofTimelineItem[];
  actions: ProofAction[];
  decisions: ProofDecision[];
  final?: string;
};

type ToolCallWithReceipts = ToolCallTrace & { receipts?: ProofReceipt[] };

function actionStatus(s: string): "ok" | "error" {
  return s === "ok" ? "ok" : "error";
}

export function buildRunProofDTO(input: {
  run: { id: string; agent_slug: string; status: string; started_at: string | null; finished_at: string | null };
  tool_calls: unknown;
  output_text: string | null | undefined;
  thread_events: Array<{ kind: string; body: unknown }>;
  decisions: Array<{ decision_class: unknown; status: unknown; body: unknown; dispatched_at: unknown }>;
}): RunProofDTO {
  const { run } = input;

  let plan: ProofPlan | undefined;
  const timeline: ProofTimelineItem[] = [];
  for (const ev of input.thread_events) {
    const b = (ev.body ?? {}) as Record<string, unknown>;
    if (ev.kind === "plan" && !plan) {
      plan = {
        summary: redactText(String(b.summary ?? "")) ?? "",
        steps: Array.isArray(b.steps)
          ? (b.steps as unknown[]).map((s) => redactText(String(s)) ?? "")
          : [],
      };
    } else if (ev.kind === "reasoning") {
      const raw = String(b.text ?? "");
      if (isMachineEnvelope(raw)) continue;
      const t = redactText(raw);
      if (t) timeline.push({ kind: "reasoning", text: t });
    }
  }

  const tcs = Array.isArray(input.tool_calls)
    ? (input.tool_calls as ToolCallWithReceipts[])
    : [];
  const actions: ProofAction[] = tcs.map((tc) => ({
    kind: "action",
    name: String(tc.name ?? "tool"),
    status: actionStatus(String(tc.status ?? "")),
    ms: typeof tc.ms === "number" ? tc.ms : 0,
    receipts: Array.isArray(tc.receipts) ? tc.receipts : [],
  }));

  const decisions: ProofDecision[] = input.decisions.map((d) => {
    const body = (d.body ?? {}) as Record<string, unknown>;
    const rawTitle = String(body.title ?? body.subject ?? "");
    return {
      kind: "decision",
      decision_class: String(d.decision_class ?? ""),
      status: String(d.status ?? ""),
      title: redactText(rawTitle),
      dispatched_at: d.dispatched_at ? String(d.dispatched_at) : undefined,
    };
  });

  return {
    run_id: run.id,
    agent_slug: run.agent_slug,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    plan,
    timeline,
    actions,
    decisions,
    final: redactText(input.output_text),
  };
}

export async function agentRunTrace(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const run_id = req.params.run_id;
  const notFound = (): void => {
    res
      .status(404)
      .json({ error: { code: "not_found", message: `run ${run_id} not found` } });
  };

  if (!UUID_RE.test(run_id)) {
    notFound();
    return;
  }

  try {
    const run = await getAgentRunById(auth.tenant_id, run_id);
    if (!run) return notFound();
    const allowed = await canCurrentUserReadRun(auth.user_id, run_id);
    if (!allowed) return notFound();

    const tc = tenantClient(auth.tenant_id);

    const { data: teRows } = await tc
      .from("thread_event")
      .select("kind, body")
      .eq("agent_run_id", run_id)
      .in("kind", ["plan", "reasoning"])
      .order("created_at", { ascending: true });

    const { data: decRows } = await tc
      .from("decisions")
      .select("decision_class, status, body, dispatched_at")
      .eq("agent_run_id", run_id)
      .order("created_at", { ascending: true });

    const dto = buildRunProofDTO({
      run: {
        id: run.id,
        agent_slug: run.agent_slug,
        status: String(run.status),
        started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null,
      },
      tool_calls: run.tool_calls ?? [],
      output_text: run.output_text,
      thread_events: (teRows ?? []) as Array<{ kind: string; body: unknown }>,
      decisions: (decRows ?? []) as Array<{
        decision_class: unknown;
        status: unknown;
        body: unknown;
        dispatched_at: unknown;
      }>,
    });

    res.json(dto);
  } catch (err) {
    res.status(500).json({
      error: {
        code: "trace_failed",
        message: err instanceof Error ? err.message : "trace failed",
      },
    });
  }
}
