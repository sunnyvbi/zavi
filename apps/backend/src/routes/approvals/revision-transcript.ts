
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { canUserAccessAgent } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";
import { resolveDecisionReviser } from "@/services/decisions/reviser";

const DECISION_ID_PARAM = z.object({ decision_id: z.string().uuid() });

const TERMINAL_SUCCESS = new Set(["success"]);
const TERMINAL_FAILED = new Set(["failed", "parse_failed", "dispatch_error", "cancelled"]);

type RevRow = {
  id: string;
  agent_run_id: string | null;
  status: string;
  message: string;
  created_at: string;
};
type RunRow = { id: string; status: string };
type AsstMsgRow = { agent_run_id: string | null; body: string | null; created_at: string };

export type TranscriptTurn = {
  role: "user" | "assistant";
  body: string | null;
  created_at: string;
  run_id?: string | null;
  failed?: boolean;
};

export async function approvalsRevisionTranscript(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const param = DECISION_ID_PARAM.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({
      error: { code: "invalid_decision_id", message: "decision_id must be a UUID" },
    });
    return;
  }
  const decisionId = param.data.decision_id;
  const sb = serviceClient();

  const { data: decisionData, error: decisionErr } = await sb
    .from("decisions")
    .select("id, tenant_id, decision_class, agent_run_id")
    .eq("id", decisionId)
    .maybeSingle();
  if (decisionErr) {
    res.status(500).json({ error: { code: "decision_read_failed", message: decisionErr.message } });
    return;
  }
  const decision = decisionData as
    | { id: string; tenant_id: string; decision_class: string; agent_run_id: string | null }
    | null;
  if (!decision || decision.tenant_id !== auth.tenant_id) {
    res.status(404).json({ error: { code: "decision_not_found", message: "decision not found" } });
    return;
  }

  const reviser = await resolveDecisionReviser(sb, decision);
  if (!reviser.ok) {
    res.status(reviser.status).json({ error: { code: reviser.code, message: reviser.message } });
    return;
  }
  const AGENT_SLUG = reviser.slug;

  const allowed = await canUserAccessAgent(sb, auth.user_id, auth.tenant_id, AGENT_SLUG, { read: true });
  if (!allowed) {
    res.status(403).json({
      error: { code: "agent_not_allowed", message: "Your role is read-only. Ask a workspace admin to make you a member." },
    });
    return;
  }

  try {
    const { count: activeCount } = await sb
      .from("decision_revision_requests")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .eq("decision_id", decisionId)
      .in("status", ["requested", "running"]);
    const anyActive = (activeCount ?? 0) > 0;

    const { data: revData } = await sb
      .from("decision_revision_requests")
      .select("id, agent_run_id, status, message, created_at")
      .eq("tenant_id", auth.tenant_id)
      .eq("decision_id", decisionId)
      .eq("created_by", auth.user_id)
      .order("created_at", { ascending: true });
    const revs = (revData ?? []) as RevRow[];

    if (revs.length === 0) {
      res.json({ decision_id: decisionId, transcript: [], active: anyActive });
      return;
    }

    const runIds = [...new Set(revs.map((r) => r.agent_run_id).filter((x): x is string => !!x))];

    const runById = new Map<string, RunRow>();
    const asstByRun = new Map<string, AsstMsgRow>();
    if (runIds.length > 0) {
      const [{ data: runs }, { data: msgs }] = await Promise.all([
        sb.from("agent_runs").select("id, status").eq("tenant_id", auth.tenant_id).in("id", runIds),
        sb
          .from("agent_thread_messages")
          .select("agent_run_id, body, created_at")
          .eq("tenant_id", auth.tenant_id)
          .eq("sender_role", "assistant")
          .in("agent_run_id", runIds),
      ]);
      for (const r of (runs ?? []) as RunRow[]) runById.set(r.id, r);
      for (const m of (msgs ?? []) as AsstMsgRow[]) {
        if (m.agent_run_id) asstByRun.set(m.agent_run_id, m);
      }
    }

    const transcript: TranscriptTurn[] = [];
    let active = false;
    for (const r of revs) {
      transcript.push({ role: "user", body: r.message, created_at: r.created_at });

      const run = r.agent_run_id ? runById.get(r.agent_run_id) : undefined;
      const asst = r.agent_run_id ? asstByRun.get(r.agent_run_id) : undefined;
      if (asst) {
        transcript.push({
          role: "assistant",
          body: asst.body ?? null,
          created_at: asst.created_at,
          run_id: r.agent_run_id,
        });
      } else if (run && TERMINAL_FAILED.has(run.status)) {
        transcript.push({
          role: "assistant",
          body: null,
          created_at: r.created_at,
          run_id: r.agent_run_id,
          failed: true,
        });
      } else if (
        (!run && (r.status === "requested" || r.status === "running")) ||
        (!!run && !TERMINAL_SUCCESS.has(run.status) && !TERMINAL_FAILED.has(run.status))
      ) {
        active = true;
      }
    }
    transcript.sort((a, b) => a.created_at.localeCompare(b.created_at));

    res.json({ decision_id: decisionId, transcript, active });
  } catch (e) {
    console.warn(
      "revision transcript assembly failed; returning empty transcript",
      decisionId,
      (e as Error).message,
    );
    res.json({ decision_id: decisionId, transcript: [], active: false, transcript_error: true });
  }
}
