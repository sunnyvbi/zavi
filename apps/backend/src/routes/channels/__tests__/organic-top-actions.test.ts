
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
let roleAllowed = true;
const h = vi.hoisted(() => ({ send: vi.fn(), locked: null as unknown, boards: vi.fn(), flatOn: true }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: async () => h.locked }));
vi.mock("@/services/connectors/tiktok/api", () => ({ sendTikTokVideoToInbox: h.send, TIKTOK_VIDEO_PATH_RE: /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/ }));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({ listPinterestBoards: h.boards }));
vi.mock("../run", () => ({ startChannelRun: vi.fn() }));
vi.mock("@/services/billing/flat-pricing", () => ({ isFlatJobPricingOn: async () => h.flatOn }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: vi.fn() }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: vi.fn() }));

import { tiktokSendToDrafts } from "../tiktok-drafts";
import { startTopAction, topActionContext } from "../top-actions";
import { startChannelRun } from "../run";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-2222-4333-8444-555555555555";
const FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4";
function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const send = async (body: unknown) => {
  const r = res();
  await tiktokSendToDrafts({ body } as unknown as Request, r as unknown as Response);
  return r;
};

beforeEach(() => {
  authResult = { tenant_id: TENANT, user_id: "u1", access_token: "t" };
  roleAllowed = true;
  h.locked = null;
  h.send.mockReset().mockResolvedValue({ publish_id: "p1" });
  h.boards.mockReset();
});

describe("POST /api/channels/tiktok_organic/drafts", () => {
  it("sends this workspace's own upload to the creator's drafts", async () => {
    const r = await send({ video_path: `${TENANT}/${FILE}`, consent: true });
    expect(r._status).toBe(200);
    expect(h.send).toHaveBeenCalledWith(TENANT, `${TENANT}/${FILE}`);
  });

  it("needs the consent box, and a file in this workspace", async () => {
    expect((await send({ video_path: `${TENANT}/${FILE}` }))._status).toBe(400);
    expect((await send({ video_path: `${OTHER}/${FILE}`, consent: true }))._status).toBe(400);
    expect((await send({ video_path: "https://evil.example/v.mp4", consent: true }))._status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses a tenant-override session and a plan without the channel", async () => {
    authResult = { ...authResult!, tenant_overridden: true };
    expect((await send({ video_path: `${TENANT}/${FILE}`, consent: true }))._status).toBe(403);
    authResult = { tenant_id: TENANT, user_id: "u1", access_token: "t" };
    h.locked = { body: { error: { code: "plan_upgrade_required", message: "Upgrade" } } };
    const r = await send({ video_path: `${TENANT}/${FILE}`, consent: true });
    expect(r._status).toBe(403);
    expect(r._body).toEqual({ error: { code: "plan_upgrade_required", message: "Upgrade" } });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("lets a plain member send a video to drafts", async () => {
    roleAllowed = false;
    expect((await send({ video_path: `${TENANT}/${FILE}`, consent: true }))._status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("says to connect TikTok when it is not connected", async () => {
    h.send.mockRejectedValue(new ExpectedToolError("tiktok_not_connected", "Connect TikTok at /x before using TikTok tools."));
    const r = await send({ video_path: `${TENANT}/${FILE}`, consent: true });
    expect(r._status).toBe(409);
    expect((r._body as { error: { message: string } }).error.message).toMatch(/Connect your TikTok account first/);
  });
});

describe("GET /api/channels/:slug/top-actions/:key/context", () => {
  const ctx = async (slug: string, key: string) => {
    const r = res();
    await topActionContext({ params: { slug, key } } as unknown as Request, r as unknown as Response);
    return r;
  };

  it("tells a run form what the run is billed: the flat price from job-prices.json, not the cap hold", async () => {
    h.flatOn = true;
    const { priceForJob } = await import("@/services/billing/job-prices");
    const { topActionDef } = await import("@/services/channels/top-actions");
    const billed = (agent_slug: string) => priceForJob({ agent_slug, trigger: "channel_recipe", payload: {}, cron_dedupe_key: null })!.credits;
    const r = await ctx("x_organic", "new_post");
    expect(r._body).toEqual({ credits: billed("x_organic") });
    const email = await ctx("email_marketing", "new_email");
    expect(email._body).toEqual({ credits: billed("email_marketing") });
    expect((email._body as { credits: number }).credits).not.toBe(topActionDef("email_marketing", "new_email")!.reserve_credits);
  });

  it("with flat pricing switched off (real cost applies) it falls back to what the run holds", async () => {
    h.flatOn = false;
    const r = await ctx("x_organic", "new_post");
    expect(r._body).toEqual({ credits: 60 });
    h.flatOn = true;
  });

  it("gives Pinterest's pin form the public boards, and 404s an unknown action", async () => {
    h.boards.mockResolvedValue({ ok: true, complete: true, boards: [{ id: "9", name: "Ideas", privacy: null }] });
    expect((await ctx("pinterest_organic", "create_pin"))._body).toEqual({ boards: [{ id: "9", label: "Ideas" }] });
    expect((await ctx("pinterest_organic", "nope"))._status).toBe(404);
  });
});

describe("POST .../top-actions/post_image_write (Zavi writes the caption)", () => {
  const IMG = `${TENANT}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
  const start = async (slug: string, key: string, inputs: Record<string, unknown>) => {
    const r = res();
    await startTopAction({ params: { slug, key }, body: { request_id: "req-12345678", inputs } } as unknown as Request, r as unknown as Response);
    return r;
  };
  beforeEach(() => {
    vi.mocked(startChannelRun).mockReset();
  });

  it("starts the run for this workspace's own upload, with a server-built brief naming it", async () => {
    await start("instagram_organic", "post_image_write", { image_path: IMG });
    expect(startChannelRun).toHaveBeenCalledTimes(1);
    const call = vi.mocked(startChannelRun).mock.calls[0];
    expect(call[2]).toBe("instagram_organic");
    const top = (call[3] as { topAction: { key: string; inputs: unknown; instruction: string } }).topAction;
    expect(top.key).toBe("post_image_write");
    expect(top.inputs).toEqual({ image_path: IMG });
    expect(top.instruction).toContain(JSON.stringify(IMG));
    expect(top.instruction).toContain('"instagram_image"');
  });

  it("refuses another workspace's image before any run starts", async () => {
    const r = await start("x_organic", "post_image_write", { image_path: `${OTHER}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg` });
    expect(r._status).toBe(400);
    expect((await start("linkedin_organic", "post_image_write", { image_path: "https://evil.example/a.jpg" }))._status).toBe(400);
    expect(startChannelRun).not.toHaveBeenCalled();
  });

  it("lets any member start an organic action; refuses a tenant-override session", async () => {
    roleAllowed = false;
    expect((await start("instagram_organic", "post_image_write", { image_path: IMG }))._status).toBe(200);
    expect((await start("x_organic", "new_post", {}))._status).toBe(200);
    expect(startChannelRun).toHaveBeenCalledTimes(2);
    vi.mocked(startChannelRun).mockClear();
    roleAllowed = true;
    authResult = { ...authResult!, tenant_overridden: true };
    expect((await start("instagram_organic", "post_image_write", { image_path: IMG }))._status).toBe(403);
    expect(startChannelRun).not.toHaveBeenCalled();
  });
});
