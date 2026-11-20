
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  parsed: null as Record<string, unknown> | null,
  decision: null as Record<string, unknown> | null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = async () => ({ data: db.decision ? [db.decision] : [], error: null });
      chain.maybeSingle = async () => ({ data: table === "agent_runs" ? { parsed: db.parsed } : null, error: null });
      return chain;
    },
  }),
}));

import { readStagePushLanded } from "../conductor-driver";

const ARGS = { tenant_id: "t1", child_run_id: "child-1", repo_full_name: "Praxis-build/acme" };

beforeEach(() => {
  db.parsed = null;
  db.decision = null;
});

describe("readStagePushLanded", () => {
  it("a landed commit is landed", async () => {
    db.parsed = { commit_sha: "abc1234" };
    expect(await readStagePushLanded(ARGS)).toBe("landed");
  });

  it("a push diverted to a PR (pr_url, no commit) is diverted, not landed, even though its decision acted", async () => {
    db.parsed = { pr_url: "https://github.com/Praxis-build/acme/pull/3" };
    db.decision = { status: "acted", dispatched_at: "2026-10-01T22:38:00Z", dispatch_error: null };
    expect(await readStagePushLanded(ARGS)).toBe("diverted");
  });

  it("a decision that ended dispatch_failed is refused (terminal), not missing", async () => {
    db.decision = { status: "dispatch_failed", dispatched_at: null, dispatch_error: "open_pr pull HTTP 403" };
    expect(await readStagePushLanded(ARGS)).toBe("refused");
  });

  it("a decision still waiting to dispatch is missing (the gate keeps its bounded wait)", async () => {
    db.decision = { status: "proposed", dispatched_at: null, dispatch_error: null };
    expect(await readStagePushLanded(ARGS)).toBe("missing");
  });

  it("an acted decision with no PR is landed, as before", async () => {
    db.decision = { status: "acted", dispatched_at: "2026-10-01T22:38:00Z", dispatch_error: null };
    expect(await readStagePushLanded(ARGS)).toBe("landed");
  });
});
