
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const USER_A = "22222222-bbbb-bbbb-bbbb-222222222222";
const IMG_PATH = `${TENANT_A}/33333333-cccc-cccc-cccc-333333333333.jpg`;
const OTHER_IMG = "99999999-dddd-dddd-dddd-999999999999/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../services/auth/middleware", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../../services/tenant-client", () => ({
  tenantRpc: vi.fn(),
}));

import { requireAuth } from "../../services/auth/middleware";
import { tenantRpc } from "../../services/tenant-client";
import { socialPropose } from "../../routes/social/propose";
import { resetTenantPlan, tenantPlan } from "../helpers/tenant-plan";

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 0,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

let emitSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTenantPlan();
  emitSpy = tenantRpc as ReturnType<typeof vi.fn>;
  emitSpy.mockReset();
  emitSpy.mockResolvedValue({ data: "dec-123", error: null });
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user_id: USER_A,
    tenant_id: TENANT_A,
    access_token: "fake",
  });
});

describe("POST /api/social/propose", () => {
  it("stages linkedin text via emit_decision", async () => {
    const req = {
      body: {
        channel: "linkedin",
        payload: { text: "Hello world" },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect((res._body as { ok: boolean; decision_id: string }).ok).toBe(true);
    expect((res._body as { decision_id: string }).decision_id).toBe("dec-123");
    expect(emitSpy).toHaveBeenCalledWith(TENANT_A, "emit_decision", {
      p_agent_run_id: null,
      p_decision_class: "social.publish.v2",
      p_body: expect.objectContaining({
        channel: "linkedin",
        payload: { text: "Hello world" },
        origin: "user_initiated_composer",
        scheduled_at: null,
      }),
    });
  });

  it("stages linkedin_image when image_path is tenant-owned", async () => {
    const req = {
      body: {
        channel: "linkedin_image",
        payload: { text: "Pic post", image_path: IMG_PATH },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect((res._body as { ok: boolean }).ok).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      TENANT_A,
      "emit_decision",
      expect.objectContaining({
        p_body: expect.objectContaining({
          channel: "linkedin_image",
          payload: { text: "Pic post", image_path: IMG_PATH },
        }),
      }),
    );
  });

  it("403 when image_path belongs to another tenant", async () => {
    const req = {
      body: {
        channel: "linkedin_image",
        payload: { text: "Nope", image_path: OTHER_IMG },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(403);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("403 when video_path (youtube_video) belongs to another tenant — same gate as image_path", async () => {
    const req = {
      body: {
        channel: "youtube_video",
        payload: {
          title: "Nope",
          text: "d",
          video_path: "99999999-dddd-dddd-dddd-999999999999/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
        },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(403);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("403 when video_path is a URL instead of a storage path", async () => {
    const req = {
      body: {
        channel: "youtube_video",
        payload: { title: "T", text: "d", video_path: "https://evil.example/v.mp4" },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(403);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("stages a youtube_video post with a tenant-owned video (privacy defaulted by the schema)", async () => {
    const VID = `${TENANT_A}/33333333-cccc-cccc-cccc-333333333333.mp4`;
    const req = {
      body: {
        channel: "youtube_video",
        payload: { title: "Launch", text: "desc", video_path: VID },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status === 0 || res._status === 200).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      TENANT_A,
      "emit_decision",
      expect.objectContaining({
        p_decision_class: "social.publish.v2",
        p_body: expect.objectContaining({
          channel: "youtube_video",
          payload: { title: "Launch", text: "desc", video_path: VID, privacy: "public" },
        }),
      }),
    );
  });

  it("carries an ISO scheduled_at into the decision body", async () => {
    const req = {
      body: { channel: "linkedin", payload: { text: "Later" }, scheduled_at: "2099-01-02T09:00:00Z" },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(emitSpy).toHaveBeenCalledWith(
      TENANT_A,
      "emit_decision",
      expect.objectContaining({ p_body: expect.objectContaining({ scheduled_at: "2099-01-02T09:00:00Z" }) }),
    );
  });

  it("400 on a non-ISO scheduled_at", async () => {
    const req = {
      body: { channel: "linkedin", payload: { text: "Later" }, scheduled_at: "tomorrow 9am" },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(400);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("400 on unknown channel", async () => {
    const req = {
      body: { channel: "tiktok", payload: { text: "nope" } },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(400);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("400 when reddit payload missing subreddit", async () => {
    const req = {
      body: {
        channel: "reddit",
        payload: { title: "T", text: "body" },
      },
    } as Request;
    const res = mkRes();
    await socialPropose(req, res);
    expect(res._status).toBe(400);
    expect(emitSpy).not.toHaveBeenCalled();
  });
  describe("the plan", () => {
    const linkedin = () => ({ body: { channel: "linkedin", payload: { text: "Hello world" } } }) as Request;

    it("Free: 403 with the upgrade body, and nothing is staged", async () => {
      tenantPlan.tier = "free";
      const res = mkRes();
      await socialPropose(linkedin(), res);
      expect(res._status).toBe(403);
      expect(res._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "starter" } });
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("Starter: staged as before", async () => {
      tenantPlan.tier = "starter";
      const res = mkRes();
      await socialPropose(linkedin(), res);
      expect((res._body as { ok: boolean }).ok).toBe(true);
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it("an unreadable plan refuses rather than staging", async () => {
      tenantPlan.unreadable = true;
      const res = mkRes();
      await socialPropose(linkedin(), res);
      expect(res._status).toBe(403);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("an unknown channel is still a 400, not a plan answer", async () => {
      tenantPlan.tier = "free";
      const res = mkRes();
      await socialPropose({ body: { channel: "myspace", payload: {} } } as Request, res);
      expect(res._status).toBe(400);
    });
  });

  it("never puts a tenant id in the RPC arg bag — the facade injects it", () => {
    const code = readFileSync("src/routes/social/propose.ts", "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/p_tenant_id/);
    expect(code).not.toMatch(/serviceClient/);
  });
});
