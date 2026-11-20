import type { DashboardBuilder } from "./_contract";

type Role = "guest" | "host" | "public";

type CaseRow = {
  id: string;
  title: string;
  role: Role;
  source: "agent-onboarding" | "operator-chat" | "other";
  created_at: string | null;
  manual_tested_at: string | null;
};

type LastExecStatus = "passed" | "failed" | "healed" | "errored" | null;

type BrittleCase = {
  id: string;
  title: string;
  role: Role;
  consecutive_red: number;
  last_run_at: string | null;
};

type RunSummary = {
  at: string | null;
  ran: number;
  pass: number;
  fail: number;
  blocked: number;
  pass_rate: number | null;
};

type Execution = {
  latest: RunSummary | null;
  trend: Array<{ at: string | null; pass_rate: number | null }>;
  red_now: number;
  brittle: BrittleCase[];
  healed: number;
  last_executed_at: string | null;
};

type ReportRow = {
  id: string;
  filename: string;
  created_at: string | null;
  slack_delivered: boolean;
};

type InFlight = {
  started_at: string | null;
  total: number;
  done: number;
};

type Attention = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

function normRole(raw: unknown): Role | null {
  return raw === "guest" || raw === "host" || raw === "public" ? raw : null;
}

function normSource(raw: unknown): CaseRow["source"] {
  return raw === "agent-onboarding" || raw === "operator-chat" ? raw : "other";
}

function normExecStatus(raw: unknown): LastExecStatus {
  return raw === "passed" ||
    raw === "failed" ||
    raw === "healed" ||
    raw === "errored"
    ? raw
    : null;
}

const BRITTLE_THRESHOLD = 3;
const MAX_BRITTLE = 6;
const MAX_TREND_RUNS = 8;

function parseDigestBody(body: unknown, emittedAt: string | null): RunSummary | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const tier1 = Array.isArray(b.tier1) ? b.tier1 : null;
  const tier3 = Array.isArray(b.tier3) ? b.tier3 : null;
  const tier4 = Array.isArray(b.tier4) ? b.tier4 : null;
  const summary =
    tier4 && tier4[0] && typeof (tier4[0] as Record<string, unknown>).summary === "string"
      ? String((tier4[0] as Record<string, unknown>).summary)
      : null;
  if (!summary) return null;
  const m = summary.match(
    /Ran\s+(\d+):\s*(\d+)\s*pass\s*\/\s*(\d+)\s*fail\s*\/\s*(\d+)\s*blocked/i,
  );
  if (!m) return null;
  const ran = Number(m[1]);
  const passStr = Number(m[2]);
  const failStr = Number(m[3]);
  const blockedStr = Number(m[4]);
  const fail = tier1 ? tier1.length : failStr;
  const blocked = tier3 ? tier3.length : blockedStr;
  const pass = Math.max(0, passStr);
  const denom = pass + fail;
  const pass_rate = denom > 0 ? Math.round((pass / denom) * 100) : null;
  return { at: emittedAt, ran, pass, fail, blocked, pass_rate };
}

export const build: DashboardBuilder = async (c) => {
  const cases: CaseRow[] = [];
  const execRows: Array<{
    id: string;
    title: string;
    role: Role;
    status: string;
    last_status: LastExecStatus;
    consecutive_red: number;
    last_run_at: string | null;
    last_healed_at: string | null;
  }> = [];
  try {
    const { data, error } = await c.sb
      .from("test_cases")
      .select(
        "id,title,role,status,created_by,created_at,manual_tested_at,last_status,consecutive_red,last_run_at,last_healed_at",
      )
      .eq("tenant_id", c.tenantId)
      .in("status", ["active", "muted"])
      .order("created_at", { ascending: false })
      .limit(1000);
    if (!error && Array.isArray(data)) {
      for (const r of data as Array<Record<string, unknown>>) {
        const role = normRole(r.role);
        if (!role) continue;
        const id = String(r.id ?? "");
        const title = String(r.title ?? "");
        const status = String(r.status ?? "active");
        if (status === "active") {
          cases.push({
            id,
            title,
            role,
            source: normSource(r.created_by),
            created_at: r.created_at ? String(r.created_at) : null,
            manual_tested_at: r.manual_tested_at
              ? String(r.manual_tested_at)
              : null,
          });
        }
        execRows.push({
          id,
          title,
          role,
          status,
          last_status: normExecStatus(r.last_status),
          consecutive_red:
            typeof r.consecutive_red === "number" && r.consecutive_red >= 0
              ? r.consecutive_red
              : 0,
          last_run_at: r.last_run_at ? String(r.last_run_at) : null,
          last_healed_at: r.last_healed_at ? String(r.last_healed_at) : null,
        });
      }
    }
  } catch {
  }

  const counts = {
    guest: cases.filter((x) => x.role === "guest").length,
    host: cases.filter((x) => x.role === "host").length,
    public: cases.filter((x) => x.role === "public").length,
  };
  const total = cases.length;

  const reports: ReportRow[] = [];
  try {
    const { data: runs } = await c.sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "qa")
      .order("enqueued_at", { ascending: false })
      .limit(200);
    const runIds = Array.isArray(runs)
      ? (runs as Array<Record<string, unknown>>)
          .map((r) => (r.id ? String(r.id) : null))
          .filter((x): x is string => x !== null)
      : [];
    if (runIds.length > 0) {
      const { data, error } = await c.sb
        .from("run_artifacts")
        .select("id,filename,mime,created_at,slack_delivered")
        .eq("tenant_id", c.tenantId)
        .in("run_id", runIds)
        .eq("mime", "application/pdf")
        .order("created_at", { ascending: false })
        .limit(10);
      if (!error && Array.isArray(data)) {
        for (const r of data as Array<Record<string, unknown>>) {
          reports.push({
            id: String(r.id ?? ""),
            filename: String(r.filename ?? "report.pdf"),
            created_at: r.created_at ? String(r.created_at) : null,
            slack_delivered: Boolean(r.slack_delivered),
          });
        }
      }
    }
  } catch {
  }

  let execution: Execution | undefined;
  try {
    const { data: digests } = await c.sb
      .from("decisions")
      .select("body,emitted_at")
      .eq("tenant_id", c.tenantId)
      .eq("decision_class", "qa.weekly-digest")
      .order("emitted_at", { ascending: false })
      .limit(MAX_TREND_RUNS);

    const runs: RunSummary[] = [];
    if (Array.isArray(digests)) {
      for (const d of digests as Array<Record<string, unknown>>) {
        const parsed = parseDigestBody(
          d.body,
          d.emitted_at ? String(d.emitted_at) : null,
        );
        if (parsed) runs.push(parsed);
      }
    }

    const everExecuted = execRows.some((r) => r.last_run_at !== null);
    const redNow = execRows.filter(
      (r) => r.last_status === "failed" || r.last_status === "errored",
    ).length;
    const healed = execRows.filter((r) => r.last_status === "healed").length;
    const brittle: BrittleCase[] = execRows
      .filter(
        (r) =>
          r.consecutive_red >= BRITTLE_THRESHOLD &&
          (r.last_status === "failed" || r.last_status === "errored"),
      )
      .sort((a, b) => b.consecutive_red - a.consecutive_red)
      .slice(0, MAX_BRITTLE)
      .map((r) => ({
        id: r.id,
        title: r.title,
        role: r.role,
        consecutive_red: r.consecutive_red,
        last_run_at: r.last_run_at,
      }));
    const lastExecutedAt = execRows.reduce<string | null>((acc, r) => {
      if (!r.last_run_at) return acc;
      if (!acc || r.last_run_at > acc) return r.last_run_at;
      return acc;
    }, null);

    if (runs.length > 0 || everExecuted) {
      execution = {
        latest: runs[0] ?? null,
        trend: runs
          .slice()
          .reverse()
          .map((r) => ({ at: r.at, pass_rate: r.pass_rate })),
        red_now: redNow,
        brittle,
        healed,
        last_executed_at: lastExecutedAt,
      };
    }
  } catch {
  }

  let in_flight: InFlight | null = null;
  try {
    const windowCutoff = new Date(Date.now() - 50 * 60_000).toISOString();
    const { data } = await c.sb
      .from("agent_runs")
      .select("status, enqueued_at, correlation_id:payload->>correlation_id")
      .eq("tenant_id", c.tenantId)
      .eq("trigger", "qa-weekly-execute")
      .gt("enqueued_at", windowCutoff)
      .order("enqueued_at", { ascending: true })
      .limit(60);
    const rows = (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [])
      .map((r) => ({
        status: String(r.status ?? ""),
        at: r.enqueued_at ? String(r.enqueued_at) : null,
        cid:
          typeof r.correlation_id === "string" && r.correlation_id.length > 0
            ? r.correlation_id
            : null,
      }))
      .filter((r): r is { status: string; at: string; cid: string | null } => r.at !== null);
    const isActive = (s: string) =>
      s === "queued" || s === "running" || s === "blocked";
    const activeRows = rows.filter((r) => isActive(r.status));
    if (activeRows.length > 0) {
      const newestActive = activeRows.reduce((a, b) => (b.at > a.at ? b : a));
      const batch =
        newestActive.cid !== null
          ? rows.filter((r) => r.cid === newestActive.cid)
          : [newestActive];
      const total = batch.length;
      const stillActive = batch.filter((r) => isActive(r.status)).length;
      const done = Math.max(0, Math.min(total, total - stillActive));
      const startMs = batch.reduce(
        (min, r) => Math.min(min, new Date(r.at).getTime()),
        Number.POSITIVE_INFINITY,
      );
      in_flight = {
        started_at: Number.isFinite(startMs)
          ? new Date(startMs).toISOString()
          : null,
        total,
        done,
      };
    }
  } catch {
    in_flight = null;
  }

  const attention: Attention[] = [];
  if (total > 0) {
    const gaps: Array<{ role: Role; hint: string }> = [];
    if (counts.guest === 0) {
      gaps.push({ role: "guest", hint: "signup, search, checkout/booking" });
    }
    if (counts.host === 0) {
      gaps.push({ role: "host", hint: "listing creation, payout" });
    }
    if (counts.public === 0) {
      gaps.push({ role: "public", hint: "landing page, public pricing" });
    }
    for (const g of gaps) {
      attention.push({
        severity: "warn",
        title: `No ${g.role}-side test cases yet`,
        detail: `Your catalog has 0 ${g.role}-side cases. Key ${g.role} flows (${g.hint}) aren't covered.`,
        ask: `Add ${g.role}-side test cases for my key flows (${g.hint}).`,
      });
    }
  }
  if (execution && execution.brittle.length > 0) {
    for (const b of execution.brittle.slice(0, 3)) {
      attention.unshift({
        severity: "high",
        title: `"${b.title}" is brittle`,
        detail: `Failed ${b.consecutive_red} runs in a row — likely a selector that moved after a UI change. Needs a stable anchor.`,
        ask: `Re-anchor the selector for "${b.title}" and re-run it.`,
      });
    }
  }

  return {
    counts: { total, guest: counts.guest, host: counts.host, public: counts.public },
    cases,
    reports,
    attention,
    execution,
    in_flight,
  };
};
