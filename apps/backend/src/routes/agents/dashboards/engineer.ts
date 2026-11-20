import type { DashboardBuilder } from "./_contract";

type PrStatus = "open" | "merged" | "proposed" | "unknown";

const STALE_PR_DAYS = 14;

type WarnFlag =
  | "tests_warning"
  | "wiring_unverified"
  | "completeness_unverified";

type Typecheck = "green" | "red" | "not_reported";
type PrSignals = {
  risk_class: "trivial" | "low" | "medium" | null;
  typecheck: Typecheck;
  tests: { passed: number; failed: number; ran: boolean };
};

type PrRow = {
  run_id: string;
  number: number | null;
  title: string;
  repo: string;
  status: PrStatus;
  url: string | null;
  opened_at: string | null;
  warn_flags: WarnFlag[];
  signals: PrSignals;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

type RunRow = {
  id: string;
  status: string | null;
  parsed: Record<string, unknown> | null;
  enqueued_at: string | null;
  output_text: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function warnFlags(parsed: Record<string, unknown>): WarnFlag[] {
  const flags: WarnFlag[] = [];
  if (parsed.tests_warning === "tests_missing") flags.push("tests_warning");
  if (parsed.wiring_unverified === true) flags.push("wiring_unverified");
  if (parsed.completeness_unverified === true)
    flags.push("completeness_unverified");
  return flags;
}

function prSignals(parsed: Record<string, unknown>): PrSignals {
  const rc = parsed.risk_class;
  const risk_class =
    rc === "trivial" || rc === "low" || rc === "medium" ? rc : null;

  const tc = parsed.typecheck_ok;
  const typecheck: Typecheck =
    tc === true ? "green" : tc === false ? "red" : "not_reported";

  let passed = 0;
  let failed = 0;
  const tr = parsed.test_results;
  if (tr && typeof tr === "object") {
    passed = asNumber((tr as Record<string, unknown>).passed) ?? 0;
    failed = asNumber((tr as Record<string, unknown>).failed) ?? 0;
  }
  const ran = passed + failed > 0;

  return { risk_class, typecheck, tests: { passed, failed, ran } };
}

function warnLabel(flag: WarnFlag): string {
  switch (flag) {
    case "tests_warning":
      return "no passing test run";
    case "wiring_unverified":
      return "a possibly-unwired new export";
    case "completeness_unverified":
      return "completeness self-report unconfirmed";
  }
}

export const build: DashboardBuilder = async (c) => {
  let rows: RunRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id,status,parsed,enqueued_at,output_text")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "engineer")
      .order("enqueued_at", { ascending: false })
      .limit(200);
    if (error) {
      return { connected: false };
    }
    rows = (data ?? []) as RunRow[];
  } catch {
    return { connected: false };
  }

  if (rows.length === 0) {
    return { connected: false };
  }

  const now = Date.now();
  const THIRTY_DAYS = 30 * 86400 * 1000;

  const prs: PrRow[] = [];
  let shippedNoPr = 0;

  const mergeWebhookProven = rows.some(
    (r) => ((r.parsed ?? {}) as Record<string, unknown>).merged === true,
  );

  for (const r of rows) {
    const parsed = (r.parsed ?? {}) as Record<string, unknown>;
    const prUrl = str(parsed.pr_url);
    const prRepo = str(parsed.pr_repo) ?? "unknown repo";
    const prNumber = asNumber(parsed.pr_number);
    const merged = parsed.merged === true;
    const openedAt = str(r.enqueued_at);

    if (prUrl) {
      const openedMs = openedAt ? new Date(openedAt).getTime() : NaN;
      const stale =
        Number.isFinite(openedMs) && now - openedMs > STALE_PR_DAYS * 86400 * 1000;
      const status: PrStatus = merged
        ? "merged"
        : !mergeWebhookProven && stale
          ? "unknown"
          : prNumber != null
            ? "open"
            : "proposed";
      prs.push({
        run_id: r.id,
        number: prNumber,
        title:
          str(parsed.title) ??
          str(parsed.pr_title) ??
          (str(r.output_text)?.split("\n")[0]?.slice(0, 120) ?? "Pull request"),
        repo: prRepo,
        status,
        url: prUrl,
        opened_at: openedAt,
        warn_flags: warnFlags(parsed),
        signals: prSignals(parsed),
      });
    } else if (r.status === "success") {
      shippedNoPr += 1;
    }
  }

  const openedLast30d = prs.filter((p) => {
    if (!p.opened_at) return false;
    const t = new Date(p.opened_at).getTime();
    return Number.isFinite(t) && now - t <= THIRTY_DAYS;
  }).length;
  const mergedCount = prs.filter((p) => p.status === "merged").length;
  const awaitingMerge = prs.filter(
    (p) => p.status === "open" || p.status === "proposed",
  );
  const awaitingCount = awaitingMerge.length;
  const unknownCount = prs.filter((p) => p.status === "unknown").length;

  const attention: AttentionItem[] = [];
  for (const p of awaitingMerge) {
    const ref = p.number != null ? `#${p.number}` : "(proposed)";
    if (p.warn_flags.length > 0) {
      const reasons = p.warn_flags.map(warnLabel).join(", ");
      attention.push({
        severity: "high",
        title: `PR ${ref} in ${p.repo} shipped without a clean pass`,
        detail: `This PR has ${reasons}. Review the diff before you merge it.`,
        ask:
          p.number != null
            ? `PR #${p.number} shipped without a clean test pass — show me the diff before I merge`
            : `That proposed PR shipped without a clean test pass — show me the diff before I merge`,
      });
    } else {
      attention.push({
        severity: "warn",
        title: `PR ${ref} in ${p.repo} is waiting on your merge`,
        detail: `"${p.title}" is open and unmerged. Auto-merge stays gated on you.`,
        ask:
          p.number != null
            ? `Merge PR #${p.number} in ${p.repo}`
            : `Open the proposed PR in ${p.repo}`,
      });
    }
  }
  if (unknownCount > 0) {
    attention.push({
      severity: "warn",
      title: `${unknownCount} PR${unknownCount === 1 ? "" : "s"} with no merge signal`,
      detail:
        `${unknownCount === 1 ? "This PR" : "These PRs"} opened more than ${STALE_PR_DAYS} days ago, and we have never received a single merge event ` +
        `for this workspace, so we can't tell you whether ${unknownCount === 1 ? "it" : "they"} shipped. That points at the GitHub webhook, not at you.`,
      ask: "Why can't Zavi tell whether my older PRs merged? Check the GitHub webhook.",
    });
  }

  attention.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1,
  );

  const recent = prs.slice(0, 30);

  return {
    connected: true,
    kpis: {
      opened_30d: openedLast30d,
      merged: mergedCount,
      awaiting_merge: awaitingCount,
      unknown_state: unknownCount,
      no_pr_runs: shippedNoPr,
    },
    attention,
    prs: recent,
  };
};
