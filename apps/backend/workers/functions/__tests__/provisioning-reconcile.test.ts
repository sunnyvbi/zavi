import { describe, it, expect } from "vitest";
import { summarizeResourceStates, type ResourceStateRow } from "../provisioning-reconcile";

const NOW = Date.parse("2026-05-29T12:00:00Z");
function row(over: Partial<ResourceStateRow>): ResourceStateRow {
  return {
    resource_kind: "repo",
    mode: "provisioned",
    status: "pending",
    provider: "github",
    last_error: null,
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

describe("summarizeResourceStates", () => {
  it("counts by status + buckets pending / failed", () => {
    const s = summarizeResourceStates(
      [
        row({ resource_kind: "repo", status: "pending", provider: "github" }),
        row({ resource_kind: "db", status: "failed", last_error: "boom" }),
        row({ resource_kind: "hosting", status: "pending", provider: "render" }),
      ],
      NOW,
    );
    expect(s.total).toBe(3);
    expect(s.byStatus).toEqual({ pending: 2, failed: 1 });
    expect(s.pending).toEqual([
      { kind: "repo", provider: "github" },
      { kind: "hosting", provider: "render" },
    ]);
    expect(s.failed).toEqual([{ kind: "db", error: "boom" }]);
    expect(s.stuck).toEqual([]);
  });

  it("flags a 'provisioning' row stale > 30min as stuck (not a fresh one)", () => {
    const stale = new Date(NOW - 31 * 60 * 1000).toISOString();
    const fresh = new Date(NOW - 5 * 60 * 1000).toISOString();
    const s = summarizeResourceStates(
      [
        row({ resource_kind: "db", status: "provisioning", updated_at: stale }),
        row({ resource_kind: "email", status: "provisioning", updated_at: fresh }),
      ],
      NOW,
    );
    expect(s.stuck).toEqual([{ kind: "db", updated_at: stale }]);
    expect(s.byStatus).toEqual({ provisioning: 2 });
  });

  it("empty → zeroed summary", () => {
    expect(summarizeResourceStates([], NOW)).toEqual({
      total: 0, byStatus: {}, pending: [], failed: [], stuck: [],
    });
  });
});
