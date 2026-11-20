import { describe, it, expect } from "vitest";
import {
  isInfraRetryable,
  isUsageLimitError,
  isConfigError,
  willBeInfraRetried,
  MONEY_PATH_SLUGS,
  buildQueuedResendEvent,
  buildChatEarlyResendEvent,
  CHAT_QUEUED_EARLY_RESEND_MIN,
  QUEUED_RESEND_BUCKET_MS,
} from "../queued-stuck-scan";

describe("isInfraRetryable", () => {
  it("dispatch_error is retryable (Inngest dispatch severed by restart/gateway)", () => {
    expect(isInfraRetryable("dispatch_error", null)).toBe(true);
    expect(isInfraRetryable("dispatch_error", "dispatch failed — Inngest exhausted retries")).toBe(true);
  });

  it("failed + boot_reap:/watchdog_reap: prefix is retryable (infra reap)", () => {
    expect(isInfraRetryable("failed", "boot_reap: orphaned by container restart (worker died mid-run)")).toBe(true);
    expect(isInfraRetryable("failed", "watchdog_reap: no progress for >5min (trigger=slack)")).toBe(true);
    expect(isInfraRetryable("failed", "watchdog_reap: running >2h (hard cap)")).toBe(true);
  });

  it("genuine agent/task failures are NOT retryable (don't loop a real error)", () => {
    expect(isInfraRetryable("failed", "Anthropic API 400: invalid request")).toBe(false);
    expect(isInfraRetryable("failed", "validation: missing pr_proposal envelope")).toBe(false);
    expect(isInfraRetryable("failed", null)).toBe(false);
    expect(isInfraRetryable("failed", "")).toBe(false);
  });

  it("non-failed/non-dispatch_error statuses are never retryable", () => {
    expect(isInfraRetryable("parse_failed", "boot_reap: x")).toBe(false);
    expect(isInfraRetryable("success", null)).toBe(false);
    expect(isInfraRetryable("cancelled", null)).toBe(false);
    expect(isInfraRetryable("running", null)).toBe(false);
    expect(isInfraRetryable("queued", null)).toBe(false);
  });

  it("usage-limit dispatch_errors are NOT retryable (surface-now, manual retry)", () => {
    expect(
      isInfraRetryable(
        "dispatch_error",
        "Claude Code returned an error result: You've hit your limit · resets 4:40am (UTC)",
      ),
    ).toBe(false);
    expect(isInfraRetryable("dispatch_error", "usage limit reached")).toBe(false);
    expect(isInfraRetryable("dispatch_error", "You've reached your usage limit")).toBe(false);
    expect(isInfraRetryable("dispatch_error", "out of credits")).toBe(false);
  });

  it("config errors (resolve-repo-creds:) are NOT retryable (surface-now, fixable)", () => {
    expect(
      isInfraRetryable(
        "dispatch_error",
        "resolve-repo-creds: payload.repo_hint missing and no repos are accessible to the GitHub installation. Re-install via /connectors and grant repo access.",
      ),
    ).toBe(false);
    expect(
      isInfraRetryable(
        "dispatch_error",
        "resolve-repo-creds: GitHub App not connected for this tenant.",
      ),
    ).toBe(false);
  });
});

describe("isConfigError", () => {
  it("matches resolve-repo-creds config errors", () => {
    expect(
      isConfigError("resolve-repo-creds: no repos are accessible to the GitHub installation."),
    ).toBe(true);
    expect(isConfigError("resolve-repo-creds: GitHub App not connected for this tenant.")).toBe(true);
  });
  it("does not match generic infra/agent errors, null, or mid-string matches", () => {
    expect(isConfigError(null)).toBe(false);
    expect(isConfigError("dispatch failed — Inngest exhausted retries")).toBe(false);
    expect(isConfigError("Anthropic API 400: invalid request")).toBe(false);
    expect(isConfigError("wrapped: resolve-repo-creds: x")).toBe(false);
  });
});

describe("isUsageLimitError", () => {
  it("matches Anthropic/Claude-Code usage-limit shapes", () => {
    expect(isUsageLimitError("You've hit your limit · resets 4:40am (UTC)")).toBe(true);
    expect(isUsageLimitError("hit your usage limit")).toBe(true);
    expect(isUsageLimitError("usage limit reached for today")).toBe(true);
    expect(isUsageLimitError("resets 11:00pm")).toBe(true);
    expect(isUsageLimitError("out of credits")).toBe(true);
    expect(isUsageLimitError("insufficient quota")).toBe(true);
  });
  it("does not match generic infra/agent errors or null", () => {
    expect(isUsageLimitError(null)).toBe(false);
    expect(isUsageLimitError("dispatch failed — Inngest exhausted retries")).toBe(false);
    expect(isUsageLimitError("Anthropic API 400: invalid request")).toBe(false);
    expect(isUsageLimitError("ECONNRESET")).toBe(false);
  });
});

describe("willBeInfraRetried (shared gate for the chat failure-bubble write)", () => {
  const base = {
    id: "r1",
    tenant_id: "t1",
    agent_slug: "operator",
    status: "dispatch_error",
    error: "dispatch failed — Inngest exhausted retries",
    infra_retry_count: 0,
    last_progress_at: null as string | null,
  };

  it("true for a virgin infra-orphan dispatch_error (will be re-fired)", () => {
    expect(willBeInfraRetried(base)).toBe(true);
  });
  it("false once the cap is reached (final attempt → bubble is written)", () => {
    expect(willBeInfraRetried({ ...base, infra_retry_count: 3 })).toBe(false);
  });
  it("false when progress was emitted (a tool ran → not an orphan)", () => {
    expect(willBeInfraRetried({ ...base, last_progress_at: "2026-06-05T00:00:00Z" })).toBe(false);
  });
  it("false for money-path agents (E3 firewall → surface, don't retry)", () => {
    expect(willBeInfraRetried({ ...base, agent_slug: "dispute-response" })).toBe(false);
  });
  it("false for a usage-limit dispatch_error (surface-now → bubble immediately)", () => {
    expect(
      willBeInfraRetried({ ...base, error: "You've hit your limit · resets 4:40am" }),
    ).toBe(false);
  });
  it("false for a genuine hard failure (not infra-shaped)", () => {
    expect(
      willBeInfraRetried({ ...base, status: "failed", error: "validation: missing envelope" }),
    ).toBe(false);
  });
  it("false for a conductor child: the conductor owns its node's retries", () => {
    const child = {
      ...base,
      agent_slug: "engineer",
      trigger: "a2a",
      error: "resolveSandboxForRun: rpc failed: get_or_create_tenant_sandbox: repo o/r not in tenant connected repos",
    };
    expect(willBeInfraRetried(child)).toBe(true);
    expect(willBeInfraRetried({ ...child, conductor_run_id: "c0a1b2c3-0000-4000-8000-000000000000" })).toBe(false);
    expect(willBeInfraRetried({ ...child, conductor_run_id: "  " })).toBe(true);
    expect(willBeInfraRetried({ ...child, conductor_run_id: null })).toBe(true);
  });
});

describe("MONEY_PATH_SLUGS (E3 firewall — excluded from auto-retry)", () => {
  it("excludes the money-path agents", () => {
    expect(MONEY_PATH_SLUGS.has("performance-marketer")).toBe(true);
    expect(MONEY_PATH_SLUGS.has("dispute-response")).toBe(true);
  });
  it("does not exclude non-money agents", () => {
    for (const slug of ["engineer", "operator", "pm", "qa", "research", "growth-lead", "support-lead", "chief-of-staff", "advisor"]) {
      expect(MONEY_PATH_SLUGS.has(slug)).toBe(false);
    }
  });
});

describe("buildQueuedResendEvent (Path-1 re-fire — fresh firing id, not run_id)", () => {
  const row = { id: "run-abc", tenant_id: "t1", agent_slug: "pm" };
  const t0 = Math.floor(1_700_000_000_000 / QUEUED_RESEND_BUCKET_MS) * QUEUED_RESEND_BUCKET_MS;

  it("mints an id DISTINCT from row.id (the original run_id event already in Inngest dedup)", () => {
    const ev = buildQueuedResendEvent(row, t0);
    expect(ev.id).not.toBe(row.id);
    expect(ev.id.startsWith(`${row.id}-queued-resend-`)).toBe(true);
  });

  it("preserves data.run_id (= row.id) so run-agent re-derives tenant by run_id (C8)", () => {
    const ev = buildQueuedResendEvent(row, t0);
    expect(ev.data.run_id).toBe(row.id);
    expect(ev.data.tenant_id).toBe(row.tenant_id);
    expect(ev.data.agent_slug).toBe(row.agent_slug);
    expect(ev.name).toBe("agent.run.requested");
  });

  it("two sends INSIDE the same reap-window bucket produce the SAME id (dedup → no */2-min spam)", () => {
    const a = buildQueuedResendEvent(row, t0);
    const b = buildQueuedResendEvent(row, t0 + QUEUED_RESEND_BUCKET_MS - 1);
    expect(b.id).toBe(a.id);
  });

  it("a send in the NEXT bucket produces a DIFFERENT id (the stuck row re-fires once more)", () => {
    const a = buildQueuedResendEvent(row, t0);
    const c = buildQueuedResendEvent(row, t0 + QUEUED_RESEND_BUCKET_MS);
    expect(c.id).not.toBe(a.id);
  });
});

describe("buildChatEarlyResendEvent (Path-1a — lost chat event re-fired at ~2 min)", () => {
  const row = { id: "run-chat", tenant_id: "t1", agent_slug: "operator", trigger: "chat", batch_id: null };

  it("fires well before the 10-min Path-1 threshold", () => {
    expect(CHAT_QUEUED_EARLY_RESEND_MIN).toBe(2);
  });

  it("uses a FIXED id so repeated */2 ticks dedup to one early re-fire per run", () => {
    expect(buildChatEarlyResendEvent(row).id).toBe("run-chat-chat-early-resend");
    expect(buildChatEarlyResendEvent(row).id).toBe(buildChatEarlyResendEvent(row).id);
  });

  it("id differs from the Path-1 bucketed id, so the 10-min re-fire still fires as a second chance", () => {
    expect(buildChatEarlyResendEvent(row).id).not.toBe(buildQueuedResendEvent(row, Date.now()).id);
    expect(buildChatEarlyResendEvent(row).id).not.toBe(row.id);
  });

  it("keeps run_id and routes a human-waiting chat run to the interactive lane", () => {
    const ev = buildChatEarlyResendEvent(row);
    expect(ev.name).toBe("agent.run.requested");
    expect(ev.data).toEqual({ run_id: "run-chat", tenant_id: "t1", agent_slug: "operator", lane: "interactive" });
  });
});
