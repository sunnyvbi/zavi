
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { getBoolSetting } from "@/services/settings";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { resolveRepoFullName } from "@/services/agents/repo-resolver";
import { mondayUtc } from "@/agents/research/persist-snapshot";

export const ENGINEER_AUDIT_SOURCE = "engineer_audit_weekly";

export const ENGINEER_AUDIT_ASK =
  "Read-only weekly security & billing audit of this company's connected " +
  "repository. This is an INFO turn — DO NOT write any file, run any mutating " +
  "command, or open a pull request. Produce a report only.\n\n" +
  "Scan for TWO finding classes:\n" +
  "1. SECRETS / PII LEAKS — hardcoded credentials, API keys, tokens, database " +
  "connection strings, private keys; PII written to logs; queries that return " +
  "full user/customer documents to the client without projection (over-fetch); " +
  "secrets committed into the tree (.env-style values, *.bak files).\n" +
  "2. PRICING / BILLING CORRECTNESS — price/total/discount/proration math, " +
  "Stripe or other billing flows, plan/tier gating, rounding, and currency " +
  "handling. Flag anything that could over- or under-charge.\n\n" +
  "REDACTION (mandatory): for every finding report ONLY `path:line`, the " +
  "finding type, a severity (P0/P1/P2/P3), and a one-line reason plus a one-line " +
  "suggested fix direction. NEVER echo the raw secret value, token, key, or any " +
  "real PII — `path:line` + type is enough to locate it.\n\n" +
  "If there are no findings in a class, say so explicitly. Order findings by " +
  "severity. If the repo could not be read, say that instead of guessing.";

type TenantRow = {
  id: string;
  display_name: string | null;
};

type TenantOutcome =
  | { status: "skipped"; reason: string; run_id?: never }
  | { status: "enqueued"; run_id: string };

export const AUDIT_WORKER_NAME = "engineer-audit-weekly";

export async function runForTenant(tenant: TenantRow): Promise<TenantOutcome> {
  if (isWorkerCronStopped(AUDIT_WORKER_NAME)) {
    return { status: "skipped", reason: "cron stopped fleet-wide" };
  }

  const enabled = await getBoolSetting("engineer_audit_weekly_enabled", tenant.id);
  if (!enabled) {
    return { status: "skipped", reason: "engineer_audit_weekly_enabled=false (default)" };
  }

  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet halt active" };
  }

  let repo: string;
  try {
    repo = await resolveRepoFullName({ tenant_id: tenant.id });
  } catch {
    return { status: "skipped", reason: "no connected github repo" };
  }

  const week_bucket = mondayUtc(new Date());

  const { run_id } = await enqueueAgentRun({
    tenant_id: tenant.id,
    agent_slug: "engineer",
    trigger: "cron",
    cron_dedupe_key: `engineer-audit-weekly:${tenant.id}:${week_bucket}`,
    payload: {
      source: ENGINEER_AUDIT_SOURCE,
      cto_chat_intent: "info",
      repo_hint: repo,
      ask: ENGINEER_AUDIT_ASK,
    },
  });

  return { status: "enqueued", run_id };
}

export const engineerAuditWeeklyFn = inngest.createFunction(
  {
    id: "engineer-audit-weekly",
    concurrency: 1,
  },
  { cron: "0 10 * * 1" },
  async ({ step }) => {
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) {
      return { halted: true, scanned: 0, enqueued: 0, skipped: 0 };
    }

    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      const { data, error } = await svc.from("tenants").select("id, display_name");
      if (error) {
        throw new Error(`engineer-audit-weekly: tenant scan failed: ${error.message}`);
      }
      return (data ?? []) as TenantRow[];
    });

    let enqueued = 0;
    let skipped = 0;
    const enqueuedRuns: Array<{ tenant_id: string; run_id: string }> = [];
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = (await step.run(`tenant-${tenant.id}`, () =>
          runForTenant(tenant),
        )) as TenantOutcome;

        if (outcome.status === "skipped") {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
        } else {
          enqueued++;
          enqueuedRuns.push({ tenant_id: tenant.id, run_id: outcome.run_id });
          console.info(
            `[engineer-audit-weekly] tenant=${tenant.id} enqueued engineer run=${outcome.run_id}`,
          );
        }
      } catch (e) {
        skipped++;
        skippedTenants.push({ tenant_id: tenant.id, reason: (e as Error).message });
        console.error(
          `[engineer-audit-weekly] tenant=${tenant.id} threw: ${(e as Error).message}`,
        );
      }
    }

    return {
      halted: false,
      scanned: tenants.length,
      enqueued,
      skipped,
      enqueued_runs: enqueuedRuns,
      skipped_tenants: skippedTenants,
    };
  },
);
