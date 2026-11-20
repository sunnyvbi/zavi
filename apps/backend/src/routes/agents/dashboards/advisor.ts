import type { DashboardBuilder } from "./_contract";

type PendingDecision = {
  id: string;
  decision_class: string;
  age_days: number;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

type ThreadRow = {
  id: string;
  title: string;
  snippet: string;
  last_message_at: string | null;
  status: "pending" | "running" | "done" | "idle";
};

const DAY_MS = 86_400 * 1000;

function ageDays(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

function humanizeClass(cls: string): string {
  return (cls || "open").replace(/[_-]+/g, " ").trim() || "open";
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g;
function scrubPii(s: string | null): string | null {
  if (!s) return null;
  return s.replace(EMAIL_RE, "[redacted]").replace(PHONE_RE, "[redacted]");
}

export const build: DashboardBuilder = async (c) => {
  const pending: PendingDecision[] = [];
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, status, emitted_at")
      .eq("tenant_id", c.tenantId)
      .eq("status", "proposed")
      .order("emitted_at", { ascending: true })
      .limit(200);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{
        id: string;
        decision_class: string | null;
        emitted_at: string | null;
      }>) {
        pending.push({
          id: String(r.id),
          decision_class: humanizeClass(String(r.decision_class ?? "open")),
          age_days: ageDays(r.emitted_at),
        });
      }
    }
  } catch {
  }

  let emitted_14d = 0;
  let proposed_14d = 0;
  let acted_14d = 0;
  try {
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString();
    const { data, error } = await c.sb
      .from("decisions")
      .select("status, emitted_at")
      .eq("tenant_id", c.tenantId)
      .gte("emitted_at", since)
      .limit(2000);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{ status: string | null }>) {
        emitted_14d += 1;
        if (r.status === "proposed") proposed_14d += 1;
        else if (r.status === "acted") acted_14d += 1;
      }
    }
  } catch {
  }

  const oldest_pending_days = pending.length > 0 ? pending[0].age_days : 0;

  const kpis = {
    pending: pending.length,
    oldest_pending_days,
    emitted_14d,
    proposed_14d,
    acted_14d,
  };

  const attention: AttentionItem[] = [];
  for (const d of pending) {
    if (d.age_days <= 7) continue;
    attention.push({
      severity: d.age_days > 14 ? "high" : "warn",
      title: `"${d.decision_class}" decision pending ${d.age_days} days`,
      detail: `This call has been sitting in your queue for ${d.age_days} days without a decision.`,
      ask: `Think through the ${d.decision_class} decision that's been pending ${d.age_days} days — approve, reject, or what am I missing?`,
    });
  }

  const open_recommendations: Array<{
    id: string;
    title: string;
    confidence: string;
    disconfirming_signal: string | null;
    lead_priority: boolean;
    age_days: number;
  }> = [];
  try {
    const { data, error } = await c.sb
      .from("advisor_recommendations")
      .select("id, title, confidence, disconfirming_signal, lead_priority, created_at")
      .eq("tenant_id", c.tenantId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(20);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{
        id: string;
        title: string | null;
        confidence: string | null;
        disconfirming_signal: string | null;
        lead_priority: boolean | null;
        created_at: string | null;
      }>) {
        open_recommendations.push({
          id: String(r.id),
          title: (r.title ?? "").trim() || "Untitled",
          confidence: String(r.confidence ?? "low_confidence_speculation"),
          disconfirming_signal: r.disconfirming_signal ?? null,
          lead_priority: r.lead_priority === true,
          age_days: ageDays(r.created_at),
        });
      }
    }
  } catch {
  }

  const track_record = {
    acted: 0,
    rejected: 0,
    stale: 0,
    open: open_recommendations.length,
  };
  try {
    const [openCt, actedCt, rejectedCt, staleCt] = await Promise.all(
      (["open", "acted", "rejected", "stale"] as const).map((s) =>
        c.sb
          .from("advisor_recommendations")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", c.tenantId)
          .eq("status", s),
      ),
    );
    if (typeof openCt.count === "number") track_record.open = openCt.count;
    if (typeof actedCt.count === "number") track_record.acted = actedCt.count;
    if (typeof rejectedCt.count === "number")
      track_record.rejected = rejectedCt.count;
    if (typeof staleCt.count === "number") track_record.stale = staleCt.count;
  } catch {
  }

  const resolved_recommendations: Array<{
    id: string;
    title: string;
    confidence: string;
    outcome: "acted" | "rejected" | "stale";
    resolved_reason: string | null;
    lead_priority: boolean;
    age_days: number;
  }> = [];
  try {
    const { data, error } = await c.sb
      .from("advisor_recommendations")
      .select(
        "id, title, confidence, status, resolved_reason, lead_priority, resolved_at, created_at",
      )
      .eq("tenant_id", c.tenantId)
      .in("status", ["acted", "rejected", "stale"])
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(12);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<{
        id: string;
        title: string | null;
        confidence: string | null;
        status: string | null;
        resolved_reason: string | null;
        lead_priority: boolean | null;
        resolved_at: string | null;
        created_at: string | null;
      }>) {
        const outcome =
          r.status === "acted" || r.status === "rejected" || r.status === "stale"
            ? r.status
            : null;
        if (!outcome) continue;
        resolved_recommendations.push({
          id: String(r.id),
          title: scrubPii((r.title ?? "").trim()) || "Untitled",
          confidence: String(r.confidence ?? "low_confidence_speculation"),
          outcome,
          resolved_reason: scrubPii(r.resolved_reason),
          lead_priority: r.lead_priority === true,
          age_days: ageDays(r.resolved_at ?? r.created_at),
        });
      }
    }
  } catch {
  }

  const threads: ThreadRow[] = [];
  try {
    const { data, error } = await c.sb.rpc("list_agent_threads", {
      p_agent_slug: "advisor",
    });
    if (!error && Array.isArray(data)) {
      for (const r of (data as Array<{
        id: string;
        title: string | null;
        last_message: string | null;
        last_message_at: string | null;
        run_status: string | null;
        pending: boolean | null;
      }>).slice(0, 12)) {
        const status: ThreadRow["status"] = r.pending
          ? "pending"
          : r.run_status === "running" || r.run_status === "claimed"
            ? "running"
            : r.run_status === "completed" || r.run_status === "success"
              ? "done"
              : "idle";
        threads.push({
          id: String(r.id),
          title: (r.title ?? "").trim() || "Untitled thread",
          snippet: (r.last_message ?? "").trim(),
          last_message_at: r.last_message_at ?? null,
          status,
        });
      }
    }
  } catch {
  }

  return {
    kpis,
    attention,
    threads,
    open_recommendations,
    track_record,
    resolved_recommendations,
  };
};
