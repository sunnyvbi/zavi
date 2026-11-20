import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn(async () => ({ started: true, reason: "started" })));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "t-session", user_id: "u-1", access_token: "tok" }),
}));
vi.mock("@/services/growth/auto-first-run", () => ({ startPreviewOnOpen: start }));

import { channelPreviewOnOpen } from "../preview-on-open";

function mkRes() {
  const res = { statusCode: 0, body: undefined as unknown } as { statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

describe("channelPreviewOnOpen", () => {
  it("starts the preview for the session's tenant, ignoring any tenant in the body", async () => {
    const res = mkRes();
    await channelPreviewOnOpen({ params: { slug: "reddit_organic" }, body: { tenant_id: "t-other" } } as unknown as Request, res as unknown as Response);
    expect(start).toHaveBeenCalledWith("t-session", "reddit_organic");
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ started: true, reason: "started" });
  });

  it("rejects a missing slug", async () => {
    const res = mkRes();
    start.mockClear();
    await channelPreviewOnOpen({ params: {} } as unknown as Request, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
});
