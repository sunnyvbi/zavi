
import { z } from "zod";
import { PLAN_UPGRADE_REQUIRED, asPlanUpgradeRequired, type Tier } from "@/services/billing/tiers";
import { ExpectedToolError } from "@/services/tools/types";
import { SITE_PR_CLASSES } from "./site-pr-run";
import { PAGE_COPY_APPROVER_GONE, PAGE_COPY_NOT_ONE_FILE, PAGE_COPY_NOT_ON_PAGE, PAGE_COPY_NOT_PLAIN_TEXT, PAGE_COPY_READ_FAILED } from "./page-copy-check";

export const MAX_ENGINEER_TASK_CHARS = 2000;

export const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\r\n\u2028\u2029]/.test(s), { message: "must be one line" });

export const prTitleSchema = singleLine(120).refine((s) => s.trim().length > 0, { message: "title is required" });
export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200);

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function siteHost(website: string | null): { host: string } | { problem: string } {
  const host = website ? hostOf(website) : null;
  return host ? { host } : { problem: "The company's website is not set, so Zavi cannot tell whether this page is theirs." };
}

export function pageProblem(url: string, host: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "The page must be a full web address.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "The page must be a web address.";
  return hostOf(url) === host ? null : `The page must be on the company's own website (${host}).`;
}

export const q = (s: string) => JSON.stringify(s);

export type SitePrPayloadBase = { title: string; repo: string };

export type SitePrSpec<P extends SitePrPayloadBase> = {
  execClass: string;
  channel: string;
  schema: z.ZodType<P>;
  problem: (p: P, website: string | null) => string | null;
  task: (p: P) => string;
  content?: (p: P) => unknown;
};

export type SitePrDeps = {
  engineerAllowed: (tenantId: string) => Promise<{ allowed: boolean; required_tier: Tier }>;
  website: (tenantId: string) => Promise<string | null>;
  resolveRepo: (tenantId: string, repo?: string) => Promise<string>;
  enqueue: (input: {
    agent_slug: "engineer";
    tenant_id: string;
    trigger: "a2a";
    payload: Record<string, unknown>;
    cron_dedupe_key: string;
  }) => Promise<{ run_id: string | null }>;
  send: (evt: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
};

export const liveSitePrDeps: SitePrDeps = {
  engineerAllowed: async (tenantId) => {
    const { checkAgentTier } = await import("@/services/agents/entitlement");
    const d = await checkAgentTier(tenantId, "engineer");
    return { allowed: d.allowed, required_tier: d.required_tier };
  },
  website: async (tenantId) => {
    const { getCompanyFacts } = await import("@/services/company/facts");
    return (await getCompanyFacts(tenantId)).website ?? null;
  },
  resolveRepo: async (tenantId, repo) => {
    const { resolveRepoFullName } = await import("@/services/agents/repo-resolver");
    return resolveRepoFullName(repo ? { tenant_id: tenantId, repo_hint: repo } : { tenant_id: tenantId });
  },
  enqueue: async (input) => {
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    return enqueueAgentRun(input);
  },
  send: async (evt) => {
    const { inngest } = await import("@/../workers/client");
    return inngest.send(evt as never);
  },
};

const AS_A_STEP = "File this fix as an ordinary step in your digest instead.";

export async function checkSitePrProposal<P extends SitePrPayloadBase>(
  spec: SitePrSpec<P>,
  tenantId: string,
  draft: Omit<P, "repo">,
  deps: Pick<SitePrDeps, "engineerAllowed" | "website" | "resolveRepo"> = liveSitePrDeps,
): Promise<P> {
  let allowed: boolean;
  try {
    allowed = (await deps.engineerAllowed(tenantId)).allowed;
  } catch {
    throw new ExpectedToolError("site_pr_unavailable", `Could not check the plan just now. ${AS_A_STEP}`);
  }
  if (!allowed) {
    throw new ExpectedToolError("site_pr_plan", `Opening a pull request needs the Pro plan, which this workspace is not on. ${AS_A_STEP}`);
  }
  let repo: string;
  try {
    repo = await deps.resolveRepo(tenantId);
  } catch {
    throw new ExpectedToolError(
      "site_pr_no_repo",
      `No GitHub repository is connected (or several are and none is the default), so Zavi cannot open a pull request. ${AS_A_STEP}`,
    );
  }
  const parsed = spec.schema.safeParse({ ...draft, repo });
  if (!parsed.success) {
    throw new ExpectedToolError("site_pr_invalid", `These values cannot become a pull request: ${parsed.error.issues[0]?.message ?? "invalid"}. ${AS_A_STEP}`);
  }
  const problem = spec.problem(parsed.data, await deps.website(tenantId).catch(() => null));
  if (problem) throw new ExpectedToolError("site_pr_invalid", `${problem} ${AS_A_STEP}`);
  if (spec.task(parsed.data).length > MAX_ENGINEER_TASK_CHARS) {
    throw new ExpectedToolError("site_pr_too_long", "Too much for one card. Split it across two calls.");
  }
  return parsed.data;
}

export type SitePrRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  body: Record<string, unknown>;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source?: string;
  claim_id?: string | null;
};

export type SitePrResult = { ok: boolean; error?: string; deferred?: boolean; code?: string };

export function sitePrRunKey(actionId: string, claimId: string): string {
  return `site-pr:${actionId}:${claimId}`;
}

export const SITE_PR_STARTED_EVENT = "site.pr.started";

export const GITHUB_UNREACHABLE =
  "Zavi cannot reach that repository on GitHub any more, so no pull request was opened. Reconnect GitHub in Settings, then press Try again.";

export async function startSitePullRequest<P extends SitePrPayloadBase>(
  spec: SitePrSpec<P>,
  row: SitePrRow,
  deps: Partial<SitePrDeps> = {},
): Promise<SitePrResult> {
  const d = { ...liveSitePrDeps, ...deps };

  if (row.exec_source !== "channel_actions" || !row.claim_id) {
    return { ok: false, error: "This pull request can only be opened from its card." };
  }
  if (row.approved_by_source != null || !row.approved_by) {
    return { ok: false, error: "A person in your workspace has to approve this pull request. Nothing was opened." };
  }
  const parsed = spec.schema.safeParse(row.body);
  if (!parsed.success) {
    return { ok: false, error: "This card's changes could not be read, so no pull request was opened." };
  }
  const payload = parsed.data;

  let tier: { allowed: boolean; required_tier: Tier };
  try {
    tier = await d.engineerAllowed(row.tenant_id);
  } catch {
    return { ok: false, error: "Zavi could not check your plan just now, so no pull request was opened. Press Try again in a minute." };
  }
  if (!tier.allowed) {
    const { planUpgradeMessage } = await import("@/services/agents/entitlement");
    return {
      ok: false,
      error: `${planUpgradeMessage("engineer", tier.required_tier)} No pull request was opened.`,
      code: PLAN_UPGRADE_REQUIRED,
    };
  }

  const problem = spec.problem(payload, await d.website(row.tenant_id).catch(() => null));
  if (problem) return { ok: false, error: `${problem} No pull request was opened.` };

  let repo: string;
  try {
    repo = await d.resolveRepo(row.tenant_id, payload.repo);
  } catch {
    return { ok: false, error: GITHUB_UNREACHABLE, code: "github_not_connected" };
  }

  const run_key = sitePrRunKey(row.id, row.claim_id);
  const content = spec.content?.(payload);
  try {
    await d.enqueue({
      agent_slug: "engineer",
      tenant_id: row.tenant_id,
      trigger: "a2a",
      cron_dedupe_key: run_key,
      payload: {
        source_agent: spec.channel,
        source_run_id: row.agent_run_id,
        task_description: spec.task(payload),
        repo_hint: repo,
        context_summary: `Approved ${spec.channel} channel card: ${payload.title}`.slice(0, 500),
        ...(content !== undefined ? { site_pr_content: content } : {}),
        site_pr_card: { action_id: row.id, claim_id: row.claim_id, exec_class: spec.execClass, approved_by: row.approved_by ?? null },
      },
    });
  } catch (e) {
    const plan = asPlanUpgradeRequired(e);
    if (plan) return { ok: false, error: `${plan.message} No pull request was opened.`, code: PLAN_UPGRADE_REQUIRED };
    const name = (e as Error)?.name ?? "";
    if (name === "InsufficientCreditsError") {
      return { ok: false, error: "Your workspace is out of credits, so no pull request was opened. Top up, then press Try again.", code: "insufficient_credits" };
    }
    if (name === "SandboxRepoAccessRequiredError") return { ok: false, error: GITHUB_UNREACHABLE, code: "github_not_connected" };
    return { ok: false, error: "The pull request could not be started. Nothing was opened. Press Try again." };
  }
  const evt = { id: run_key, name: SITE_PR_STARTED_EVENT, data: { run_key, tenant_id: row.tenant_id } };
  try {
    await d.send(evt);
  } catch {
    try {
      await d.send(evt);
    } catch (e) {
      console.error(`[site-pr] start event not sent for action ${row.id}; the card will not settle on its own: ${(e as Error).message}`);
    }
  }
  return { ok: true, deferred: true };
}

export { SITE_PR_CLASSES };

export type SettleRun = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  enqueued_by: string | null;
  payload: unknown;
  parsed: unknown;
};

export type ShipPrDecision = { id: string; status: string; dispatch_error?: string | null; files?: string[] };

export type SitePrCardRef = { action_id: string; claim_id: string; exec_class: string };

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "done",
  "failed",
  "error",
  "parse_failed",
  "cancelled",
  "dispatch_error",
]);

const SHIP_PR_PENDING: ReadonlySet<string> = new Set(["proposed", "approved", "dispatching"]);

export function isPageCopyRun(run: Pick<SettleRun, "payload">): boolean {
  const c = (run.payload as { site_pr_content?: { page_copy?: unknown } } | null)?.site_pr_content;
  return !!c && typeof c === "object" && c.page_copy !== undefined;
}

export function sitePrCardOf(run: SettleRun): SitePrCardRef | null {
  if (run.agent_slug !== "engineer" || run.enqueued_by != null) return null;
  const card = (run.payload as { site_pr_card?: unknown } | null)?.site_pr_card as Partial<SitePrCardRef> | undefined;
  if (!card || typeof card.action_id !== "string" || typeof card.claim_id !== "string") return null;
  if (typeof card.exec_class !== "string" || !SITE_PR_CLASSES.has(card.exec_class)) return null;
  return { action_id: card.action_id, claim_id: card.claim_id, exec_class: card.exec_class };
}

export const NO_PR_OPENED =
  "Zavi's engineer finished without preparing a change, so no pull request was opened and nothing in your repository changed. Press Try again, or ask Zavi in chat what it found.";

export const PR_DECLINED =
  "The pull request was declined, so none was opened and nothing in your repository changed.";

export const PR_EXPIRED =
  "The pull request waited 7 days for an approval and expired. Nothing was opened. Press Try again to prepare it again.";

export const PR_OPEN_FAILED =
  "Zavi could not open the pull request on GitHub, so nothing in your repository changed. Press Try again.";

export const PR_LINK_MISSING =
  "Zavi's engineer reported the pull request as opened, but its link was not recorded. Check GitHub for it. Zavi will not open another one from this card.";

export const PR_STILL_WAITING =
  "The pull request is still waiting for an approval. Zavi will not open another one from this card.";

export const PR_STILL_OPENING =
  "Zavi's engineer was still opening the pull request when Zavi stopped checking. Check GitHub for it. Zavi will not open another one from this card.";

export const RUN_NEVER_FINISHED =
  "Zavi's engineer did not finish within 6 hours. Check GitHub for a pull request before pressing Try again, so you do not get two.";

const OUTCOME_UNKNOWN = "exec_outcome_unknown";

export type SitePrSettlement =
  | { kind: "settle"; ok: boolean; result: Record<string, unknown>; error: string | null }
  | { kind: "wait_run" }
  | { kind: "wait_decision"; held: boolean };

const fail = (error: string, extra: Record<string, unknown> = {}): SitePrSettlement => ({
  kind: "settle",
  ok: false,
  result: { error, ...extra },
  error,
});

export function settlementFor(
  run: SettleRun,
  decisions: ShipPrDecision[],
  opts: { final: boolean; runDeadlinePassed: boolean },
): SitePrSettlement {
  const parsed = (run.parsed ?? {}) as { pr_url?: unknown; pr_number?: unknown; pr_repo?: unknown };
  const url = typeof parsed.pr_url === "string" && /^https:\/\/github\.com\//.test(parsed.pr_url) ? parsed.pr_url : null;
  if (url) {
    const repo = typeof parsed.pr_repo === "string" ? parsed.pr_repo : null;
    const num = typeof parsed.pr_number === "number" ? ` #${parsed.pr_number}` : "";
    const line = `Pull request${num} opened${repo ? ` on ${repo}` : ""}. Review and merge it on GitHub.`;
    const safePath = (f: string) => f.length > 0 && f.length <= 300 && !f.startsWith("/") && !f.includes("..") && /^[A-Za-z0-9._\/@+()[\]-]+$/.test(f);
    const acted = decisions.filter((d) => d.status === "acted");
    const files = acted.length === 1 ? [...new Set((acted[0]!.files ?? []).filter(safePath))].slice(0, 50) : [];
    return { kind: "settle", ok: true, result: { notice: line, receipt: { line, url }, pr_url: url, ...(files.length ? { files } : {}) }, error: null };
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    if (!opts.final && !opts.runDeadlinePassed) return { kind: "wait_run" };
    return fail(RUN_NEVER_FINISHED, { engineer_status: run.status });
  }
  if (decisions.length === 0) {
    const clean = run.status === "success" || run.status === "done";
    return fail(NO_PR_OPENED, { engineer_status: run.status, ...(clean && isPageCopyRun(run) ? { code: "page_copy_no_change" } : {}) });
  }
  const statuses = new Set(decisions.map((d) => d.status));
  if ([...statuses].some((s) => SHIP_PR_PENDING.has(s))) {
    if (opts.final) return fail(statuses.has("proposed") ? PR_STILL_WAITING : PR_STILL_OPENING, { code: OUTCOME_UNKNOWN });
    return { kind: "wait_decision", held: statuses.has("proposed") };
  }
  if (statuses.has("acted")) return fail(PR_LINK_MISSING, { code: OUTCOME_UNKNOWN });
  if (statuses.has("rejected")) return fail(PR_DECLINED, { decision_status: "rejected" });
  if (statuses.has("expired")) return fail(PR_EXPIRED, { decision_status: "expired" });
  if (decisions.some((d) => d.dispatch_error === PAGE_COPY_APPROVER_GONE)) return fail(PAGE_COPY_APPROVER_GONE, { code: "page_copy_approver_gone" });
  if (decisions.some((d) => d.dispatch_error === GITHUB_UNREACHABLE)) return fail(GITHUB_UNREACHABLE, { code: "github_not_connected" });
  if (decisions.some((d) => d.dispatch_error === PAGE_COPY_READ_FAILED)) return fail(PAGE_COPY_READ_FAILED, { code: "page_copy_read_failed" });
  if (decisions.some((d) => d.dispatch_error === PAGE_COPY_NOT_ON_PAGE)) return fail(PAGE_COPY_NOT_ON_PAGE, { code: "page_copy_not_on_page" });
  if (decisions.some((d) => d.dispatch_error === PAGE_COPY_NOT_PLAIN_TEXT)) return fail(PAGE_COPY_NOT_PLAIN_TEXT, { code: "page_copy_not_plain_text" });
  if (decisions.some((d) => d.dispatch_error === PAGE_COPY_NOT_ONE_FILE)) return fail(PAGE_COPY_NOT_ONE_FILE, { code: "page_copy_not_one_file" });
  return fail(PR_OPEN_FAILED, { decision_status: [...statuses][0] ?? null });
}

export type SettleDeps = {
  readRunByKey: (tenantId: string, runKey: string) => Promise<SettleRun | null>;
  readShipPrDecisions: (tenantId: string, runId: string) => Promise<ShipPrDecision[]>;
  setWaiting: (tenantId: string, card: SitePrCardRef, waiting: boolean) => Promise<void>;
  settle: typeof import("./exec-actions").settleChannelActionExec;
};

const DEFAULT_SETTLE_DEPS: SettleDeps = {
  readRunByKey: async (tenantId, runKey) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, status, enqueued_by, payload, parsed")
      .eq("cron_dedupe_key", runKey)
      .maybeSingle();
    if (error) throw new Error(`site-pr settle: run read failed: ${error.message}`);
    return (data as SettleRun | null) ?? null;
  },
  readShipPrDecisions: async (tenantId, runId) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("decisions")
      .select("id, status, dispatch_error, files:body->files")
      .eq("agent_run_id", runId)
      .eq("decision_class", "engineer.ship-pr");
    if (error) throw new Error(`site-pr settle: decision read failed: ${error.message}`);
    return ((data ?? []) as Array<ShipPrDecision & { files?: unknown }>)
      .filter((d) => typeof d.id === "string" && typeof d.status === "string")
      .map((d) => ({
        id: d.id,
        status: d.status,
        dispatch_error: d.dispatch_error ?? null,
        files: Array.isArray(d.files) ? (d.files as Array<{ path?: unknown }>).map((f) => f?.path).filter((x): x is string => typeof x === "string") : [],
      }));
  },
  setWaiting: async (tenantId, card, waiting) => {
    try {
      const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
      const { error } = await tenantRpc(asTenantId(tenantId), "set_site_pr_waiting", {
        p_action_id: card.action_id,
        p_claim_id: card.claim_id,
        p_waiting: waiting,
      });
      if (error) console.warn(`[site-pr] waiting note not written for action ${card.action_id}: ${error.message}`);
    } catch (e) {
      console.warn(`[site-pr] waiting note not written for action ${card.action_id}: ${(e as Error).message}`);
    }
  },
  settle: async (...args) => (await import("./exec-actions")).settleChannelActionExec(...args),
};

export type SitePrSettleOutcome =
  | { state: "skipped" }
  | { state: "pending"; run_id: string; waiting_on: "run" | "decision" }
  | { state: "settled"; ok: boolean; code?: string };

export async function settleSitePullRequest(
  tenantId: string,
  runKey: string,
  opts: { final: boolean; runDeadlinePassed?: boolean },
  deps: Partial<SettleDeps> = {},
): Promise<SitePrSettleOutcome> {
  const d = { ...DEFAULT_SETTLE_DEPS, ...deps };
  if (!tenantId || !runKey.startsWith("site-pr:")) return { state: "skipped" };
  const run = await d.readRunByKey(tenantId, runKey);
  const card = run ? sitePrCardOf(run) : null;
  if (!run || run.tenant_id !== tenantId || !card || runKey !== sitePrRunKey(card.action_id, card.claim_id)) {
    return { state: "skipped" };
  }
  const decisions = TERMINAL_RUN_STATUSES.has(run.status) ? await d.readShipPrDecisions(run.tenant_id, run.id) : [];
  const s = settlementFor(run, decisions, { final: opts.final, runDeadlinePassed: opts.runDeadlinePassed === true });
  if (s.kind === "wait_run") return { state: "pending", run_id: run.id, waiting_on: "run" };
  if (s.kind === "wait_decision") {
    await d.setWaiting(run.tenant_id, card, s.held);
    return { state: "pending", run_id: run.id, waiting_on: "decision" };
  }
  const out = await d.settle(run.tenant_id, {
    actionId: card.action_id,
    claimId: card.claim_id,
    ok: s.ok,
    execClass: card.exec_class,
    result: s.result,
    error: s.error,
  });
  if (!out.ok) throw new Error(`site-pr settle refused for action ${card.action_id}: ${out.code ?? "unknown"}`);
  return { state: "settled", ok: s.ok, code: out.code };
}

export function mergedReceiptLine(prUrl: string, opened: unknown): string {
  const line = typeof opened === "string" ? opened : "";
  const m = /^Pull request( #\d+)? opened( on \S+?)?\.(?:\s|$)/.exec(line);
  if (m) return `Pull request${m[1] ?? ""} merged${m[2] ?? ""}.`;
  const num = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  return `Pull request${num ? ` #${num}` : ""} merged.`;
}

export type MergedDeps = {
  readCards: (tenantId: string, prUrl: string) => Promise<Array<{ id: string; exec_result: Record<string, unknown> | null }>>;
  writeResult: (tenantId: string, id: string, result: Record<string, unknown>) => Promise<void>;
};

const DEFAULT_MERGED_DEPS: MergedDeps = {
  readCards: async (tenantId, prUrl) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("id, exec_result")
      .in("exec_class", [...SITE_PR_CLASSES])
      .eq("exec_status", "executed")
      .eq("exec_result->>pr_url", prUrl)
      .limit(5);
    if (error) throw new Error(`site-pr merged: card read failed: ${error.message}`);
    return (data ?? []) as Array<{ id: string; exec_result: Record<string, unknown> | null }>;
  },
  writeResult: async (tenantId, id, result) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { error } = await tenantClient(asTenantId(tenantId)).from("channel_actions").update({ exec_result: result }).eq("id", id);
    if (error) throw new Error(`site-pr merged: card write failed: ${error.message}`);
  },
};

export async function markSitePrCardsMerged(tenantId: string, prUrl: string, mergedAt: string, deps: Partial<MergedDeps> = {}): Promise<number> {
  const d = { ...DEFAULT_MERGED_DEPS, ...deps };
  if (!tenantId || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prUrl)) return 0;
  let n = 0;
  for (const card of await d.readCards(tenantId, prUrl)) {
    const r = card.exec_result ?? {};
    if (typeof r.merged_at === "string") continue;
    const receipt = r.receipt && typeof r.receipt === "object" ? (r.receipt as { line?: unknown }) : {};
    const line = mergedReceiptLine(prUrl, receipt.line);
    await d.writeResult(tenantId, card.id, { ...r, merged_at: mergedAt, notice: line, receipt: { line, url: prUrl } });
    n++;
  }
  return n;
}
