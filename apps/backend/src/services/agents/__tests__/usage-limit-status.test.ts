import { describe, it, expect } from "vitest";
import {
  classifyUsageLimitStatus,
  type UsageLimitRunRow,
} from "@/services/agents/usage-limit-status";

const LIMIT_ERR =
  "Claude Code returned an error result: You've hit your limit · resets 7pm (UTC)";

function row(p: Partial<UsageLimitRunRow>): UsageLimitRunRow {
  return {
    id: p.id ?? "r",
    agent_slug: p.agent_slug ?? "operator",
    tenant_id: p.tenant_id ?? "t",
    status: p.status ?? "dispatch_error",
    error: p.error ?? null,
    finished_at: p.finished_at ?? "2026-06-12T17:30:00Z",
  };
}

describe("classifyUsageLimitStatus", () => {
  it("no rows → unknown, not limited", () => {
    const v = classifyUsageLimitStatus([]);
    expect(v.status).toBe("unknown");
    expect(v.limited).toBe(false);
    expect(v.runs_scanned).toBe(0);
  });

  it("recent limit error with no later success → limited + parsed reset", () => {
    const v = classifyUsageLimitStatus([
      row({ id: "a", status: "dispatch_error", error: LIMIT_ERR, finished_at: "2026-06-12T17:32:00Z" }),
    ]);
    expect(v.status).toBe("limited");
    expect(v.limited).toBe(true);
    expect(v.resets_at).toBe("7pm (UTC)");
    expect(v.limit_error_count).toBe(1);
    expect(v.last_limit_run?.id).toBe("a");
  });

  it("success landing AFTER the last limit error → recovered (ok)", () => {
    const v = classifyUsageLimitStatus([
      row({ id: "lim", status: "dispatch_error", error: LIMIT_ERR, finished_at: "2026-06-12T18:55:00Z" }),
      row({ id: "ok", status: "success", error: null, finished_at: "2026-06-12T19:05:00Z" }),
    ]);
    expect(v.status).toBe("ok");
    expect(v.limited).toBe(false);
    expect(v.last_success_at).toBe("2026-06-12T19:05:00Z");
  });

  it("success BEFORE the last limit error → still limited", () => {
    const v = classifyUsageLimitStatus([
      row({ id: "ok", status: "success", error: null, finished_at: "2026-06-12T17:00:00Z" }),
      row({ id: "lim", status: "dispatch_error", error: LIMIT_ERR, finished_at: "2026-06-12T17:32:00Z" }),
    ]);
    expect(v.status).toBe("limited");
    expect(v.limited).toBe(true);
  });

  it("ordinary errors (non-usage) → ok, not limited", () => {
    const v = classifyUsageLimitStatus([
      row({ id: "e", status: "failed", error: "boot_reap: orphaned by container restart" }),
      row({ id: "s", status: "success", error: null, finished_at: "2026-06-12T17:40:00Z" }),
    ]);
    expect(v.status).toBe("ok");
    expect(v.limited).toBe(false);
    expect(v.limit_error_count).toBe(0);
  });

  it("counts every usage-limit error in the window", () => {
    const v = classifyUsageLimitStatus([
      row({ id: "a", error: LIMIT_ERR, finished_at: "2026-06-12T17:30:00Z" }),
      row({ id: "b", error: LIMIT_ERR, finished_at: "2026-06-12T17:31:00Z" }),
      row({ id: "c", error: LIMIT_ERR, finished_at: "2026-06-12T17:32:00Z" }),
    ]);
    expect(v.limit_error_count).toBe(3);
    expect(v.last_limit_run?.id).toBe("c");
  });
});
