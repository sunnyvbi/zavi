
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { callMcpTool } from "@/services/mcp/execute";

const INITIAL_WAIT_MS = 60_000;
const REPOLL_SLEEP_MS = 45_000;
const MAX_POLL_ATTEMPTS = 4;

export type CiVerdict = "green" | "red" | "pending" | "na";

export function parsePrUrl(
  url: string | null | undefined,
): { owner: string; repo: string; pull_number: number } | null {
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const pull_number = Number(m[3]);
  if (!Number.isInteger(pull_number) || pull_number <= 0) return null;
  return { owner: m[1], repo: m[2], pull_number };
}

export type CheckReadout = {
  head_sha: string;
  checks_total: number;
  checks_green: boolean;
  check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
};

export function decideCiVerdict(args: {
  readout: CheckReadout;
  first_head_sha: string | null;
}): { verdict: CiVerdict; head_sha: string } {
  const { readout, first_head_sha } = args;
  const head_sha = readout.head_sha;
  if (first_head_sha && head_sha && first_head_sha !== head_sha) {
    return { verdict: "na", head_sha };
  }
  if (!readout.checks_total || readout.check_runs.length === 0) {
    return { verdict: "na", head_sha };
  }
  const anyRed = readout.check_runs.some(
    (c) => c.status === "completed" && c.conclusion !== null && c.conclusion !== "success",
  );
  if (anyRed) return { verdict: "red", head_sha };
  const anyPending = readout.check_runs.some((c) => c.status !== "completed");
  if (anyPending) return { verdict: "pending", head_sha };
  return { verdict: "green", head_sha };
}

const VERIFY_STATUS_LINE_RE =
  /^(?:✅ tests passed|Tests couldn't run here.*|Tests failed\. See the PR\.|🟡 tests not run|⚠️ couldn't run tests in sandbox.*|⚠️ tests failed.*)$/m;

export function ciStatusLine(verdict: "green" | "red"): string {
  return verdict === "green" ? "✅ CI green" : "❌ CI red";
}

export function applyCiToNotice(body: string, verdict: "green" | "red"): string {
  const line = ciStatusLine(verdict);
  if (typeof body !== "string" || body.length === 0) return line;
  if (body.trimEnd().endsWith(line)) return body;
  if (VERIFY_STATUS_LINE_RE.test(body)) {
    return body.replace(VERIFY_STATUS_LINE_RE, line);
  }
  return `${body.trimEnd()}\n${line}`;
}

export type NoticeRefRow = {
  surface: "chat" | "slack";
  tenant_id: string;
  chat_message_id: string | null;
  slack_channel_id: string | null;
  slack_ts: string | null;
  slack_team_id: string | null;
  notice_body: string | null;
  pr_url: string | null;
  ci_status: string;
};

async function loadDecisionTenant(decision_id: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("decisions")
    .select("tenant_id")
    .eq("id", decision_id)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { tenant_id?: string }).tenant_id ?? null;
}

async function loadNoticeRefs(decision_id: string, tenant_id: string): Promise<NoticeRefRow[]> {
  const { data, error } = await serviceClient()
    .from("dispatch_notice_refs")
    .select(
      "surface, tenant_id, chat_message_id, slack_channel_id, slack_ts, slack_team_id, notice_body, pr_url, ci_status",
    )
    .eq("decision_id", decision_id)
    .eq("tenant_id", tenant_id);
  if (error || !Array.isArray(data)) return [];
  return data as NoticeRefRow[];
}

async function readPrChecks(
  tenant_id: string,
  pr: { owner: string; repo: string; pull_number: number },
): Promise<CheckReadout | null> {
  const r = await callMcpTool(
    { tenant_id, run_id: "" },
    "github",
    "list_pr_status",
    { owner: pr.owner, repo: pr.repo, pull_number: pr.pull_number },
  );
  if (r.is_error) return null;
  try {
    const j = JSON.parse(r.content) as CheckReadout;
    if (typeof j.head_sha !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

async function editNoticeRef(
  ref: NoticeRefRow,
  verdict: "green" | "red",
): Promise<void> {
  const newBody = applyCiToNotice(ref.notice_body ?? "", verdict);
  if (ref.surface === "chat" && ref.chat_message_id) {
    const { error } = await serviceClient()
      .from("agent_thread_messages")
      .update({ body: newBody })
      .eq("id", ref.chat_message_id)
      .eq("tenant_id", ref.tenant_id);
    if (error) {
      console.warn(
        `[engineer-pr-ci-readback] chat edit failed for msg ${ref.chat_message_id}: ${error.message}`,
      );
    }
    return;
  }
  if (ref.surface === "slack") {
    void newBody;
    return;
  }
}

export const engineerPrCiReadbackFn = inngest.createFunction(
  {
    id: "engineer-pr-ci-readback",
    idempotency: "event.data.decision_id",
    retries: 2,
  },
  { event: "engineer.pr.ci.readback.requested" },
  async ({ event, step, logger }) => {
    const data = event.data;
    if (!data?.decision_id || !data?.tenant_id) {
      throw new Error("engineer-pr-ci-readback: missing decision_id or tenant_id");
    }

    const ctx = await step.run("load-decision", async () => {
      const rowTenant = await loadDecisionTenant(data.decision_id);
      if (!rowTenant) return { ok: false as const, reason: "decision_not_found" };
      if (rowTenant !== data.tenant_id) {
        return { ok: false as const, reason: `tenant_mismatch:${rowTenant}` };
      }
      const refs = await loadNoticeRefs(data.decision_id, rowTenant);
      return { ok: true as const, tenant_id: rowTenant, refs };
    });
    if (!ctx.ok) {
      logger.warn(`engineer-pr-ci-readback: ${ctx.reason} — skipping`);
      return { status: "skip", reason: ctx.reason };
    }
    if (ctx.refs.length === 0) {
      return { status: "skip", reason: "no_notice_refs" };
    }
    const prUrl = ctx.refs.map((r) => r.pr_url).find((u) => typeof u === "string") ?? null;
    const pr = parsePrUrl(prUrl);
    if (!pr) return { status: "skip", reason: "no_pr_url" };

    await step.sleep("wait-ci-start", `${INITIAL_WAIT_MS}ms`);

    let firstHeadSha: string | null = null;
    let verdict: CiVerdict = "na";
    let headSha = "";
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const readout = (await step.run(`poll-${i}`, async () => readPrChecks(ctx.tenant_id, pr))) as
        | CheckReadout
        | null;
      if (!readout) {
        verdict = "na";
        break;
      }
      if (firstHeadSha === null) firstHeadSha = readout.head_sha;
      const d = decideCiVerdict({ readout, first_head_sha: firstHeadSha });
      verdict = d.verdict;
      headSha = d.head_sha;
      if (verdict !== "pending") break;
      if (i < MAX_POLL_ATTEMPTS - 1) {
        await step.run(`mark-verifying-${i}`, async () => {
          await serviceClient().rpc("set_dispatch_notice_ci", {
            p_decision_id: data.decision_id,
            p_head_sha: headSha || null,
            p_ci_status: "verifying",
          });
        });
        await step.sleep(`repoll-${i}`, `${REPOLL_SLEEP_MS}ms`);
      }
    }
    const finalStatus: "green" | "red" | "na" = verdict === "green" || verdict === "red" ? verdict : "na";

    await step.run("record-ci", async () => {
      await serviceClient().rpc("set_dispatch_notice_ci", {
        p_decision_id: data.decision_id,
        p_head_sha: headSha || null,
        p_ci_status: finalStatus,
      });
    });

    if (finalStatus === "green" || finalStatus === "red") {
      await step.run("edit-notices", async () => {
        for (const ref of ctx.refs) {
          if (ref.ci_status === "green" || ref.ci_status === "red" || ref.ci_status === "na") continue;
          await editNoticeRef(ref, finalStatus);
        }
      });
    }

    logger.info(
      `engineer-pr-ci-readback: decision=${data.decision_id} verdict=${finalStatus} head=${headSha} refs=${ctx.refs.length}`,
    );
    return { status: "ok", verdict: finalStatus, head_sha: headSha || null };
  },
);
