import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const TENANT = "11111111-aaaa-aaaa-aaaa-111111111111";
const THREAD = "https://www.reddit.com/r/saas/comments/1abcde/how_do_you_find_users/";

const db = vi.hoisted(() => ({
  decisions: [] as Array<{ id: string; status: string; body: unknown }>,
  posts: new Map<string, { status: string; last_error: string | null }>(),
  readError: false,
  filters: [] as Array<[string, unknown]>,
}));

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "u1", tenant_id: TENANT, access_token: "x" })),
}));
vi.mock("../../services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async () => ({ data: "new-decision", error: null })),
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      let id = "";
      let statuses: string[] | null = null;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (k: string, v: unknown) => {
          db.filters.push([k, v]);
          if (k === "decision_id") id = String(v);
          return q;
        },
        in: (_k: string, v: string[]) => {
          statuses = v;
          return q;
        },
        order: () => q,
        limit: async () => ({
          data: tenant === TENANT ? db.decisions.filter((d) => !statuses || statuses.includes(d.status)) : [],
          error: db.readError ? { message: "boom" } : null,
        }),
        maybeSingle: async () => ({ data: table === "social_posts" ? db.posts.get(id) ?? null : null, error: null }),
      });
      return q;
    },
  }),
}));

import { tenantRpc } from "../../services/tenant-client";
import { socialPropose } from "../../routes/social/propose";

function mkRes() {
  const r = { _status: 200, _body: undefined as unknown,
    status(c: number) { r._status = c; return r; },
    json(b: unknown) { r._body = b; return r; } };
  return r;
}
const propose = async (text = "Here is what worked.") => {
  const res = mkRes();
  await socialPropose({ body: { channel: "reddit_comment", payload: { thread_url: THREAD, text } } } as Request, res as unknown as Response);
  return res;
};
const row = (id: string, status: string, text = "Here is what worked.") =>
  ({ id, status, body: { channel: "reddit_comment", payload: { thread_url: THREAD, text } } });

beforeEach(() => {
  db.decisions = [];
  db.posts.clear();
  db.readError = false;
  db.filters = [];
  vi.mocked(tenantRpc).mockClear();
});

it("returns the reply already posted instead of staging it again", async () => {
  db.decisions = [row("d-old", "acted")];
  db.posts.set("d-old", { status: "published", last_error: null });
  const res = await propose();
  expect(res._body).toMatchObject({ decision_id: "d-old", existing: true, status: "acted" });
  expect(tenantRpc).not.toHaveBeenCalled();
  expect(db.filters.map(([k]) => k)).toContain("body->payload->>thread_url");
});

it("an edited copy of a reply already sent to that thread is not a second reply", async () => {
  db.decisions = [row("d-old", "dispatching", "The first wording.")];
  expect((await propose())._body).toMatchObject({ decision_id: "d-old", existing: true, status: "dispatching" });
  expect(tenantRpc).not.toHaveBeenCalled();
});

it("reuses a pending proposal only for the same text", async () => {
  db.decisions = [row("d-pending-other", "proposed", "Other text."), row("d-pending", "proposed")];
  expect((await propose())._body).toMatchObject({ decision_id: "d-pending", existing: true, status: "proposed" });
});

it("stages a new one after a refusal, a rate limit or timeout, or a rejection", async () => {
  db.decisions = [row("d-refused", "acted"), row("d-timeout", "acted"), row("d-rejected", "rejected"), row("d-pending-other", "proposed", "Other text.")];
  db.posts.set("d-refused", { status: "failed", last_error: "vendor_rejected" });
  db.posts.set("d-timeout", { status: "failed", last_error: "transient_exhausted" });
  expect((await propose())._body).toMatchObject({ decision_id: "new-decision" });
  expect(tenantRpc).toHaveBeenCalledTimes(1);
});

it("does not stage blind when the duplicate check cannot read", async () => {
  db.readError = true;
  const res = await propose();
  expect(res._status).toBe(503);
  expect(tenantRpc).not.toHaveBeenCalled();
});
