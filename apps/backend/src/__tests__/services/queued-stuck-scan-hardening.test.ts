import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const watchdogSrc = readFileSync(
  join(__dirname, "../../../workers/functions/queued-stuck-scan.ts"),
  "utf-8",
);
const runHardCapSrc = readFileSync(
  join(__dirname, "../../services/agents/run-hard-cap.ts"),
  "utf-8",
);
const runnerSrc = readFileSync(
  join(__dirname, "../../services/agents/runner.ts"),
  "utf-8",
);
const runAgentSrc = readFileSync(
  join(__dirname, "../../../workers/functions/run-agent.ts"),
  "utf-8",
);
const reconcilerSrc = readFileSync(
  join(
    __dirname,
    "../../../workers/functions/batch-fanout-refund-reconciler.ts",
  ),
  "utf-8",
);
const mig0066 = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0066_last_progress_at.sql"),
  "utf-8",
);
const mig0067 = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0067_needs_run_end_emit.sql",
  ),
  "utf-8",
);
const infraRetrySrc = readFileSync(
  join(__dirname, "../../services/agents/infra-retry.ts"),
  "utf-8",
);

describe("queued-stuck-scan hardening (Phase A0)", () => {
  it("uses */2 cron cadence (re-tightened 2026-06-11 — Stage-3 chat SLO)", () => {
    expect(watchdogSrc).toMatch(/cron:\s*"\*\/2 \* \* \* \*"/);
  });

  it("has path 0 — retries needs_run_end_emit=true rows", () => {
    expect(watchdogSrc).toMatch(/\.eq\("needs_run_end_emit", true\)/);
    expect(watchdogSrc).toMatch(/emitThreadEvent\(/);
  });

  it("reap UPDATE has CAS guard on status='running'", () => {
    expect(watchdogSrc).toMatch(
      /\.update\(\{[\s\S]*?status:\s*"failed"[\s\S]*?needs_run_end_emit:\s*true[\s\S]*?\}\)[\s\S]*?\.eq\("status",\s*"running"\)[\s\S]*?\.select\("id"\)/,
    );
  });

  it("reap UPDATE sets needs_run_end_emit=true upfront so a failed emit gets retried", () => {
    expect(watchdogSrc).toMatch(/needs_run_end_emit:\s*true/);
  });

  it("clears needs_run_end_emit after successful emit", () => {
    expect(watchdogSrc).toMatch(
      /\.update\(\{\s*needs_run_end_emit:\s*false\s*\}\)/,
    );
  });

  it("uses last_progress_at to detect stalled chat runs (15 min)", () => {
    expect(watchdogSrc).toMatch(/CHAT_STALE_MIN\s*=\s*15/);
    expect(watchdogSrc).toMatch(/last_progress_at/);
  });

  it("reap SIGNALS the worker to stop, not just flips the status", () => {
    expect(watchdogSrc).toMatch(/stop_requested:\s*true/);
  });

  it("uses last_progress_at to detect stalled non-chat runs (30 min)", () => {
    expect(watchdogSrc).toMatch(/NONCHAT_STALE_MIN\s*=\s*30/);
  });

  it("keeps the 2h hard-cap as backstop", () => {
    expect(runHardCapSrc).toMatch(/RUNNING_HARD_CAP_HOURS\s*=\s*2/);
    expect(watchdogSrc).toMatch(
      /import\s*\{[^}]*RUNNING_HARD_CAP_HOURS[^}]*\}\s*from\s*["']@\/services\/agents\/run-hard-cap["']/,
    );
    expect(watchdogSrc).toMatch(/RUNNING_HARD_CAP_HOURS\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("falls back to started_at when last_progress_at is NULL", () => {
    expect(watchdogSrc).toMatch(/last_progress_at\s*\?\?\s*r?\.?started_at/);
  });
});

describe("persistTerminal CAS guard (Phase A0 — Codex P1-A)", () => {
  it("UPDATE has .eq('status', 'running') guard", () => {
    expect(runnerSrc).toMatch(
      /\.update\(update\)\s*\n?\s*\.eq\("id", run_id\)\s*\n?\s*\.eq\("status",\s*"running"\)/,
    );
  });

  it("checks affected-row count and returns early on CAS no-op", () => {
    expect(runnerSrc).toMatch(
      /if \(!updated \|\| updated\.length === 0\)\s*\{[\s\S]*?return;/,
    );
  });
});

describe("persistTerminal CAS-lost safety-net run_end emit (qa-blind-fixes 2026-05-26)", () => {
  it("CAS-lost branch SELECTs thread_event for existing run_end before emitting (idempotency)", () => {
    expect(runnerSrc).toMatch(
      /\.from\("thread_event"\)\s*\n?\s*\.select\("id"\)\s*\n?\s*\.eq\("agent_run_id", run_id\)\s*\n?\s*\.eq\("kind", "run_end"\)/,
    );
  });

  it("CAS-lost branch emits run_end ONLY when no existing row found", () => {
    expect(runnerSrc).toMatch(
      /if \(!existing \|\| existing\.length === 0\)\s*\{[\s\S]*?emitThreadEvent\(/,
    );
  });

  it("CAS-lost run_end uses status:'error' (matches watchdog convention; RunEndBodySchema enum)", () => {
    expect(runnerSrc).toMatch(
      /if \(!existing \|\| existing\.length === 0\)[\s\S]*?body:\s*\{\s*status:\s*"error"/,
    );
  });

  it("CAS-lost branch re-derives tenant_id + thread_id from agent_runs row (Codex C8)", () => {
    expect(runnerSrc).toMatch(
      /\.from\("agent_runs"\)\s*\n?\s*\.select\("tenant_id, payload"\)\s*\n?\s*\.eq\("id", run_id\)/,
    );
  });

  it("CAS-lost safety-net is wrapped in try/catch (failure must NOT re-throw — row is already terminal)", () => {
    expect(runnerSrc).toMatch(
      /try\s*\{[\s\S]*?\.from\("thread_event"\)[\s\S]*?\}\s*catch[\s\S]*?CAS-lost safety-net/,
    );
  });
});

describe("migration 0066 — last_progress_at column + trigger", () => {
  it("adds the column on agent_runs", () => {
    expect(mig0066).toMatch(
      /alter table agent_runs[\s\S]*?add column[\s\S]*?last_progress_at timestamptz/i,
    );
  });

  it("adds 'progress' to agent_run_event_stage enum", () => {
    expect(mig0066).toMatch(
      /alter type agent_run_event_stage add value if not exists 'progress'/i,
    );
  });

  it("trigger whitelist INCLUDES tool_use_completed", () => {
    expect(mig0066).toMatch(/'tool_use_completed'/);
  });

  it("trigger whitelist INCLUDES tool_use_errored", () => {
    expect(mig0066).toMatch(/'tool_use_errored'/);
  });

  it("trigger whitelist INCLUDES iter_cap_summarize", () => {
    expect(mig0066).toMatch(/'iter_cap_summarize'/);
  });

  it("trigger whitelist INCLUDES progress (for A1 heartbeat)", () => {
    expect(mig0066).toMatch(/'progress'/);
  });

  it("trigger whitelist EXCLUDES tool_use_started (the R2 regression bug)", () => {
    const inClause = mig0066.match(
      /NEW\.stage in \(([\s\S]*?)\)/,
    );
    expect(inClause, "expected trigger to have an IN (...) clause").toBeTruthy();
    expect(inClause![1]).not.toMatch(/'tool_use_started'/);
  });

  it("trigger whitelist EXCLUDES claimed and loaded_context", () => {
    const inClause = mig0066.match(/NEW\.stage in \(([\s\S]*?)\)/);
    expect(inClause).toBeTruthy();
    expect(inClause![1]).not.toMatch(/'claimed'/);
    expect(inClause![1]).not.toMatch(/'loaded_context'/);
  });

  it("trigger is AFTER INSERT FOR EACH ROW (single-row PK update path)", () => {
    expect(mig0066).toMatch(
      /create trigger agent_run_events_update_last_progress[\s\S]*?after insert on agent_run_events[\s\S]*?for each row/i,
    );
  });

  it("supporting partial index for the watchdog query exists", () => {
    expect(mig0066).toMatch(
      /create index[\s\S]*?agent_runs_status_last_progress[\s\S]*?on agent_runs/i,
    );
  });
});

describe("fan-out batch-child lifecycle (2026-05-22 — Parts 1/1b/3/4)", () => {
  it("Part 1: isChat = the interactive run lane (batch children excluded by computeRunLane)", () => {
    expect(watchdogSrc).toMatch(
      /isChat\s*=\s*computeRunLane\(\s*trigger\s*,\s*r\.batch_id\s*\)\s*===\s*"interactive"/,
    );
  });

  it("Part 1: running-rows select includes batch_id + child_index", () => {
    expect(watchdogSrc).toMatch(/batch_id,\s*child_index/);
  });

  it("Part 3: reaper imports + calls recordChildTerminalAndCheckBatch on a reaped batch child", () => {
    expect(watchdogSrc).toMatch(
      /import\s*\{\s*recordChildTerminalAndCheckBatch\s*\}/,
    );
    expect(watchdogSrc).toMatch(
      /if\s*\(z\.row\.batch_id\s*!=\s*null\s*&&\s*z\.row\.child_index\s*!=\s*null\)/,
    );
    expect(watchdogSrc).toMatch(/status:\s*"failed"[\s\S]*?reason:\s*z\.reason/);
  });

  it("Part 3: promote is guarded by shouldPromote driven by rollup.batch_complete", () => {
    expect(watchdogSrc).toMatch(/shouldPromote\s*=\s*rollup\.batch_complete/);
    expect(watchdogSrc).toMatch(/if\s*\(shouldPromote\)\s*\{/);
  });

  it("Part 1b: run-agent skips teardown when a live sharer uses the sandbox", () => {
    expect(runAgentSrc).toMatch(/liveSharerOnSandbox/);
    expect(runAgentSrc).toMatch(
      /\.eq\("status",\s*"running"\)\s*\n?\s*\.neq\("id",\s*run_id\)/,
    );
    expect(runAgentSrc).toMatch(
      /if\s*\(liveSharerOnSandbox\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?revokeSandboxGithubToken\(sandbox\.e2b_sandbox_id\)/,
    );
  });

  it("Part 1b: re-derives batch_id from the agent_runs column, not the payload (Codex C8)", () => {
    expect(runAgentSrc).toMatch(
      /from\("agent_runs"\)\s*\n?\s*\.select\("batch_id"\)\s*\n?\s*\.eq\("id",\s*run_id\)/,
    );
  });

  it("Part 4: reconciler clause B uses recordChildTerminalAndCheckBatch (status flip + refund + summary)", () => {
    expect(reconcilerSrc).toMatch(
      /import\s*\{\s*recordChildTerminalAndCheckBatch\s*\}/,
    );
    expect(reconcilerSrc).toMatch(/recordChildTerminalAndCheckBatch\(\{/);
  });

  it("Part 4: reconciler clause B counts + promotes only on rollup.batch_complete", () => {
    expect(reconcilerSrc).toMatch(/if\s*\(rollup\.batch_complete\)\s*\{/);
    expect(reconcilerSrc).toMatch(/promote_next_blocked_run/);
  });
});

describe("migration 0067 — needs_run_end_emit retry flag", () => {
  it("adds the boolean column NOT NULL DEFAULT false", () => {
    expect(mig0067).toMatch(
      /add column if not exists needs_run_end_emit boolean not null default false/i,
    );
  });

  it("has a partial index limited to flag=true rows", () => {
    expect(mig0067).toMatch(
      /create index if not exists agent_runs_needs_run_end_emit[\s\S]*?where needs_run_end_emit = true/i,
    );
  });
});

describe("Path 3 — infra auto-retry safety invariants (P0.b)", () => {
  it("cap is 3 — bounded retries survive a multi-restart storm but can't loop", () => {
    expect(infraRetrySrc).toMatch(/INFRA_RETRY_CAP\s*=\s*3\b/);
  });
  it("only re-fires runs with NO progress (last_progress_at IS NULL) — no side effect could have run", () => {
    expect(watchdogSrc).toMatch(/\.is\(\s*"last_progress_at"\s*,\s*null\s*\)/);
    expect(infraRetrySrc).toMatch(/last_progress_at\s*!==\s*null/);
  });
  it("scopes candidates to infra-terminal statuses only", () => {
    expect(watchdogSrc).toMatch(
      /\.in\(\s*"status"\s*,\s*\[\s*"dispatch_error"\s*,\s*"failed"\s*\]\s*\)/,
    );
  });
  it("excludes money-path agents (E3 firewall)", () => {
    expect(infraRetrySrc).toMatch(/isMoneyPathSlug\(row\.agent_slug\)\)\s*return false/);
  });
  it("CAS-guards the re-queue on (status, infra_retry_count) so it can't double-fire", () => {
    expect(infraRetrySrc).toMatch(
      /\.eq\("status",\s*row\.status\)[\s\S]{0,160}\.eq\("infra_retry_count",\s*row\.infra_retry_count\)/,
    );
  });
  it("re-emits with a UNIQUE event id (same data.run_id) to bypass the 24h event dedup", () => {
    expect(infraRetrySrc).toMatch(/id:\s*`\$\{row\.id\}-infra-retry-\$\{count\}`/);
    expect(infraRetrySrc).toMatch(
      /inngestClient\.send\(buildInfraRetryEvent\(row,\s*nextCount\)\)/,
    );
  });
});

describe("Path 0 — visible failure note for infra-fallback runs (P0.c)", () => {
  it("fires agent.run.completed so slack/email-triage-reply post the failure note", () => {
    expect(watchdogSrc).toMatch(/name:\s*"agent\.run\.completed"/);
  });
  it("gates the fallback emit on trigger slack|email (mirrors the runner's gate)", () => {
    expect(watchdogSrc).toMatch(
      /row\.trigger\s*===\s*"slack"\s*\|\|\s*row\.trigger\s*===\s*"email"/,
    );
  });
  it("uses a deterministic event id so repeat cron ticks dedup to one post", () => {
    expect(watchdogSrc).toMatch(/id:\s*`\$\{row\.id\}-fallback-completed`/);
  });
});

describe("Path 0 — operator-cancelled queued run emits a clean 'cancelled' run_end", () => {
  it("selects status so the emit can branch on cancelled vs genuinely-stuck", () => {
    expect(watchdogSrc).toMatch(
      /\.select\("id, tenant_id, agent_slug, payload, trigger, status"\)/,
    );
  });
  it("derives isCancelled from the row status", () => {
    expect(watchdogSrc).toMatch(/const isCancelled = row\.status === "cancelled"/);
  });
  it("emits run_end status 'cancelled' for a cancelled row, 'error' otherwise", () => {
    expect(watchdogSrc).toMatch(
      /status:\s*isCancelled\s*\?\s*"cancelled"\s*:\s*"error"/,
    );
  });
  it("skips the dispatch_error agent.run.completed fallback for cancelled rows", () => {
    expect(watchdogSrc).toMatch(
      /!isCancelled\s*&&[\s\S]*?row\.trigger\s*===\s*"slack"\s*\|\|\s*row\.trigger\s*===\s*"email"/,
    );
  });
});

describe("gap 7 S2 — agent.run.terminal emit for abnormally-terminalized runs", () => {
  it("Path 0 fires agent.run.terminal so persist-run-trace covers reaped runs", () => {
    expect(watchdogSrc).toMatch(/name:\s*"agent\.run\.terminal"/);
    expect(watchdogSrc).toMatch(/data:\s*\{\s*run_id:\s*row\.id\s*\}/);
  });

  it("uses a deterministic event id so repeat cron ticks dedup (at-most-once)", () => {
    expect(watchdogSrc).toContain("`${row.id}-terminal-trace`");
  });

  it("keeps the terminal emit best-effort (try/catch, never breaks run_end)", () => {
    expect(watchdogSrc).toMatch(
      /agent\.run\.terminal emit failed for \$\{row\.id\} \(trace skipped\)/,
    );
  });
});
