
import { serviceClient } from "@/services/supabase";
import {
  computeCosDispatchPrecision,
  renderCosPrecisionBlock,
  type CosDispatchPrecision,
} from "./chief-of-staff-precision";
import { isCosPrecisionCalibrationEnabled } from "./chief-of-staff-precision-flag";
import { workspaceUrl } from "@/services/web-base";

const COS_SLUG = "chief-of-staff";

const DISPATCH_SPECIALIST_CLASS = "chief-of-staff.dispatch-specialist";

const COMMITMENT_LIMIT = 25;
const COMMITMENT_INTENT_CAP = 180;
const DISPATCH_ERROR_CAP = 160;

const PRIOR_DIGEST_COUNT = 2;
const PRIOR_DIGEST_CAP = 700;
const ACTIVITY_LIMIT = 40;
const ACTIVITY_SNIPPET_CAP = 240;

export type PriorDigest = {
  finished_at: string;
  text: string;
};

export type ActivitySinceRow = {
  agent_slug: string;
  status: string;
  finished_at: string;
  snippet: string;
};

export type DispatchCommitmentRow = {
  decision_id: string;
  target_agent_slug: string;
  intent: string;
  decision_status: string;
  emitted_at: string;
  dispatched_at: string | null;
  dispatch_error: string | null;
  run_status: string | null;
  run_finished_at: string | null;
};

export type ChiefOfStaffContinuity = {
  since: string | null;
  prior_digests: PriorDigest[];
  activity_since: ActivitySinceRow[];
  commitments: DispatchCommitmentRow[];
  pending_approvals: number;
  precision: CosDispatchPrecision | null;
};

function cap(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s;
}

export function approvalsDeepLink(): string {
  return `${workspaceUrl()}?agent=chief-of-staff`;
}

export async function loadChiefOfStaffContinuity(
  tenant_id: string,
): Promise<ChiefOfStaffContinuity | null> {
  try {
    const client = serviceClient();

    const precision = await loadPrecisionCalibration(tenant_id);

    const { data: priorRows, error: priorErr } = await client
      .from("agent_runs")
      .select("finished_at, output_text")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", COS_SLUG)
      .eq("status", "success")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(PRIOR_DIGEST_COUNT);

    if (priorErr) {
      console.warn(
        `[cos-continuity] prior-digest load failed for ${tenant_id}: ${priorErr.message}`,
      );
      return null;
    }

    const prior_digests: PriorDigest[] = (priorRows ?? []).map((r) => ({
      finished_at: String(r.finished_at ?? ""),
      text: cap(String(r.output_text ?? ""), PRIOR_DIGEST_CAP),
    }));

    if (prior_digests.length === 0) {
      return {
        since: null,
        prior_digests: [],
        activity_since: [],
        commitments: [],
        pending_approvals: 0,
        precision,
      };
    }

    const since = prior_digests[0].finished_at;

    const { data: actRows, error: actErr } = await client
      .from("agent_runs")
      .select("agent_slug, status, finished_at, output_text")
      .eq("tenant_id", tenant_id)
      .neq("agent_slug", COS_SLUG)
      .gt("finished_at", since)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(ACTIVITY_LIMIT);

    const activity_since: ActivitySinceRow[] = actErr
      ? []
      : (actRows ?? []).map((r) => ({
          agent_slug: String(r.agent_slug ?? ""),
          status: String(r.status ?? ""),
          finished_at: String(r.finished_at ?? ""),
          snippet: cap(String(r.output_text ?? ""), ACTIVITY_SNIPPET_CAP),
        }));

    if (actErr) {
      console.warn(
        `[cos-continuity] activity-since load failed for ${tenant_id}: ${actErr.message}`,
      );
    }

    const { commitments, pending_approvals } = await loadCommitmentLedger(
      client,
      tenant_id,
      since,
    );

    return {
      since,
      prior_digests,
      activity_since,
      commitments,
      pending_approvals,
      precision,
    };
  } catch (e) {
    console.warn(
      `[cos-continuity] threw for ${tenant_id}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function loadPrecisionCalibration(
  tenant_id: string,
): Promise<CosDispatchPrecision | null> {
  try {
    if (!(await isCosPrecisionCalibrationEnabled())) return null;
    return await computeCosDispatchPrecision(tenant_id);
  } catch (e) {
    console.warn(
      `[cos-continuity] precision calibration load failed for ${tenant_id}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function loadCommitmentLedger(
  client: ReturnType<typeof serviceClient>,
  tenant_id: string,
  since: string,
): Promise<{ commitments: DispatchCommitmentRow[]; pending_approvals: number }> {
  try {
    const { data: decRows, error: decErr } = await client
      .from("decisions")
      .select("id, body, status, dispatch_error, dispatched_at, emitted_at")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", DISPATCH_SPECIALIST_CLASS)
      .gt("emitted_at", since)
      .order("emitted_at", { ascending: false })
      .limit(COMMITMENT_LIMIT);

    if (decErr) {
      console.warn(
        `[cos-continuity] commitment-ledger decisions load failed for ${tenant_id}: ${decErr.message}`,
      );
      return { commitments: [], pending_approvals: 0 };
    }

    const decisions = decRows ?? [];
    if (decisions.length === 0) {
      return { commitments: [], pending_approvals: 0 };
    }

    const decisionIds = decisions.map((d) => String(d.id));
    const runByDecisionId = new Map<
      string,
      { status: string; finished_at: string | null }
    >();
    const { data: runRows, error: runErr } = await client
      .from("agent_runs")
      .select("status, finished_at, payload")
      .eq("tenant_id", tenant_id)
      .in("payload->>source_decision_id", decisionIds);

    if (runErr) {
      console.warn(
        `[cos-continuity] commitment-ledger run-join load failed for ${tenant_id}: ${runErr.message}`,
      );
    } else {
      for (const r of runRows ?? []) {
        const sdid =
          r.payload && typeof r.payload === "object"
            ? (r.payload as { source_decision_id?: unknown }).source_decision_id
            : undefined;
        if (typeof sdid === "string" && sdid) {
          if (!runByDecisionId.has(sdid)) {
            runByDecisionId.set(sdid, {
              status: String(r.status ?? ""),
              finished_at: r.finished_at ? String(r.finished_at) : null,
            });
          }
        }
      }
    }

    let pending_approvals = 0;
    const commitments: DispatchCommitmentRow[] = decisions.map((d) => {
      const body = (d.body ?? {}) as {
        target_agent_slug?: unknown;
        intent?: unknown;
      };
      const status = String(d.status ?? "proposed");
      if (status === "proposed") pending_approvals += 1;
      const run = runByDecisionId.get(String(d.id));
      return {
        decision_id: String(d.id),
        target_agent_slug:
          typeof body.target_agent_slug === "string"
            ? body.target_agent_slug
            : "",
        intent: cap(
          typeof body.intent === "string" ? body.intent : "",
          COMMITMENT_INTENT_CAP,
        ),
        decision_status: status,
        emitted_at: String(d.emitted_at ?? ""),
        dispatched_at: d.dispatched_at ? String(d.dispatched_at) : null,
        dispatch_error: d.dispatch_error
          ? cap(String(d.dispatch_error), DISPATCH_ERROR_CAP)
          : null,
        run_status: run ? run.status : null,
        run_finished_at: run ? run.finished_at : null,
      };
    });

    return { commitments, pending_approvals };
  } catch (e) {
    console.warn(
      `[cos-continuity] commitment-ledger threw for ${tenant_id}: ${(e as Error).message}`,
    );
    return { commitments: [], pending_approvals: 0 };
  }
}

export function renderContinuityBlock(c: ChiefOfStaffContinuity): string {
  const precisionBlock = c.precision ? renderCosPrecisionBlock(c.precision) : "";

  if (c.prior_digests.length === 0) {
    if (!precisionBlock) return "";
    return [
      "\n\n---",
      "## Your continuity (promotion-gate calibration)",
      precisionBlock,
    ].join("\n");
  }

  const priorSection = c.prior_digests
    .map(
      (d, i) =>
        `#### Prior digest ${i === 0 ? "(most recent)" : `(${i + 1} back)`} — ${d.finished_at}\n${d.text}`,
    )
    .join("\n\n");

  let activitySection: string;
  if (c.activity_since.length === 0) {
    activitySection =
      "_No specialist agent has run since your last digest. Any Tier-1 item you raised last time that needed a dispatch was NOT acted on — re-surface it if still live, and say it has been open since the prior digest._";
  } else {
    const lines = c.activity_since
      .map(
        (a) =>
          `- **${a.agent_slug}** — \`${a.status}\` @ ${a.finished_at}: ${a.snippet}`,
      )
      .join("\n");
    activitySection = `These specialist runs completed since your last digest (${c.since}). Use them to close the loop — acknowledge what was acted on and its outcome, and do NOT re-raise an item a successful run already resolved:\n\n${lines}`;
  }

  return [
    "\n\n---",
    "## Your continuity (what you already told the founder + what happened since)",
    "This is YOUR OWN prior output plus the fleet activity that followed it. Open the digest by reconciling against it: which prior Tier-1 items are now resolved (drop them), which are still open (mark how many days running), and which were never acted on (re-surface with that context). Never present a stale item as brand-new.",
    "",
    "### What you surfaced last time",
    priorSection,
    "",
    "### What the fleet did since",
    activitySection,
    "",
    renderCommitmentSection(c),
    precisionBlock ? `\n${precisionBlock}` : "",
  ].join("\n");
}

function renderCommitmentSection(c: ChiefOfStaffContinuity): string {
  const commitments = c.commitments ?? [];
  const pendingApprovals = c.pending_approvals ?? 0;
  if (commitments.length === 0) {
    return [
      "### Your commitment ledger (ground truth — read THIS for accountability)",
      "_You emitted no dispatch-specialist decisions since your last digest, so there are no approved/rejected dispatch commitments to grade. Do NOT fabricate `missed` accountability rows for dispatches you never proposed. (Text Tier-1 items you raised without a `suggested_dispatch` are not commitments — only an emitted dispatch is.)_",
    ].join("\n");
  }

  const rows = commitments
    .map((m) => {
      const verdict = commitmentVerdict(m);
      const errSuffix = m.dispatch_error
        ? ` — dispatch error: ${m.dispatch_error}`
        : "";
      const runSuffix =
        m.run_status !== null
          ? `; run \`${m.run_status}\`${m.run_finished_at ? ` @ ${m.run_finished_at}` : ""}`
          : "";
      return `- **${m.target_agent_slug || "(unknown)"}** — "${m.intent}" → founder verdict: **${verdict}** (decision \`${m.decision_status}\`, proposed ${m.emitted_at}${runSuffix})${errSuffix}`;
    })
    .join("\n");

  const pending =
    pendingApprovals > 0
      ? `\n\n**${pendingApprovals} of these dispatch${pendingApprovals === 1 ? " is" : "es are"} still awaiting your founder's click (status \`proposed\`)** — surface them as "pending your approval", NEVER as "missed". These are the founder's "what needs my click" items: deep-link them to ${approvalsDeepLink()} in your digest's "Needs your click" line.`
      : "";

  return [
    "### Your commitment ledger (ground truth — read THIS for accountability)",
    "Each row below is a dispatch you proposed and the founder's ACTUAL verdict on it, from the decisions ledger (not inferred from prose). When you build `accountability[]`, map status from THIS, not from the digest text above:",
    "- founder **APPROVED + run succeeded** → `delivered`",
    "- founder **APPROVED + run still running / no terminal run** → `in_progress`",
    "- founder **APPROVED but no run yet** (or run failed) → `in_progress` (or flag the dispatch error)",
    "- founder **REJECTED** → this is NOT a miss. The founder consciously declined it — drop it or note it as declined; NEVER mark a rejected dispatch `missed` (that is prompt theater).",
    "- decision **expired** without a click → treat as a lapsed proposal, surface as `in_progress`/pending-context, not `missed`.",
    "- still **proposed** (awaiting the click) → pending approval, not `missed`.",
    "Only mark `missed` a commitment the founder approved that then produced no run AND has no pending/error explanation.",
    "",
    rows + pending,
  ].join("\n");
}

function commitmentVerdict(m: DispatchCommitmentRow): string {
  switch (m.decision_status) {
    case "rejected":
      return "REJECTED (declined — not a miss)";
    case "expired":
      return "EXPIRED (lapsed without a click)";
    case "proposed":
      return "PENDING your approval";
    case "approved":
    case "acted":
    case "dispatched":
      if (m.run_status === "success") return "APPROVED → delivered";
      if (m.run_status === "running" || m.run_status === "queued")
        return "APPROVED → in progress";
      if (m.run_status && m.run_status !== "success")
        return `APPROVED → run ${m.run_status}`;
      if (m.dispatch_error) return "APPROVED → dispatch failed";
      return "APPROVED → no run yet";
    default:
      return m.decision_status || "unknown";
  }
}
