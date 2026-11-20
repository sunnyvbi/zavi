import { describe, it, expect } from "vitest";
import {
  planReap,
  IDLE_SUSPEND_DAYS,
  type HostingRow,
} from "@/services/provisioning/hosting-idle-reaper";

const NOW = new Date("2026-09-01T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(over: Partial<HostingRow> = {}): HostingRow {
  return {
    tenant_id: "t1",
    render_service_id: "srv_1",
    suspended: "not_suspended",
    suspenders: [],
    last_human_at: daysAgo(1),
    ...over,
  };
}

describe("planReap — suspend side", () => {
  it("suspends a service whose tenant has NEVER had a human-triggered run", () => {
    const p = planReap([row({ last_human_at: null })], NOW);
    expect(p.suspend).toHaveLength(1);
    expect(p.resume).toHaveLength(0);
  });

  it("suspends past the idle window", () => {
    const p = planReap([row({ last_human_at: daysAgo(IDLE_SUSPEND_DAYS + 1) })], NOW);
    expect(p.suspend).toHaveLength(1);
  });

  it("leaves a tenant active inside the window alone", () => {
    const p = planReap([row({ last_human_at: daysAgo(IDLE_SUSPEND_DAYS - 1) })], NOW);
    expect(p.suspend).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/active within/i);
  });

  it("boundary: exactly at the window suspends (>=, not >)", () => {
    const p = planReap([row({ last_human_at: daysAgo(IDLE_SUSPEND_DAYS) })], NOW);
    expect(p.suspend).toHaveLength(1);
  });

  it("never reaps a tenant who attached their own domain, however idle", () => {
    const p = planReap(
      [row({ last_human_at: daysAgo(365), has_own_domain: true })],
      NOW,
    );
    expect(p.suspend).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/own domain/i);
  });
});

describe("planReap — cost gate", () => {
  it("never suspends a free-plan service, however idle", () => {
    const p = planReap([row({ plan: "free", last_human_at: null })], NOW);
    expect(p.suspend).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/free plan/i);
  });

  it("suspends an idle PAID service", () => {
    const p = planReap([row({ plan: "starter", last_human_at: null })], NOW);
    expect(p.suspend).toHaveLength(1);
  });

  it("still resumes a free-plan service when its tenant returns", () => {
    const p = planReap(
      [row({ plan: "free", suspended: "suspended", last_human_at: daysAgo(1) })],
      NOW,
    );
    expect(p.resume).toHaveLength(1);
  });
});

describe("planReap — resume side", () => {
  it("resumes a suspended service once a human comes back", () => {
    const p = planReap(
      [row({ suspended: "suspended", last_human_at: daysAgo(1) })],
      NOW,
    );
    expect(p.resume).toHaveLength(1);
    expect(p.suspend).toHaveLength(0);
  });

  it("leaves a suspended-and-still-idle service suspended", () => {
    const p = planReap(
      [row({ suspended: "suspended", last_human_at: daysAgo(90) })],
      NOW,
    );
    expect(p.resume).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/still idle/i);
  });

  it("never resumes a service Render suspended for billing or abuse", () => {
    for (const s of ["billing", "abuse", "platform"]) {
      const p = planReap(
        [row({ suspended: "suspended", suspenders: [s], last_human_at: daysAgo(1) })],
        NOW,
      );
      expect(p.resume, `suspender=${s}`).toHaveLength(0);
      expect(p.skipped[0].reason).toMatch(/platform/i);
    }
  });

  it("a never-touched tenant is not resumed just because it is suspended", () => {
    const p = planReap(
      [row({ suspended: "suspended", last_human_at: null })],
      NOW,
    );
    expect(p.resume).toHaveLength(0);
  });
});

describe("planReap — database gone", () => {
  it("does not resume a returning tenant whose database was torn down", () => {
    const p = planReap(
      [row({ suspended: "suspended", last_human_at: daysAgo(1), has_db: false })],
      NOW,
    );
    expect(p.resume).toHaveLength(0);
    expect(p.skipped[0].reason).toMatch(/database is gone/);
  });

  it("still resumes when the database is ready, or the app never had one", () => {
    const p = planReap(
      [
        row({ suspended: "suspended", last_human_at: daysAgo(1), has_db: true }),
        row({ render_service_id: "srv_2", suspended: "suspended", last_human_at: daysAgo(1) }),
      ],
      NOW,
    );
    expect(p.resume).toHaveLength(2);
  });
});

describe("planReap — safety invariants", () => {
  it("produces only suspend/resume actions — never a delete", () => {
    const p = planReap([row(), row({ last_human_at: null })], NOW);
    expect(Object.keys(p).sort()).toEqual(["resume", "skipped", "suspend"]);
  });

  it("every row lands in exactly one bucket (no silent drops)", () => {
    const rows = [
      row({ last_human_at: null }),
      row({ render_service_id: "srv_2", last_human_at: daysAgo(1) }),
      row({ render_service_id: "srv_3", suspended: "suspended", last_human_at: daysAgo(1) }),
      row({ render_service_id: "srv_4", suspended: "suspended", suspenders: ["billing"] }),
      row({ render_service_id: "srv_5", has_own_domain: true, last_human_at: daysAgo(99) }),
    ];
    const p = planReap(rows, NOW);
    expect(p.suspend.length + p.resume.length + p.skipped.length).toBe(rows.length);
  });

  it("an empty input is a no-op, not a sweep of everything", () => {
    const p = planReap([], NOW);
    expect(p).toEqual({ suspend: [], resume: [], skipped: [] });
  });
});
