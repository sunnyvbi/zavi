import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const insertMock = vi.fn();
let supabaseThrows = false;
let insertReturnsError: { code?: string; message: string } | null = null;
let insertThrows: Error | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    if (supabaseThrows) throw new Error("serviceClient unavailable");
    return {
      from: () => ({
        insert: async (row: unknown) => {
          if (insertThrows) throw insertThrows;
          insertMock(row);
          return { error: insertReturnsError };
        },
      }),
    };
  },
}));

import { logEvent, LOG_META_KEYS } from "../logEvent";

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logEvent — never-throws contract", () => {
  beforeEach(() => {
    insertMock.mockClear();
    supabaseThrows = false;
    insertReturnsError = null;
    insertThrows = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Promise<void> (no return value to caller)", async () => {
    const out = await logEvent({ level: "error", source: "test" });
    expect(out).toBeUndefined();
  });

  it("does NOT throw when serviceClient() throws", async () => {
    supabaseThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(logEvent({ level: "error", source: "test", code: "x" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT throw when insert returns an error", async () => {
    insertReturnsError = { code: "23505", message: "duplicate key" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(logEvent({ level: "error", source: "test" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT throw when insert throws", async () => {
    insertThrows = new Error("network down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(logEvent({ level: "error", source: "test" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("emits a distinct console label when praxis_logs table is missing", async () => {
    insertReturnsError = { code: "42P01", message: 'relation "praxis_logs" does not exist' };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await logEvent({ level: "error", source: "test", code: "x" });
    const calls = warn.mock.calls.flat().join(" ");
    expect(calls).toMatch(/table not yet provisioned/);
  });

  it("does NOT throw when meta is null/undefined", async () => {
    await expect(logEvent({ level: "error", source: "test", meta: undefined })).resolves.toBeUndefined();
    await expect(logEvent({ level: "error", source: "test", meta: {} })).resolves.toBeUndefined();
  });

  it("works without tenant_id or run_id (optional, system contexts)", async () => {
    await logEvent({ level: "warn", source: "boot", code: "ready" });
    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.tenant_id).toBeNull();
    expect(row.run_id).toBeNull();
  });
});

describe("logEvent — meta whitelist", () => {
  beforeEach(() => {
    insertMock.mockClear();
    supabaseThrows = false;
    insertReturnsError = null;
    insertThrows = null;
  });

  it("persists logo designer timing and bounded status metadata", async () => {
    const meta = { design_type: "monogram", design_source: "heuristic", design_ms: 0, design_reason: "designer_off" };
    await logEvent({ level: "info", source: "site-logo", code: "site_logo.build_generated", meta });
    expect((insertMock.mock.calls[0][0] as { meta: unknown }).meta).toEqual(meta);
  });

  it("keeps only LOG_META_KEYS and drops everything else", async () => {
    await logEvent({
      level: "error",
      source: "test",
      meta: {
        agent_slug: "operator",
        ms: 1234,
        error_class: "TypeError",
        failure_class: "provider_capacity",
        user_input: "leak",
        prompt: "leak prompt",
        password: "hunter2",
        api_key: "sk-abc",
        random_field: "x",
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(Object.keys(row.meta).sort()).toEqual([
      "agent_slug",
      "error_class",
      "failure_class",
      "ms",
    ]);
    expect(row.meta.agent_slug).toBe("operator");
    expect(row.meta.ms).toBe(1234);
    expect(row.meta.failure_class).toBe("provider_capacity");
  });

  it("persists the app-data audit table name through sanitizeMeta", async () => {
    await logEvent({
      level: "info",
      source: "website.app_data",
      code: "app_data_read",
      meta: {
        initiated_by_user: "user-1",
        op: "read",
        driver: "postgres",
        table: "users",
        count: 40,
        rows: [{ email: "a@b.com" }],
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta.table).toBe("users");
    expect(row.meta.count).toBe(40);
    expect(row.meta.rows).toBeUndefined();
  });

  it("persists C14-safe connector token-health telemetry", async () => {
    await logEvent({
      level: "warn",
      source: "connector.health",
      code: "meta_ads.rolling_refresh_ineffective",
      meta: {
        connector_slug: "meta_ads",
        token_days_remaining: 7,
        refresh_effective: 0,
        notice_bucket: "7d",
        access_token: "secret",
        graph_response: { expires_at: 123 },
      } as unknown as Record<string, unknown>,
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({
      connector_slug: "meta_ads",
      token_days_remaining: 7,
      refresh_effective: 0,
      notice_bucket: "7d",
    });
  });

  it("persists steer dead-letter reason under dead_letter_reason, not the stripped meta.code", async () => {
    await logEvent({
      level: "warn",
      source: "agent.barge_in",
      code: "steer_dead_lettered",
      meta: { dead_letter_reason: "reserve_failed", code: "reserve_failed" } as unknown as Record<
        string,
        unknown
      >,
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta.dead_letter_reason).toBe("reserve_failed");
    expect(row.meta.code).toBeUndefined();
  });

  it("drops non-string non-number values for whitelisted keys", async () => {
    await logEvent({
      level: "error",
      source: "test",
      meta: { agent_slug: { nested: "object" }, ms: NaN, http_status: 500 } as unknown as Record<string, unknown>,
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta.agent_slug).toBeUndefined();
    expect(row.meta.ms).toBeUndefined();
    expect(row.meta.http_status).toBe(500);
  });

  it("caps string meta values at 256 chars", async () => {
    const big = "x".repeat(500);
    await logEvent({ level: "error", source: "test", meta: { error_class: big } });
    const row = insertMock.mock.calls[0]?.[0] as { meta: { error_class: string } };
    expect(row.meta.error_class.length).toBe(256);
  });

  it("persists resume-cap size telemetry + coerces the boolean flag to 0/1", async () => {
    await logEvent({
      level: "warn",
      source: "runner.prompt_budget",
      code: "resume_transcript_size",
      meta: {
        agent_slug: "pm",
        resume_entries: 49,
        resume_approx_tokens: 153036,
        resume_capped: true,
        error_chars: 42,
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta.resume_entries).toBe(49);
    expect(row.meta.resume_approx_tokens).toBe(153036);
    expect(row.meta.resume_capped).toBe(1);
    expect(row.meta.error_chars).toBe(42);
  });

  it("keeps the rag_web_browser proxy-escalation keys on the written row", async () => {
    await logEvent({
      level: "info",
      source: "apify",
      code: "rag_web_browser_residential_retry",
      meta: {
        origin: "https://www.reddit.com",
        proxy_tier: "residential",
        recovered: true,
        full_url: "https://www.reddit.com/r/x/comments/y/z/",
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(Object.keys(row.meta).sort()).toEqual(["origin", "proxy_tier", "recovered"]);
    expect(row.meta.proxy_tier).toBe("residential");
    expect(row.meta.recovered).toBe(1);
    expect(row.meta.full_url).toBeUndefined();
  });

  it("LOG_META_KEYS matches the canonical list (single allow-list source)", () => {
    expect(LOG_META_KEYS).toEqual([
      "agent_slug",
      "worker_id",
      "stage",
      "tool_name",
      "ms",
      "design_type",
      "design_source",
      "design_ms",
      "design_reason",
      "retry_count",
      "error_class",
      "failure_class",
      "http_status",
      "method",
      "path",
      "source_file",
      "source_line",
      "run_id_ref",
      "build_stage",
      "node_status",
      "node_id",
      "watchdog_age_ms",
      "tree_kb",
      "checkout_kb",
      "blob_count",
      "probe_ref_kind",
      "freed_kb",
      "free_kb_after",
      "gc_steps",
      "gate_rule",
      "gate_verdict",
      "gate_action",
      "step_index",
      "requested",
      "skipped_reason",
      "skipped_reasons",
      "vision_fix_outcome",
      "findings_before",
      "findings_after",
      "removed",
      "total",
      "batch_errors",
      "db_error_code",
      "driver",
      "decision_class",
      "count",
      "cap",
      "cost_usd",
      "logo_fail_reason",
      "logo_failure_stage",
      "surface",
      "families",
      "origin",
      "op",
      "engine",
      "platform",
      "profile_persisted",
      "passed_over",
      "served_by",
      "bytes",
      "captured",
      "event_id",
      "object_id",
      "amount",
      "currency",
      "money_model",
      "container_role",
      "prev_shutdown_clean",
      "boots_last_10m",
      "prompt_chars",
      "approx_tokens",
      "target_agent_slug",
      "gate_reason",
      "hypothesis_ref",
      "authorized",
      "reject_reason",
      "acceptance_mode",
      "acceptance_verdict",
      "acceptance_failed_invariant",
      "acceptance_pass_count",
      "acceptance_total",
      "acceptance_repairs",
      "review_outcome",
      "review_n",
      "cosine",
      "supersede_count",
      "blocked_by_trust",
      "blocked_by_date",
      "entities",
      "edges",
      "slug",
      "content_hash",
      "resume_entries",
      "resume_chars",
      "resume_approx_tokens",
      "resume_capped",
      "error_chars",
      "initiated_by_user",
      "exit_code",
      "timed_out",
      "has_rc_marker",
      "sandbox_id",
      "dead_letter_reason",
      "risk_class",
      "risk_score",
      "server_id",
      "table",
      "connector_slug",
      "token_days_remaining",
      "refresh_effective",
      "notice_bucket",
      "proxy_tier",
      "recovered",
      "creator_order_id",
      "reversal_shortfall_cents",
      "null_field",
      "rows_present",
      "row_count_total",
      "adapter_id",
      "deliverables",
      "rewritten",
      "claims_removed",
      "rejected_rewrites",
      "evidence_pages",
      "evidence_tool_results",
      "mechanical_removals",
      "input_tokens",
      "output_tokens",
      "purge_backlog",
      "purge_oldest_age_s",
      "artifacts_patched",
      "artifacts_unpatchable",
      "artifacts_unmatched",
      "unsourced_figures",
      "figures_checked",
      "figures_cut",
      "figures_kept",
      "chars_removed",
      "app_role",
      "invite_id",
      "target_id",
      "from_role",
      "to_role",
      "github_request_id",
      "ratelimit_remaining",
      "ratelimit_reset",
      "ratelimit_resource",
      "retry_after_s",
      "queue_ms",
      "prep_ms",
      "first_text_ms",
      "first_text_source",
      "model_ms",
      "tools_ms",
      "post_ms",
      "total_ms",
      "model_turns",
      "tool_calls",
      "tool_search_calls",
      "tool_ms",
      "outcome",
      "review_score",
      "review_unsupported",
      "review_constraint_score",
      "review_constraint_issues",
      "review_target_score",
      "review_target_issues",
      "review_actions_score",
      "review_actions_issues",
      "review_effects_score",
      "review_effects_issues",
      "review_grounding_score",
      "review_grounding_issues",
      "dialect",
      "tables_found",
      "rescan_attempts",
      "rescan_age_ms",
      "caller",
      "graph_code",
      "subcode",
      "ad_account",
      "usage_pct",
      "regain_minutes",
      "home",
      "page_size",
      "changed",
      "rerouted",
      "cap_stripped",
      "final_status",
      "hold_reasons",
      "budget_raised",
      "approved_via",
    ]);
  });

  it("persists a run's stage timing on the written row", async () => {
    const meta = { agent_slug: "cgo", queue_ms: 800, first_text_ms: 1200, first_text_source: "delta", model_ms: 20000, model_turns: 3, tool_search_calls: 1, tool_ms: "growth__get_metric:1:2000", prompt: "dropped" };
    await logEvent({ level: "info", source: "run_timing", code: "run_timing", meta });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    const { prompt: _dropped, ...kept } = meta;
    expect(row.meta).toEqual(kept);
  });
});

describe("logEvent — message PII discipline", () => {
  beforeEach(() => {
    insertMock.mockClear();
    supabaseThrows = false;
    insertReturnsError = null;
    insertThrows = null;
  });

  it("for unknown error classes inserts `<class>: omitted`, NOT the message", async () => {
    class CustomDbError extends Error {
      constructor() {
        super("user email a@b.com had password=secret123 in their query");
        this.name = "CustomDbError";
      }
    }
    await logEvent({ level: "error", source: "worker.run-agent", error: new CustomDbError() });
    const row = insertMock.mock.calls[0]?.[0] as { message: string };
    expect(row.message).toBe("CustomDbError: omitted");
    expect(row.message).not.toContain("a@b.com");
    expect(row.message).not.toContain("secret123");
  });

  it("for safe error classes (ExpectedToolError, SafetyGateError, ZodError) passes message through scrubber", async () => {
    class ExpectedToolError extends Error {
      constructor() {
        super("operator_db_invalid_identifier");
        this.name = "ExpectedToolError";
      }
    }
    await logEvent({ level: "error", source: "tool", error: new ExpectedToolError() });
    const row = insertMock.mock.calls[0]?.[0] as { message: string };
    expect(row.message).toBe("operator_db_invalid_identifier");
  });

  it("sanitizes a postgres URI in a string message", async () => {
    await logEvent({
      level: "error",
      source: "test",
      message: "could not connect to postgres://user:secret@host/db",
    });
    const row = insertMock.mock.calls[0]?.[0] as { message: string };
    expect(row.message).not.toContain("user:secret");
    expect(row.message).toContain("‹conn›");
  });

  it("sanitizes API keys in a string message", async () => {
    await logEvent({ level: "error", source: "test", message: "key sk-abc123def456ghi789 was rejected" });
    const row = insertMock.mock.calls[0]?.[0] as { message: string };
    expect(row.message).not.toContain("sk-abc123def456ghi789");
    expect(row.message).toContain("‹secret›");
  });

  it("caps message at 2000 chars", async () => {
    await logEvent({ level: "error", source: "test", message: "x".repeat(5000) });
    const row = insertMock.mock.calls[0]?.[0] as { message: string };
    expect(row.message.length).toBeLessThanOrEqual(2000);
  });
});

describe("logEvent — row shape", () => {
  beforeEach(() => {
    insertMock.mockClear();
    supabaseThrows = false;
    insertReturnsError = null;
    insertThrows = null;
  });

  it("inserts a complete row with all expected fields", async () => {
    await logEvent({
      level: "error",
      source: "worker.run-agent",
      code: "dispatch_inner_throw",
      tenant_id: "00000000-0000-0000-0000-000000000001",
      run_id: "00000000-0000-0000-0000-000000000002",
      meta: { agent_slug: "operator", error_class: "TypeError" },
    });
    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.level).toBe("error");
    expect(row.source).toBe("worker.run-agent");
    expect(row.code).toBe("dispatch_inner_throw");
    expect(row.tenant_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(row.run_id).toBe("00000000-0000-0000-0000-000000000002");
    expect(row.meta).toEqual({ agent_slug: "operator", error_class: "TypeError" });
  });

  it("caps source at 64 chars and code at 64 chars", async () => {
    await logEvent({
      level: "warn",
      source: "x".repeat(500),
      code: "y".repeat(500),
    });
    const row = insertMock.mock.calls[0]?.[0] as { source: string; code: string };
    expect(row.source.length).toBe(64);
    expect(row.code.length).toBe(64);
  });

  it("site-role / invite audit keys survive sanitizeMeta; a token or email key does not", async () => {
    await logEvent({
      level: "info",
      source: "website.app_invites",
      code: "app_invite_created",
      meta: {
        initiated_by_user: "u-1", app_role: "admin", invite_id: "41",
        table: "users", target_id: "7", from_role: "user", to_role: "admin",
        token: "raw-token", token_hash: "abc", email: "a@b.c",
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({
      initiated_by_user: "u-1", app_role: "admin", invite_id: "41",
      table: "users", target_id: "7", from_role: "user", to_role: "admin",
    });
  });

  it("sandbox disk telemetry keys survive sanitizeMeta", async () => {
    await logEvent({
      level: "info",
      source: "sandbox",
      code: "sandbox.worktree_preflight",
      meta: {
        tree_kb: 3_309_568,
        checkout_kb: 338_016,
        blob_count: 5791,
        probe_ref_kind: "origin_base",
        freed_kb: 6_000_000,
        free_kb_after: 8_400_000,
        gc_steps: "yarn-cache,orphan-worktrees",
      },
    });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({
      tree_kb: 3_309_568,
      checkout_kb: 338_016,
      blob_count: 5791,
      probe_ref_kind: "origin_base",
      freed_kb: 6_000_000,
      free_kb_after: 8_400_000,
      gc_steps: "yarn-cache,orphan-worktrees",
    });
  });
});

describe("logEvent — which machine wrote the row", () => {
  beforeEach(() => {
    insertMock.mockClear();
    supabaseThrows = false;
    insertReturnsError = null;
    insertThrows = null;
  });

  it("stamps a laptop's rows with its worker id so they are not mistaken for prod", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
    vi.stubEnv("HOSTNAME", "mohits-mbp");
    await logEvent({ level: "error", source: "boot", code: "backend_boot_storm", meta: { stage: "boot" } });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({ stage: "boot", worker_id: "dev:mohits-mbp" });
  });

  it("leaves prod rows unstamped and drops a worker id a caller tried to pass", async () => {
    await logEvent({ level: "error", source: "route", meta: { worker_id: "dev:fake", http_status: 500 } });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({ http_status: 500 });
  });

  it("leaves rows from either split prod host unstamped", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    vi.stubEnv("PRAXIS_ROLE", "worker");
    await logEvent({ level: "error", source: "route", meta: { http_status: 500 } });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({ http_status: 500 });
    vi.stubEnv("PRAXIS_ROLE", "");
  });

  it("a laptop cannot pass itself off as prod through meta", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
    vi.stubEnv("HOSTNAME", "laptop");
    await logEvent({ level: "error", source: "route", meta: { worker_id: "canonical" } });
    const row = insertMock.mock.calls[0]?.[0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({ worker_id: "dev:laptop" });
  });
});
