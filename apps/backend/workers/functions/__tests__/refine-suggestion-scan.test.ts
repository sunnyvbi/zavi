
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}) },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => true),
}));

import {
  buildCannedSuggestion,
  shouldSkipDueToExisting,
  pickHostingUrl,
  scanOneTenant,
  realScanDeps,
  type ScanDeps,
} from "../refine-suggestion-scan";
import { serviceClient } from "@/services/supabase";

describe("buildCannedSuggestion", () => {
  it("uses singular 'day' when live_days === 1", () => {
    expect(buildCannedSuggestion({ live_days: 1 })).toMatch(/1 day/);
    expect(buildCannedSuggestion({ live_days: 1 })).not.toMatch(/1 days/);
  });

  it("uses plural 'days' otherwise + includes a CTA", () => {
    const msg = buildCannedSuggestion({ live_days: 5 });
    expect(msg).toMatch(/5 days/);
    expect(msg).toMatch(/hero copy|polish|call-to-action/i);
  });

  it("clamps live_days to 1 when given 0 / negative / NaN", () => {
    expect(buildCannedSuggestion({ live_days: 0 })).toMatch(/1 day/);
    expect(buildCannedSuggestion({ live_days: -3 })).toMatch(/1 day/);
    expect(buildCannedSuggestion({ live_days: Number.NaN })).toMatch(/1 day/);
  });
});

describe("pickHostingUrl", () => {
  it("returns the URL when a 'ready' hosting row has a non-empty external_ref.url", () => {
    expect(
      pickHostingUrl([
        { status: "ready", external_ref: { url: "https://app.example.com" } },
      ]),
    ).toBe("https://app.example.com");
  });

  it("returns null when no row is 'ready'", () => {
    expect(
      pickHostingUrl([
        { status: "provisioning", external_ref: { url: "https://app.example.com" } },
      ]),
    ).toBeNull();
  });

  it("returns null when the ready row has no url field", () => {
    expect(
      pickHostingUrl([{ status: "ready", external_ref: {} }]),
    ).toBeNull();
  });

  it("returns null on empty list", () => {
    expect(pickHostingUrl([])).toBeNull();
  });
});

describe("shouldSkipDueToExisting", () => {
  const now = new Date("2026-05-30T10:00:00Z");
  const cooldown_ms = 7 * 24 * 60 * 60 * 1000;

  it("blocks on any pending row", () => {
    expect(
      shouldSkipDueToExisting({
        rows: [{ status: "pending", created_at: now.toISOString() }],
        now,
        cooldown_ms,
      }),
    ).toBe(true);
  });

  it("blocks on any accepted row (refine likely in flight)", () => {
    expect(
      shouldSkipDueToExisting({
        rows: [{ status: "accepted", created_at: now.toISOString() }],
        now,
        cooldown_ms,
      }),
    ).toBe(true);
  });

  it("blocks on a dismissed row INSIDE the cooldown window", () => {
    const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      shouldSkipDueToExisting({
        rows: [{ status: "dismissed", created_at: recent }],
        now,
        cooldown_ms,
      }),
    ).toBe(true);
  });

  it("does NOT block on a dismissed row OLDER than the cooldown window", () => {
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      shouldSkipDueToExisting({
        rows: [{ status: "dismissed", created_at: old }],
        now,
        cooldown_ms,
      }),
    ).toBe(false);
  });

  it("does NOT block on an empty list", () => {
    expect(shouldSkipDueToExisting({ rows: [], now, cooldown_ms })).toBe(false);
  });
});

function makeDeps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    isAutopilotEnabled: async () => true,
    loadEligibleConductorRun: async () => ({
      id: "cond-eligible-1",
      tenant_id: "t-1",
      created_at: "2026-05-28T10:00:00Z",
      updated_at: "2026-05-28T10:00:00Z",
    }),
    loadHostingRows: async () => [
      { status: "ready", external_ref: { url: "https://app.example.com" } },
    ],
    loadExistingSuggestions: async () => [],
    probeLiveness: async () => true,
    insertSuggestion: async () => "sug-new-1",
    ...overrides,
  };
}

describe("scanOneTenant", () => {
  const now = new Date("2026-05-30T10:00:00Z");

  it("skips when the tenant has autopilot_enabled=false (zero DB load)", async () => {
    const loadRunSpy = vi.fn();
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        isAutopilotEnabled: async () => false,
        loadEligibleConductorRun: loadRunSpy as never,
      }),
    );
    expect(out.status).toBe("skipped_autopilot_disabled");
    expect(loadRunSpy).not.toHaveBeenCalled();
  });

  it("skips when there is no eligible conductor run (no done+>24h)", async () => {
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({ loadEligibleConductorRun: async () => null }),
    );
    expect(out.status).toBe("skipped_no_eligible_run");
  });

  it("skips when there is no provisioned hosting URL", async () => {
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({ loadHostingRows: async () => [] }),
    );
    expect(out.status).toBe("skipped_no_live_url");
  });

  it("skips when a pending suggestion already exists for the same conductor_run_id (idempotent)", async () => {
    const probeSpy = vi.fn(async () => true);
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        loadExistingSuggestions: async () => [
          { status: "pending", created_at: now.toISOString() },
        ],
        probeLiveness: probeSpy,
      }),
    );
    expect(out.status).toBe("skipped_cooldown");
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("skips when the live URL fails the content-liveness probe", async () => {
    const insertSpy = vi.fn(async () => "should-not-insert");
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        probeLiveness: async () => false,
        insertSuggestion: insertSpy as never,
      }),
    );
    expect(out.status).toBe("skipped_not_live");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("inserts a suggestion when all gates pass, returns the new id + conductor_run_id", async () => {
    const insertedRows: Array<{
      tenant_id: string;
      conductor_run_id: string;
      suggestion: string;
      evidence: Record<string, unknown>;
    }> = [];
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        insertSuggestion: async (row) => {
          insertedRows.push(row);
          return "sug-inserted-1";
        },
      }),
    );
    expect(out.status).toBe("suggested");
    if (out.status !== "suggested") return;
    expect(out.suggestion_id).toBe("sug-inserted-1");
    expect(out.conductor_run_id).toBe("cond-eligible-1");
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].tenant_id).toBe("t-1");
    expect(insertedRows[0].conductor_run_id).toBe("cond-eligible-1");
    expect(insertedRows[0].suggestion).toMatch(/hero copy|polish/i);
    expect(insertedRows[0].evidence).toMatchObject({
      kind: "canned_weekly_v1",
      hosting_url: "https://app.example.com",
      eligible_conductor_run_id: "cond-eligible-1",
    });
    expect((insertedRows[0].evidence as { live_days: number }).live_days).toBeGreaterThanOrEqual(1);
  });

  it("returns error (not throws) when the conductor read fails — sweep keeps going", async () => {
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        loadEligibleConductorRun: async () => {
          throw new Error("connection reset");
        },
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") return;
    expect(out.reason).toMatch(/connection reset/);
  });

  it("returns error (not throws) when the insert fails — sweep keeps going", async () => {
    const out = await scanOneTenant(
      "t-1",
      now,
      makeDeps({
        insertSuggestion: async () => {
          throw new Error("constraint violation");
        },
      }),
    );
    expect(out.status).toBe("error");
    if (out.status !== "error") return;
    expect(out.reason).toMatch(/constraint violation/);
  });
});

describe("refine-suggestion-scan — source-text contract", () => {
  it("worker source imports BOTH gates (fleet_halt RPC + autopilot_enabled per-tenant) and is a daily cron", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../refine-suggestion-scan.ts"),
      "utf-8",
    );
    expect(src).toMatch(/is_fleet_halted/);
    expect(src).toMatch(/fail-CLOSED|fail-closed/i);
    expect(src).toMatch(/isWorkerCronStopped\("refine-suggestion-scan"\)/);
    expect(src).not.toMatch(/getBoolSetting\("autopilot_enabled"/);
    expect(src).toMatch(/cron:\s*"0 10 \* \* \*"/);
    expect(src).toMatch(/concurrency:\s*1/);
    expect(src).toMatch(/ELIGIBLE_CONDUCTOR_KIND\s*=\s*"build_app"/);
    expect(src).toMatch(/status:\s*"pending"/);
  });
});

describe("realScanDeps.loadEligibleConductorRun with two sites in the tenant", () => {
  it("skips newer site runs and anchors on the newest old-flow run", async () => {
    const site = (id: string, at: string, sid: string) => ({ id, tenant_id: "t1", created_at: at, updated_at: at, goal_graph: [{ payload: { stage: "provision", site_id: sid } }] });
    const rows = [
      site("site-b", "2026-09-30T00:00:00Z", "bbbbbbbb-0000-4000-8000-00000000000b"),
      site("site-a", "2026-09-29T00:00:00Z", "aaaaaaaa-0000-4000-8000-00000000000a"),
      { id: "old-1", tenant_id: "t1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", goal_graph: [{ payload: { stage: "spec" } }] },
    ];
    const nulls: string[] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "order"]) q[m] = () => q;
    q.is = (col: string, v: null) => (v === null && nulls.push(col), q);
    q.limit = async () => {
      const at = (r: (typeof rows)[number], i: number) =>
        ((r.goal_graph as Array<{ payload?: { site_id?: string } }>)[i]?.payload?.site_id ?? null);
      const idx = (c: string) => Number(c.split("->")[1]);
      const kept = rows.filter((r) => nulls.every((c) => at(r, idx(c)) === null));
      return { data: kept.slice(0, 1), error: null };
    };
    vi.mocked(serviceClient).mockReturnValue({ from: () => q } as never);
    const row = await realScanDeps().loadEligibleConductorRun("t1", "2026-10-01T00:00:00Z");
    expect(row?.id).toBe("old-1");
    expect(nulls).toEqual([
      "goal_graph->0->payload->>site_id",
      "goal_graph->1->payload->>site_id",
      "goal_graph->2->payload->>site_id",
    ]);
  });
});
