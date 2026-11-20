
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export type OpenActionSeverity = "urgent" | "normal";

export type OpenActionInput = {
  summary: string;
  severity: OpenActionSeverity;
  proposed_action?: string;
};

type OpenActionRow = {
  summary: string;
  severity: OpenActionSeverity;
  proposed_action: string | null;
};

const MAX_ACTIONS_PER_RUN = 5;
const MAX_SUMMARY_LEN = 600;
const MAX_PROPOSED_LEN = 600;
const INJECT_TOP_N = 3;

type Sb = ReturnType<typeof serviceClient>;

export async function isOpenActionsLedgerEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.open_actions_ledger_enabled === true;
  } catch {
    return false;
  }
}

export function parseOpenActionsFromEnvelope(raw: unknown): OpenActionInput[] {
  try {
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      "open_actions" in (raw as Record<string, unknown>)
    ) {
      raw = (raw as Record<string, unknown>).open_actions;
    }
    if (!Array.isArray(raw)) return [];
    const out: OpenActionInput[] = [];
    for (const entry of raw) {
      if (out.length >= MAX_ACTIONS_PER_RUN) break;
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const summary = typeof e.summary === "string" ? e.summary.trim() : "";
      if (summary.length === 0) continue;
      const severity: OpenActionSeverity =
        e.severity === "urgent" ? "urgent" : e.severity === "normal" ? "normal" : "normal";
      const proposed =
        typeof e.proposed_action === "string" && e.proposed_action.trim().length > 0
          ? e.proposed_action.trim().slice(0, MAX_PROPOSED_LEN)
          : undefined;
      out.push({
        summary: summary.slice(0, MAX_SUMMARY_LEN),
        severity,
        proposed_action: proposed,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function persistOpenActions(args: {
  sb?: Sb;
  tenant_id: string;
  thread_id: string | null;
  agent_slug: string;
  source_run_id: string;
  actions: OpenActionInput[];
}): Promise<{ inserted: number }> {
  const { tenant_id, thread_id, agent_slug, source_run_id, actions } = args;
  if (!thread_id || actions.length === 0) return { inserted: 0 };
  const sb = args.sb ?? serviceClient();
  try {
    if (!(await isOpenActionsLedgerEnabled(sb))) return { inserted: 0 };
    const rows = actions.map((a) => ({
      tenant_id,
      thread_id,
      agent_slug,
      source_run_id,
      summary: a.summary,
      severity: a.severity,
      proposed_action: a.proposed_action ?? null,
      status: "open" as const,
    }));
    const { error } = await sb.from("agent_open_actions").insert(rows);
    if (error) {
      console.warn(`[open-actions] insert failed for ${source_run_id}: ${error.message}`);
      return { inserted: 0 };
    }
    void logEvent({
      level: "info",
      source: "open-actions.capture",
      code: "open_actions_captured",
      meta: { agent_slug, count: rows.length, run_id_ref: source_run_id },
    });
    return { inserted: rows.length };
  } catch (e) {
    console.warn(
      `[open-actions] persist threw for ${source_run_id}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { inserted: 0 };
  }
}

export async function buildOpenActionsBlock(
  tenant_id: string,
  thread_id: string,
  sb?: Sb,
): Promise<string> {
  const client = sb ?? serviceClient();
  try {
    if (!(await isOpenActionsLedgerEnabled(client))) return "";
    const { data, error } = await client
      .from("agent_open_actions")
      .select("summary, severity, proposed_action")
      .eq("tenant_id", tenant_id)
      .eq("thread_id", thread_id)
      .eq("status", "open")
      .eq("severity", "urgent")
      .order("created_at", { ascending: false })
      .limit(INJECT_TOP_N);
    if (error) {
      console.warn(`[open-actions] injection read failed: ${error.message}`);
      return "";
    }
    const rows = (data ?? []) as OpenActionRow[];
    return renderOpenActionsBlock(rows);
  } catch (e) {
    console.warn(
      `[open-actions] injection threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "";
  }
}

export function renderOpenActionsBlock(rows: OpenActionRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.slice(0, INJECT_TOP_N).map((r) => {
    const proposed = r.proposed_action ? ` (proposed: ${r.proposed_action})` : "";
    return `- ${r.summary}${proposed}`;
  });
  return [
    "OPEN URGENT ACTIONS you raised earlier in this thread (re-surface unless THIS turn's data shows it resolved — do not silently drop them):",
    ...lines,
  ].join("\n");
}

export async function resolveOldestOpenUrgentOnProposal(args: {
  sb?: Sb;
  tenant_id: string;
  thread_id: string | null;
  agent_slug: string;
  reason?: string;
}): Promise<{ resolved: number }> {
  const { tenant_id, thread_id, agent_slug } = args;
  if (!thread_id) return { resolved: 0 };
  const sb = args.sb ?? serviceClient();
  try {
    if (!(await isOpenActionsLedgerEnabled(sb))) return { resolved: 0 };
    const { data: candidate, error: selErr } = await sb
      .from("agent_open_actions")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("thread_id", thread_id)
      .eq("agent_slug", agent_slug)
      .eq("status", "open")
      .eq("severity", "urgent")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (selErr || !candidate?.id) return { resolved: 0 };
    const { data: updated, error: updErr } = await sb
      .from("agent_open_actions")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_reason: (args.reason ?? "agent fired a proposal this turn").slice(0, 200),
      })
      .eq("id", candidate.id)
      .eq("status", "open")
      .select("id");
    if (updErr || !updated || updated.length === 0) return { resolved: 0 };
    void logEvent({
      level: "info",
      source: "open-actions.lifecycle",
      code: "open_action_resolved",
      meta: { agent_slug, count: 1 },
    });
    return { resolved: 1 };
  } catch (e) {
    console.warn(
      `[open-actions] resolve threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { resolved: 0 };
  }
}
