
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  upsertOpts: [] as unknown[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      upsert: async (arr: Array<Record<string, unknown>>, opts: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        expect(table).toBe("onboarding_email_visits");
        m.upsertOpts.push(opts);
        const keys = (opts.onConflict ?? "").split(",");
        for (const r of arr) {
          const dup = m.rows.find((x) => keys.every((k) => x[k] === r[k]));
          if (dup && !opts.ignoreDuplicates) return { error: { message: "duplicate key" } };
          if (!dup) m.rows.push({ ...r });
        }
        return { error: null };
      },
    }),
  }),
}));

import { postOnboardingEmailVisit, onboardingStepFromSrc } from "../visit";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200 };
  res.status = vi.fn((c: number) => ((res.statusCode = c), res));
  res.end = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as unknown as import("express").Response & { statusCode: number };
}
const req = (body: unknown) => ({ body, headers: {}, query: {} }) as unknown as import("express").Request;

beforeEach(() => {
  m.rows = [];
  m.upsertOpts = [];
  m.requireAuth.mockReset();
  m.requireAuth.mockResolvedValue({ user_id: "u-1", tenant_id: "t-1", access_token: "tok" });
});

describe("POST /api/onboarding-emails/visit", () => {
  it("records the visit against the session's workspace and person", async () => {
    const res = mockRes();
    await postOnboardingEmailVisit(req({ src: "onb_3" }), res);
    expect(res.statusCode).toBe(204);
    expect(m.rows).toEqual([{ tenant_id: "t-1", user_id: "u-1", step: 3 }]);
  });

  it("ignores a workspace or person named in the body", async () => {
    await postOnboardingEmailVisit(req({ src: "onb_2", tenant_id: "t-other", user_id: "u-other" }), mockRes());
    expect(m.rows).toEqual([{ tenant_id: "t-1", user_id: "u-1", step: 2 }]);
  });

  it("writes nothing for an unknown email number or a malformed src, and still answers 204", async () => {
    for (const src of ["onb_5", "onb_11", "onb_0", "onb_03", "onb_100", "onb_3x", " onb_3", "foo", 3, null, undefined]) {
      const res = mockRes();
      await postOnboardingEmailVisit(req({ src }), res);
      expect(res.statusCode, String(src)).toBe(204);
    }
    expect(m.rows).toEqual([]);
    expect(m.upsertOpts).toEqual([]);
  });

  it("records the day-1 digest (email 10), whose button carries src=onb_10", async () => {
    await postOnboardingEmailVisit(req({ src: "onb_10" }), mockRes());
    expect(m.rows).toEqual([{ tenant_id: "t-1", user_id: "u-1", step: 10 }]);
  });

  it("a repeat visit from the same email does not make a second row", async () => {
    await postOnboardingEmailVisit(req({ src: "onb_1" }), mockRes());
    const res = mockRes();
    await postOnboardingEmailVisit(req({ src: "onb_1" }), res);
    expect(res.statusCode).toBe(204);
    expect(m.rows).toHaveLength(1);
    await postOnboardingEmailVisit(req({ src: "onb_4" }), mockRes());
    expect(m.rows.map((r) => r.step)).toEqual([1, 4]);
  });

  it("records nothing under a QA tenant override", async () => {
    m.requireAuth.mockResolvedValue({ user_id: "u-1", tenant_id: "t-2", access_token: "tok", tenant_overridden: true });
    const res = mockRes();
    await postOnboardingEmailVisit(req({ src: "onb_3" }), res);
    expect(res.statusCode).toBe(204);
    expect(m.rows).toEqual([]);
  });

  it("stops at requireAuth without a session", async () => {
    m.requireAuth.mockResolvedValue(null);
    const res = mockRes();
    await postOnboardingEmailVisit(req({ src: "onb_1" }), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(m.rows).toEqual([]);
  });
});

describe("onboardingStepFromSrc", () => {
  it("accepts only a real email number", () => {
    expect(onboardingStepFromSrc("onb_9")).toBe(9);
    expect(onboardingStepFromSrc("onb_5")).toBeNull();
    expect(onboardingStepFromSrc("onb_99")).toBeNull();
  });
});
