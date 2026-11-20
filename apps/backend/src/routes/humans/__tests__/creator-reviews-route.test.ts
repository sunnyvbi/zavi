
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const requireAuth = vi.fn();
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (req: Request, res: Response) => requireAuth(req, res),
}));

const submitCreatorReview = vi.fn();
const updateCreatorReview = vi.fn();
const getReviewForOrder = vi.fn();
const loadCreatorReputation = vi.fn();
vi.mock("@/services/humans/creatorReviews", () => ({
  submitCreatorReview: (...a: unknown[]) => submitCreatorReview(...a),
  updateCreatorReview: (...a: unknown[]) => updateCreatorReview(...a),
  getReviewForOrder: (...a: unknown[]) => getReviewForOrder(...a),
  loadCreatorReputation: (...a: unknown[]) => loadCreatorReputation(...a),
}));

const globalRows: Record<string, unknown>[] = [];
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: () => {
      let rows = [...globalRows];
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return api;
        },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      };
      return api;
    },
  }),
}));

import { getCreatorReputation, patchOrderReview, postOrderReview } from "@/routes/humans/reviews";

const ORDER = "11111111-0000-4000-8000-000000000011";
const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "77777777-0000-4000-8000-000000000077";

function fakeRes() {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, out };
}

const req = (params: Record<string, string>, body?: unknown) =>
  ({ params, body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  globalRows.length = 0;
  requireAuth.mockResolvedValue({ tenant_id: TENANT, user_id: USER, access_token: "tok" });
  submitCreatorReview.mockResolvedValue({ ok: true, review_id: "rev-1" });
});

describe("POST /api/humans/orders/:orderId/review", () => {
  it("never reaches the service when the caller has no tenant (a creator)", async () => {
    requireAuth.mockImplementation(async (_req: Request, res: Response) => {
      res.status(403).json({ error: { code: "no_active_tenant" } });
      return null;
    });
    const { res, out } = fakeRes();
    await postOrderReview(req({ orderId: ORDER }, { communication: 5, timeliness: 5, satisfaction: 5 }), res);
    expect(out.status).toBe(403);
    expect(submitCreatorReview).not.toHaveBeenCalled();
  });

  it("refuses a score outside 1-5 before it can reach the database", async () => {
    const { res, out } = fakeRes();
    await postOrderReview(req({ orderId: ORDER }, { communication: 6, timeliness: 5, satisfaction: 5 }), res);
    expect(out.status).toBe(400);
    expect(submitCreatorReview).not.toHaveBeenCalled();
  });

  it("refuses a non-uuid order id", async () => {
    const { res, out } = fakeRes();
    await postOrderReview(req({ orderId: "not-a-uuid" }, { communication: 5, timeliness: 5, satisfaction: 5 }), res);
    expect(out.status).toBe(400);
    expect(submitCreatorReview).not.toHaveBeenCalled();
  });

  it("passes the SERVER-derived tenant and user, never anything from the body", async () => {
    const { res } = fakeRes();
    await postOrderReview(
      req(
        { orderId: ORDER },
        { communication: 5, timeliness: 4, satisfaction: 5, tenant_id: "someone-else", reviewer_user_id: "spoofed" },
      ),
      res,
    );
    expect(submitCreatorReview).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorUserId: USER,
      orderId: ORDER,
      input: { communication: 5, timeliness: 4, satisfaction: 5 },
    });
  });

  it.each([
    ["order_not_found", 404],
    ["order_not_completed", 409],
    ["review_already_exists", 409],
    ["creator_cannot_review", 403],
  ])("maps %s to HTTP %s", async (code, status) => {
    submitCreatorReview.mockResolvedValue({ ok: false, code });
    const { res, out } = fakeRes();
    await postOrderReview(req({ orderId: ORDER }, { communication: 5, timeliness: 5, satisfaction: 5 }), res);
    expect(out.status).toBe(status);
  });
});

describe("PATCH /api/humans/orders/:orderId/review", () => {
  it("maps a frozen review to 409 with a sentence, not a stack", async () => {
    updateCreatorReview.mockResolvedValue({ ok: false, code: "review_frozen" });
    const { res, out } = fakeRes();
    await patchOrderReview(req({ orderId: ORDER }, { communication: 1, timeliness: 1, satisfaction: 1 }), res);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      error: { code: "review_frozen", message: expect.stringContaining("7 days") },
    });
  });
});

describe("GET /api/humans/creators/:slug/reputation", () => {
  it("is signed-in only: a caller with no tenant never reaches the read", async () => {
    requireAuth.mockImplementation(async (_req: Request, res: Response) => {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    });
    globalRows.push({ id: "m1", slug: "someone", vetting_state: "approved" });
    const { res, out } = fakeRes();
    await getCreatorReputation(req({ slug: "someone" }), res);
    expect(out.status).toBe(401);
    expect(loadCreatorReputation).not.toHaveBeenCalled();
  });

  it("404s a creator who is not approved, so a removed storefront stays pulled", async () => {
    globalRows.push({ id: "m1", slug: "someone", vetting_state: "rejected" });
    const { res, out } = fakeRes();
    await getCreatorReputation(req({ slug: "someone" }), res);
    expect(out.status).toBe(404);
    expect(loadCreatorReputation).not.toHaveBeenCalled();
  });

  it("404s an approved creator Zavi cannot pay, the same gate as search", async () => {
    for (const country_code of ["ZZ", null]) {
      globalRows.length = 0;
      globalRows.push({ id: "m1", slug: "someone", vetting_state: "approved", country_code });
      const { res, out } = fakeRes();
      await getCreatorReputation(req({ slug: "someone" }), res);
      expect(out.status).toBe(404);
    }
    expect(loadCreatorReputation).not.toHaveBeenCalled();
  });

  it("serves an approved creator's computed reputation", async () => {
    globalRows.push({ id: "m1", slug: "someone", vetting_state: "approved", country_code: "US" });
    loadCreatorReputation.mockResolvedValue({ display_state: "new_to_zavi", badges: [] });
    const { res, out } = fakeRes();
    await getCreatorReputation(req({ slug: "Someone" }), res);
    expect(loadCreatorReputation).toHaveBeenCalledWith("m1");
    expect(out.body).toMatchObject({ display_state: "new_to_zavi" });
  });
});
