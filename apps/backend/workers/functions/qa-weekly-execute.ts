
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { checkAgentTier, planUpgradeMessage } from "@/services/agents/entitlement";
import { getBoolSetting } from "@/services/settings";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { getSecret } from "@/services/secrets/vault";
import { logEvent } from "@/services/logging/logEvent";
import { resolveNamedEngineerRepo } from "@/services/agents/engineer-dispatch-repo";
import { qaRecordTestOutcome } from "@/services/mcp/internal/qa-engineer";
import {
  buildQaBugReport,
  buildEngineerDispatch,
  QA_BUG_REPORT_CLASS,
  QA_DISPATCH_SPECIALIST_CLASS,
} from "./qa-bug-handoff";

const MAX_RUNS_PER_TENANT = 10;

const QA_WEEKLY_TRIGGER = "qa-weekly-execute" as const;

const QA_WEEKLY_SOURCE = "qa_weekly_execute" as const;

type TenantRow = {
  id: string;
  display_name: string | null;
};

type ActiveTestRow = {
  id: string;
  title: string;
  role: string;
  nl_spec: unknown;
  tags: string[] | null;
};

type PreblockedCase = {
  tenant_id: string;
  test_case_id: string;
  test_title: string;
};

type EnqueuedRun = {
  tenant_id: string;
  run_id: string;
  test_case_id: string;
  test_title: string;
  test_role: string | null;
  nl_spec: unknown;
};

type TenantOutcome =
  | {
      status: "skipped";
      reason: string;
      enqueued_runs?: never;
    }
  | {
      status: "ok";
      enqueued_runs: EnqueuedRun[];
      preblocked: PreblockedCase[];
    };

export type QaVerdict = {
  test_result: "pass" | "fail" | "blocked";
  blocked_kind?:
    | "infra"
    | "needs_write"
    | "off_origin"
    | "missing_precondition"
    | "unparseable"
    | "timed_out"
    | null;
  reason?: string;
  evidence?: string;
};

type TestResult = EnqueuedRun & { verdict: QaVerdict };

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

export function rewriteSpecUrlsToStaging<T>(
  nlSpec: T,
  stagingOrigin: string,
): { spec: T; rewrites: Array<{ from: string; to: string }> } {
  let stagingHost: string;
  try {
    stagingHost = new URL(stagingOrigin).hostname;
  } catch {
    return { spec: nlSpec, rewrites: [] };
  }
  const stagingDomain = registrableDomain(stagingHost);
  const rewrites: Array<{ from: string; to: string }> = [];
  const rewriteString = (s: string): string =>
    s.replace(/https?:\/\/[^\s"'`<>)\]]+/g, (raw) => {
      const m = raw.match(/[.,;:!?]+$/);
      const tail = m ? m[0] : "";
      const url = tail ? raw.slice(0, -tail.length) : raw;
      try {
        const u = new URL(url);
        if (u.origin === stagingOrigin) return raw;
        if (registrableDomain(u.hostname) !== stagingDomain) return raw;
        const to = `${stagingOrigin}${u.pathname}${u.search}${u.hash}`;
        rewrites.push({ from: url, to });
        return to + tail;
      } catch {
        return raw;
      }
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return rewriteString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { spec: walk(nlSpec) as T, rewrites };
}

export function parseQaVerdict(outputText: string | null): QaVerdict | null {
  if (!outputText) return null;
  const blocks = [...outputText.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i][1]) as { qa_verdict?: QaVerdict };
      const v = parsed?.qa_verdict;
      if (v && ["pass", "fail", "blocked"].includes(v.test_result)) {
        return {
          test_result: v.test_result,
          blocked_kind: v.blocked_kind ?? null,
          reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : undefined,
          evidence:
            typeof v.evidence === "string" ? v.evidence.slice(0, 500) : undefined,
        };
      }
    } catch {
    }
  }
  return null;
}

export function buildWeeklyDigest(results: TestResult[]): {
  tier1: Array<{ category: string; summary: string }>;
  tier2: Array<{ category: string; summary: string }>;
  tier3: Array<{ category: string; summary: string }>;
  tier4: Array<{ category: string; summary: string }>;
  rendered_markdown: string;
} {
  const pass = results.filter((r) => r.verdict.test_result === "pass");
  const fail = results.filter((r) => r.verdict.test_result === "fail");
  const blocked = results.filter((r) => r.verdict.test_result === "blocked");
  const needsWrite = blocked.filter((b) => b.verdict.blocked_kind === "needs_write");

  const tier1 = fail.map((f) => ({
    category: "qa-test-fail",
    summary: `FAIL: ${f.test_title} — ${f.verdict.reason ?? "behavior contradicts expected outcome"}`,
  }));
  const tier3 = blocked.map((b) => ({
    category: "qa-test-blocked",
    summary: `BLOCKED (${b.verdict.blocked_kind ?? "unknown"}): ${b.test_title}`,
  }));
  const tier4 = [
    {
      category: "qa-weekly-execute",
      summary: `Ran ${results.length}: ${pass.length} pass / ${fail.length} fail / ${blocked.length} blocked.`,
    },
  ];

  const lines: string[] = [
    `**Weekly QA run** — ${results.length} test case(s): ${pass.length} pass, ${fail.length} fail, ${blocked.length} blocked.`,
    "",
  ];
  if (fail.length > 0) {
    lines.push("**Failures (look at these):**");
    for (const f of fail) {
      lines.push(
        `- ❌ ${f.test_title} — ${f.verdict.reason ?? "expected outcome not met"}${f.verdict.evidence ? ` (evidence: ${f.verdict.evidence})` : ""}`,
      );
    }
    lines.push("");
  }
  if (pass.length > 0) {
    lines.push("**Passing:**");
    for (const p of pass) lines.push(`- ✅ ${p.test_title}`);
    lines.push("");
  }
  if (blocked.length > 0) {
    lines.push("**Blocked (not executable this run):**");
    for (const b of blocked) {
      lines.push(
        `- ⏸ ${b.test_title} — ${b.verdict.blocked_kind ?? "unknown"}${b.verdict.reason ? `: ${b.verdict.reason}` : ""}`,
      );
    }
    lines.push("");
  }
  if (needsWrite.length > 0) {
    lines.push(
      `_${needsWrite.length} case(s) require form submission (clicks/fills) and cannot run under the current read-only execution policy._`,
    );
  }
  return { tier1, tier2: [], tier3, tier4, rendered_markdown: lines.join("\n") };
}

async function getStagingUrl(tenant_id: string): Promise<string | null> {
  try {
    return await getSecret(tenant_id, "qa.staging_url");
  } catch {
    return null;
  }
}

async function listActiveTests(tenant_id: string): Promise<ActiveTestRow[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("test_cases")
    .select("id, title, role, nl_spec, tags")
    .eq("tenant_id", tenant_id)
    .eq("status", "active")
    .limit(MAX_RUNS_PER_TENANT * 3);
  if (error) {
    throw new Error(`qa-weekly-execute: list_active_tests failed: ${error.message}`);
  }
  return (data ?? []) as ActiveTestRow[];
}

async function enqueueTestRun(
  tenant_id: string,
  staging_url: string,
  test: ActiveTestRow,
  correlation_id: string,
  allow_writes: boolean,
): Promise<{ run_id: string }> {
  const stagingOrigin = (() => {
    try {
      return new URL(staging_url).origin;
    } catch {
      return staging_url;
    }
  })();
  const { spec: rewrittenSpec, rewrites } = rewriteSpecUrlsToStaging(
    test.nl_spec,
    stagingOrigin,
  );
  void allow_writes;
  return enqueueAgentRun({
    tenant_id,
    agent_slug: "qa",
    trigger: QA_WEEKLY_TRIGGER,
    payload: {
      source: QA_WEEKLY_SOURCE,
      staging_origin: stagingOrigin,
      intent:
        `Run the QA test case "${test.title}" on ${stagingOrigin} and decide whether the expected outcome holds.\n\n` +
        `Test spec (same-product URLs already point at ${stagingOrigin}; treat every spec URL as a path on it):\n` +
        `${JSON.stringify(rewrittenSpec, null, 2)}\n` +
        (rewrites.length > 0
          ? `\n(${rewrites.length} spec URL(s) were rewritten to ${stagingOrigin}.)\n`
          : "") +
        `\nIf a step needs a different origin (OAuth provider, payment processor), the verdict is BLOCKED(off_origin).`,
      test_case_id: test.id,
      test_title: test.title,
      test_role: test.role,
      correlation_id,
      _read_only_note: "browser-task-worker-has-no-write-ops",
    },
  });
}

export async function runForTenant(
  tenant: TenantRow,
  batchKey: string,
): Promise<TenantOutcome> {
  const enabled = await getBoolSetting("qa_weekly_execute_enabled", tenant.id);
  if (!enabled) {
    return { status: "skipped", reason: "qa_weekly_execute_enabled=false (default)" };
  }

  const stagingUrl = await getStagingUrl(tenant.id);
  if (!stagingUrl) {
    try {
      const svc = serviceClient();
      const { error } = await svc.rpc("emit_decision", {
        p_tenant_id: tenant.id,
        p_agent_run_id: null,
        p_decision_class: "qa.weekly-digest",
        p_body: {
          tier1: [],
          tier2: [],
          tier3: [],
          tier4: [
            {
              category: "qa-weekly-execute",
              summary:
                "Blocked: connect your staging site — no tests were run. Set the Staging URL in QA Setup.",
            },
          ],
          rendered_markdown:
            "**QA test run blocked — connect your staging site.**\n\n" +
            "QA test execution is enabled for this workspace, but no staging URL is configured, so 0 tests ran. " +
            "Set the **Staging URL** (`qa.staging_url`) in QA Setup, then run your tests again.",
        },
      });
      if (error) {
        void logEvent({
          level: "error",
          source: "qa-weekly-execute",
          code: "blocked_digest_emit_failed",
          tenant_id: tenant.id,
          meta: { error: error.message.slice(0, 300) },
        });
      }
    } catch (e) {
      void logEvent({
        level: "error",
        source: "qa-weekly-execute",
        code: "blocked_digest_emit_failed",
        tenant_id: tenant.id,
        meta: { error: (e as Error).message.slice(0, 300) },
      });
    }
    return {
      status: "skipped",
      reason:
        "blocked: needs URL — qa.staging_url vault key is not set. " +
        "Set it via Settings → Connectors → QA Setup before enabling qa_weekly_execute.",
    };
  }

  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet halt active" };
  }

  let tests: ActiveTestRow[];
  try {
    tests = await listActiveTests(tenant.id);
  } catch (e) {
    return { status: "skipped", reason: `list_active_tests failed: ${(e as Error).message}` };
  }

  if (tests.length === 0) {
    return { status: "skipped", reason: "no active test cases in catalog" };
  }

  const correlation_id = `qa-weekly:${tenant.id}:${batchKey}`;

  const allowWrites = false;

  const preblocked: PreblockedCase[] = allowWrites
    ? []
    : tests
        .filter((t) => (t.tags ?? []).includes("needs-write"))
        .map((t) => ({
          tenant_id: tenant.id,
          test_case_id: t.id,
          test_title: t.title,
        }));
  const executable = (
    allowWrites ? tests : tests.filter((t) => !(t.tags ?? []).includes("needs-write"))
  ).slice(0, MAX_RUNS_PER_TENANT);

  try {
    const tierDecision = await checkAgentTier(tenant.id, "browser-operator");
    if (!tierDecision.allowed) {
      return {
        status: "skipped",
        reason: `plan_upgrade_required: ${planUpgradeMessage("browser-operator", tierDecision.required_tier)}`,
      };
    }
  } catch (e) {
    return { status: "skipped", reason: `tier gate unavailable: ${(e as Error).message}` };
  }

  const enqueued_runs: EnqueuedRun[] = [];
  for (const test of executable) {
    try {
      const { run_id } = await enqueueTestRun(
        tenant.id,
        stagingUrl,
        test,
        correlation_id,
        allowWrites,
      );
      enqueued_runs.push({
        tenant_id: tenant.id,
        run_id,
        test_case_id: test.id,
        test_title: test.title,
        test_role: test.role ?? null,
        nl_spec: test.nl_spec,
      });
    } catch (e) {
      const planRefusal = asPlanUpgradeRequired(e);
      if (planRefusal) {
        if (enqueued_runs.length === 0) {
          return { status: "skipped", reason: `plan_upgrade_required: ${planRefusal.message}` };
        }
        break;
      }
      const msg = (e as Error).message;
      console.warn(
        `[qa-weekly-execute] enqueue failed for tenant=${tenant.id} test=${test.id}: ${msg}`,
      );
      void logEvent({
        level: "error",
        source: "qa-weekly-execute",
        code: "enqueue_failed",
        tenant_id: tenant.id,
        meta: { test_case_id: test.id, error: msg.slice(0, 300) },
      });
    }
  }

  return { status: "ok", enqueued_runs, preblocked };
}

export const qaWeeklyExecuteFn = inngest.createFunction(
  {
    id: "qa-weekly-execute",
    concurrency: 1,
    idempotency: "event.data.dedupe_key",
  },
  { event: "qa/weekly.execute.requested" },
  async ({ event, step }) => {
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) {
      return { halted: true, scanned: 0, enqueued: 0, skipped: 0 };
    }

    const tenant_id =
      typeof event.data?.tenant_id === "string" ? event.data.tenant_id : null;

    const batchKey =
      typeof event.data?.dedupe_key === "string" && event.data.dedupe_key
        ? event.data.dedupe_key
        : `ts-${(event as { ts?: number }).ts ?? 0}`;

    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      let q = svc.from("tenants").select("id, display_name");
      if (tenant_id) q = q.eq("id", tenant_id);
      const { data, error } = await q;
      if (error) throw new Error(`qa-weekly-execute: tenant scan failed: ${error.message}`);
      return (data ?? []) as TenantRow[];
    });

    let enqueued = 0;
    let skipped = 0;
    const allEnqueuedRuns: EnqueuedRun[] = [];
    const allPreblocked: PreblockedCase[] = [];
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = await step.run(`tenant-${tenant.id}`, () =>
          runForTenant(tenant, batchKey),
        );

        if (outcome.status === "skipped") {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
          if (outcome.reason.startsWith("blocked: needs URL")) {
            console.warn(
              `[qa-weekly-execute] tenant=${tenant.id} BLOCKED (URL gate): ${outcome.reason}`,
            );
          } else {
            console.info(
              `[qa-weekly-execute] tenant=${tenant.id} skipped: ${outcome.reason}`,
            );
          }
        } else {
          const runs = outcome.enqueued_runs;
          enqueued += runs.length;
          allEnqueuedRuns.push(...runs);
          allPreblocked.push(...outcome.preblocked);
          console.info(
            `[qa-weekly-execute] tenant=${tenant.id} enqueued ${runs.length} browser-operator run(s).`,
          );
        }
      } catch (e) {
        skipped++;
        console.error(
          `[qa-weekly-execute] tenant=${tenant.id} threw: ${(e as Error).message}`,
        );
      }
    }

    const verdictByRun: Record<string, QaVerdict> = {};
    if (allEnqueuedRuns.length > 0) {
      let pendingIds = allEnqueuedRuns.map((r) => r.run_id);
      for (let i = 0; i < 15 && pendingIds.length > 0; i++) {
        await step.sleep(`poll-wait-${i}`, "3m");
        const snapshot = pendingIds;
        const rows = await step.run(`poll-runs-${i}`, async () => {
          const svc = serviceClient();
          const { data, error } = await svc
            .from("agent_runs")
            .select("id, tenant_id, status, output_text")
            .in("id", snapshot);
          if (error) throw new Error(`qa-weekly-execute: poll failed: ${error.message}`);
          return (data ?? []) as Array<{
            id: string;
            tenant_id: string;
            status: string;
            output_text: string | null;
          }>;
        });
        const stillPending: string[] = [];
        for (const row of rows) {
          const manifest = allEnqueuedRuns.find(
            (r) => r.run_id === row.id && r.tenant_id === row.tenant_id,
          );
          if (!manifest) continue;
          if (row.status === "success") {
            verdictByRun[row.id] = parseQaVerdict(row.output_text) ?? {
              test_result: "blocked",
              blocked_kind: "unparseable",
              reason: "run succeeded but no qa_verdict block found in output",
            };
          } else if (row.status === "queued" || row.status === "running" || row.status === "blocked") {
            stillPending.push(row.id);
          } else {
            verdictByRun[row.id] = {
              test_result: "blocked",
              blocked_kind: "infra",
              reason: `run ended status=${row.status}`,
            };
          }
        }
        pendingIds = stillPending;
      }
      for (const id of pendingIds) {
        verdictByRun[id] = {
          test_result: "blocked",
          blocked_kind: "timed_out",
          reason: "run not terminal after 45-min aggregation window",
        };
      }

    }

    if (allEnqueuedRuns.length > 0 || allPreblocked.length > 0) {
      await step.run("emit-digests", async () => {
        const svc = serviceClient();
        const tenantIds = [
          ...new Set([
            ...allEnqueuedRuns.map((r) => r.tenant_id),
            ...allPreblocked.map((p) => p.tenant_id),
          ]),
        ];
        for (const tid of tenantIds) {
          const results: TestResult[] = [
            ...allEnqueuedRuns
              .filter((r) => r.tenant_id === tid)
              .map((r) => ({
                ...r,
                verdict: verdictByRun[r.run_id] ?? {
                  test_result: "blocked" as const,
                  blocked_kind: "infra" as const,
                  reason: "no verdict recorded",
                },
              })),
            ...allPreblocked
              .filter((p) => p.tenant_id === tid)
              .map((p) => ({
                tenant_id: p.tenant_id,
                run_id: "",
                test_case_id: p.test_case_id,
                test_title: p.test_title,
                test_role: null,
                nl_spec: null,
                verdict: {
                  test_result: "blocked" as const,
                  blocked_kind: "needs_write" as const,
                  reason: "tagged needs-write — not executable under read-only policy",
                },
              })),
          ];
          const body = buildWeeklyDigest(results);
          const { error } = await svc.rpc("emit_decision", {
            p_tenant_id: tid,
            p_agent_run_id: null,
            p_decision_class: "qa.weekly-digest",
            p_body: body,
          });
          if (error) {
            void logEvent({
              level: "error",
              source: "qa-weekly-execute",
              code: "digest_emit_failed",
              tenant_id: tid,
              meta: { error: error.message.slice(0, 300) },
            });
          }

          const failed = results.filter(
            (r) => r.verdict.test_result === "fail" && r.test_case_id,
          );
          if (failed.length > 0) {
            const repoTarget = await resolveNamedEngineerRepo(tid);
            const repoFullName = repoTarget?.repo ?? null;
            for (const f of failed) {
              try {
                const outcome = await qaRecordTestOutcome(
                  { tenant_id: tid, run_id: "qa-weekly-execute", agent_slug: "qa" },
                  { test_case_id: f.test_case_id, status: "failed", unmute: false },
                );
                const bug = buildQaBugReport({
                  test_case_id: f.test_case_id,
                  test_title: f.test_title,
                  test_role: f.test_role,
                  nl_spec: f.nl_spec,
                  verdict: f.verdict,
                  consecutive_red: outcome.consecutive_red,
                  run_id: f.run_id,
                });
                const { data: bugId, error: bugErr } = await svc.rpc(
                  "emit_decision",
                  {
                    p_tenant_id: tid,
                    p_agent_run_id: null,
                    p_decision_class: QA_BUG_REPORT_CLASS,
                    p_body: bug,
                  },
                );
                if (bugErr) {
                  void logEvent({
                    level: "error",
                    source: "qa-weekly-execute",
                    code: "bug_report_emit_failed",
                    tenant_id: tid,
                    meta: {
                      test_case_id: f.test_case_id,
                      error: bugErr.message.slice(0, 300),
                    },
                  });
                  continue;
                }
                if (repoFullName) {
                  const dispatch = buildEngineerDispatch(
                    bug,
                    repoFullName,
                    typeof bugId === "string" ? bugId : undefined,
                    repoTarget?.site_id,
                  );
                  const { error: dispErr } = await svc.rpc("emit_decision", {
                    p_tenant_id: tid,
                    p_agent_run_id: null,
                    p_decision_class: QA_DISPATCH_SPECIALIST_CLASS,
                    p_body: dispatch,
                  });
                  if (dispErr) {
                    void logEvent({
                      level: "error",
                      source: "qa-weekly-execute",
                      code: "bug_dispatch_emit_failed",
                      tenant_id: tid,
                      meta: {
                        test_case_id: f.test_case_id,
                        error: dispErr.message.slice(0, 300),
                      },
                    });
                  }
                }
              } catch (e) {
                void logEvent({
                  level: "error",
                  source: "qa-weekly-execute",
                  code: "bug_handoff_threw",
                  tenant_id: tid,
                  meta: {
                    test_case_id: f.test_case_id,
                    error: (e as Error).message.slice(0, 300),
                  },
                });
              }
            }
          }
        }
      });
    }

    return {
      halted: false,
      scanned: tenants.length,
      enqueued,
      skipped,
      enqueued_runs: allEnqueuedRuns,
      skipped_tenants: skippedTenants,
      verdicts: verdictByRun,
    };
  },
);
