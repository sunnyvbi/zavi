import type { DashboardBuilder } from "./_contract";
import { readConnectorList } from "@/services/connectors/metadata";
import { connectorLabel } from "@/services/connectors/labels";
import { isMoneyOrAuthDecisionClass } from "./_attention-money";

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
  decision_id?: string;
  is_money?: boolean;
};

type ConnectorRow = {
  slug: string;
  label: string;
  connected: boolean;
};

type ThreadRow = {
  id: string;
  title: string;
  snippet: string;
  last_message_at: string | null;
  status: "pending" | "running" | "done" | "idle";
};

const DAY_MS = 86_400 * 1000;

const CORE_CONNECTORS: Array<{ slug: string; label: string }> = [
  { slug: "operator_db", label: "Business DB" },
  { slug: "stripe", label: "Stripe" },
  { slug: "slack", label: "Slack" },
  { slug: "github", label: "GitHub" },
];

const WARN_IF_MISSING = new Set(["operator_db", "stripe", "slack", "github"]);

function shortSummary(decisionClass: string, body: unknown): string {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const pick = (k: string): string | null => {
    const v = b[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  let raw: string | null = null;
  if (decisionClass === "operator.file-jira-issue") raw = pick("summary");
  else if (decisionClass === "operator.file-linear-issue") raw = pick("title");
  else if (decisionClass === "operator.post-slack-message") raw = pick("text");
  if (!raw) raw = pick("summary") ?? pick("title") ?? pick("text");
  if (!raw) return verbNoun(decisionClass);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function verbNoun(decisionClass: string): string {
  switch (decisionClass) {
    case "operator.file-jira-issue":
      return "Jira ticket";
    case "operator.file-linear-issue":
      return "Linear issue";
    case "operator.post-slack-message":
      return "Slack message";
    default:
      return "action";
  }
}

function ageDays(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

export const build: DashboardBuilder = async (c) => {
  let pending: Array<{
    id: string;
    decision_class: string;
    body: unknown;
    emitted_at: string | null;
  }> = [];
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, body, status, emitted_at")
      .like("decision_class", "operator.%")
      .eq("status", "proposed")
      .order("emitted_at", { ascending: false })
      .limit(50);
    if (!error && Array.isArray(data)) {
      pending = (data as Array<{
        id: string;
        decision_class: string | null;
        body: unknown;
        emitted_at: string | null;
      }>).map((r) => ({
        id: String(r.id),
        decision_class: String(r.decision_class ?? ""),
        body: r.body,
        emitted_at: r.emitted_at ?? null,
      }));
    }
  } catch {
  }

  const connectedSlugs = new Set<string>();
  try {
    const list = await readConnectorList(c.tenantId);
    for (const e of list) connectedSlugs.add(e.slug);
  } catch {
  }

  const coreSlugs = new Set(CORE_CONNECTORS.map((cc) => cc.slug));
  const connectors: ConnectorRow[] = CORE_CONNECTORS.map((cc) => ({
    slug: cc.slug,
    label: cc.label,
    connected: connectedSlugs.has(cc.slug),
  }));
  const extras: ConnectorRow[] = [];
  for (const slug of connectedSlugs) {
    if (coreSlugs.has(slug)) continue;
    extras.push({ slug, label: connectorLabel(slug), connected: true });
  }
  extras.sort((a, b) => a.label.localeCompare(b.label));
  connectors.push(...extras);
  const connected_count = connectors.filter((c2) => c2.connected).length;

  let runs_7d = 0;
  let last_active: string | null = null;
  try {
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("finished_at, enqueued_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "operator")
      .gte("enqueued_at", since)
      .order("finished_at", { ascending: false })
      .limit(500);
    if (!error && Array.isArray(data)) {
      runs_7d = data.length;
      for (const r of data as Array<{ finished_at: string | null }>) {
        if (r.finished_at) {
          last_active = r.finished_at;
          break;
        }
      }
    }
  } catch {
  }

  const kpis = {
    pending: pending.length,
    connected_count,
    runs_7d,
    last_active,
  };

  const attention: AttentionItem[] = [];
  for (const d of pending) {
    const noun = verbNoun(d.decision_class);
    const summary = shortSummary(d.decision_class, d.body);
    const age = ageDays(d.emitted_at);
    attention.push({
      severity: age > 3 ? "high" : "warn",
      title: `${noun} waiting on your approval`,
      detail:
        summary === noun
          ? `The operator queued a ${noun} that needs your go-ahead.`
          : `“${summary}”${age > 0 ? ` — queued ${age} day${age === 1 ? "" : "s"} ago.` : ""}`,
      ask: `Approve the ${noun} the operator queued${summary === noun ? "" : ` ("${summary}")`} for you.`,
      decision_id: d.id,
      is_money: isMoneyOrAuthDecisionClass(d.decision_class),
    });
  }
  for (const cc of connectors) {
    if (cc.connected || !WARN_IF_MISSING.has(cc.slug)) continue;
    attention.push({
      severity: "warn",
      title: `${cc.label} isn't connected`,
      detail: `Connect ${cc.label} so the operator can see more of your business and answer more of your questions from real data.`,
      ask: `Connect ${cc.label} so the operator can see more of my business.`,
    });
  }

  const threads: ThreadRow[] = [];
  try {
    const { data, error } = await c.sb.rpc("list_agent_threads", {
      p_agent_slug: "operator",
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

  return { kpis, attention, connectors, threads };
};
