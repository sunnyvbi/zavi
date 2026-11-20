import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  auth: { tenant_id: "T1", user_id: "U1", access_token: "tok" } as
    | { tenant_id: string; user_id: string; access_token: string }
    | null,
  row: null as { id: string; tenant_id: string; status: string; dispatched_at: string | null; decision_class?: string } | null,
  updated: { id: "d1" } as { id: string } | null,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (
    _req: unknown,
    res: { status: (c: number) => { json: (b: unknown) => void } },
  ) => {
    if (!m.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return m.auth;
  },
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => {
        m.updates.push(patch);
        return {
          eq: () => ({
            eq: () => ({
              eq: () => ({
                or: () => ({
                  select: () => ({ maybeSingle: async () => ({ data: m.updated, error: null }) }),
                }),
              }),
            }),
          }),
        };
      },
    }),
  }),
}));

import { decisionCheck } from "../decision-check";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OLD = new Date(Date.now() - 45 * 60_000).toISOString();

function run(body: unknown, id = ID) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const res = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        resolve({ status: this.statusCode, body: b });
      },
    };
    void decisionCheck({ params: { id }, body } as never, res as never);
  });
}

beforeEach(() => {
  m.auth = { tenant_id: "T1", user_id: "U1", access_token: "tok" };
  m.row = { id: ID, tenant_id: "T1", status: "dispatching", dispatched_at: OLD, decision_class: "meta_ads.update_ad_set_budget" };
  m.updated = { id: ID };
  m.updates = [];
});

describe("POST /api/workspace/decisions/:id/check", () => {
  it("the answer NEVER changes status: went_through records a marker only", async () => {
    const { status, body } = await run({ went_through: true });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, resolved: "noted_applied" });
    expect(m.updates[0]).toEqual({ dispatch_error: "founder_checked_applied" });
  });

  it("not gone through records the marker, keeps the row counted, never re-sends", async () => {
    const { body } = await run({ went_through: false });
    expect(body).toEqual({ ok: true, resolved: "noted_not_applied" });
    expect(m.updates[0]).toEqual({ dispatch_error: "founder_checked_not_applied" });
  });

  it("a second answer cannot flip the first (first writer wins)", async () => {
    m.row = { id: ID, tenant_id: "T1", status: "dispatching", dispatched_at: OLD, decision_class: "meta_ads.update_ad_set_budget", dispatch_error: "founder_checked_applied" } as never;
    const { body } = await run({ went_through: false });
    expect(body).toEqual({ ok: true, resolved: "already", status: "dispatching" });
    expect(m.updates).toHaveLength(0);
  });

  it("a decision class that never produces a check card is not answerable", async () => {
    m.row = { id: ID, tenant_id: "T1", status: "dispatching", dispatched_at: OLD, decision_class: "jira.create_issue" };
    const { status } = await run({ went_through: true });
    expect(status).toBe(404);
    expect(m.updates).toHaveLength(0);
  });

  it("another tenant's decision reads as not found", async () => {
    m.row = { id: ID, tenant_id: "T2", status: "dispatching", dispatched_at: OLD, decision_class: "meta_ads.update_ad_set_budget" };
    const { status } = await run({ went_through: true });
    expect(status).toBe(404);
    expect(m.updates).toHaveLength(0);
  });

  it("a decision still inside the in-flight window is refused", async () => {
    m.row = { id: ID, tenant_id: "T1", status: "dispatching", dispatched_at: new Date().toISOString(), decision_class: "meta_ads.update_ad_set_budget" };
    const { status, body } = await run({ went_through: true });
    expect(status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe("still_dispatching");
    expect(m.updates).toHaveLength(0);
  });

  it("a decision the worker already resolved answers 'already', no write", async () => {
    m.row = { id: ID, tenant_id: "T1", status: "acted", dispatched_at: OLD, decision_class: "meta_ads.update_ad_set_budget" };
    const { body } = await run({ went_through: true });
    expect(body).toEqual({ ok: true, resolved: "already", status: "acted" });
    expect(m.updates).toHaveLength(0);
  });

  it("losing the conditional-update race answers 'already'", async () => {
    m.updated = null;
    const { body } = await run({ went_through: true });
    expect(body).toEqual({ ok: true, resolved: "already", status: "unknown" });
  });

  it("bad id and bad body are clean 400s", async () => {
    expect((await run({ went_through: true }, "nope")).status).toBe(400);
    expect((await run({ went_through: "yes" })).status).toBe(400);
  });
});
