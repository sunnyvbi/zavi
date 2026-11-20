
import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): unknown => {
    const p: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "limit"]) p[m] = () => p;
    p.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: db.rows[table] ?? [], error: null }).then(res);
    return p;
  };
  return { staffCrossTenantClient: () => ({ from: (t: string) => chain(t) }) };
});

import { aggregateOnboardingEmailStats, staffOnboardingEmailsStats } from "../onboarding-emails-stats";

const V = "2026-10-06T10:00:00Z";
const plus = (h: number) => new Date(Date.parse(V) + h * 3_600_000).toISOString();

describe("aggregateOnboardingEmailStats", () => {
  it("counts sent from sent_steps, visits per email, and acted within 2 days of the visit", () => {
    const out = aggregateOnboardingEmailStats({
      sequences: [
        { tenant_id: "a", user_id: "ua", sent_steps: [1, 10, 6] },
        { tenant_id: "b", user_id: "ub", sent_steps: [1, 2] },
        { tenant_id: "test", user_id: "ut", sent_steps: [1, 10] },
      ],
      visits: [
        { tenant_id: "a", user_id: "ua", step: 10, visited_at: V },
        { tenant_id: "b", user_id: "ub", step: 2, visited_at: V },
        { tenant_id: "test", user_id: "ut", step: 10, visited_at: V },
      ],
      actedAt: [
        { tenant_id: "a", at: plus(5) },
        { tenant_id: "b", at: plus(60) },
        { tenant_id: "b", at: plus(-1) },
        { tenant_id: "test", at: plus(1) },
      ],
      excluded: new Set(["test"]),
    });
    const by = new Map(out.map((s) => [s.step, s]));
    expect(by.get(1)).toMatchObject({ sent: 2, visits: 0, acted: 0 });
    expect(by.get(10)).toMatchObject({ sent: 1, visits: 1, acted: 1, label: "First results (digest)" });
    expect(by.get(2)).toMatchObject({ sent: 1, visits: 1, acted: 0 });
    expect(by.get(6)).toMatchObject({ sent: 1 });
    expect(out.map((s) => s.step)).toEqual([1, 10, 2, 3, 4, 6, 7, 8, 9]);
  });
});

describe("staffOnboardingEmailsStats", () => {
  beforeEach(() => {
    db.rows = {};
  });

  const res = () => {
    const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
    return r;
  };

  it("refuses a request that did not pass the staff gate", async () => {
    await expect(staffOnboardingEmailsStats({} as never, res() as never)).rejects.toThrow(/assertStaff/);
  });

  it("leaves test and dogfood workspaces out and states the denominator", async () => {
    db.rows.tenants = [
      { id: "real", slug: "acme", kind: "real" },
      { id: "dog", slug: "upcar-ai", kind: "real" },
      { id: "qa", slug: "qa-1", kind: "test" },
    ];
    db.rows.onboarding_email_sequence = [
      { tenant_id: "real", user_id: "u1", sent_steps: [1] },
      { tenant_id: "dog", user_id: "u2", sent_steps: [1] },
      { tenant_id: "qa", user_id: "u3", sent_steps: [1] },
    ];
    const r = res();
    await staffOnboardingEmailsStats({ staff: { user_id: "s" } } as never, r as never);
    const body = r.body as { steps: Array<{ step: number; sent: number }>; denominator: { people_in_sequence: number; excludes: string } };
    expect(body.steps.find((s) => s.step === 1)?.sent).toBe(1);
    expect(body.denominator.people_in_sequence).toBe(1);
    expect(body.denominator.excludes).toMatch(/kind='test'.*upcar-ai, upcar-private, apna-tutor-dogfood/);
  });
});
