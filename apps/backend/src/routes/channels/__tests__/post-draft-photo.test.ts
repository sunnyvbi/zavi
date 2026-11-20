import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { z } from "zod";

const state = vi.hoisted(() => ({ authenticated: true, sign: vi.fn(), storage: vi.fn() }));
const tenant = "11111111-1111-4111-8111-111111111111";
const filename = "22222222-2222-4222-8222-222222222222.mp4";
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => state.authenticated ? { tenant_id: tenant } : null) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantStorage: state.storage }));
vi.mock("@/services/workspace-files/workspace-files", () => ({ workspaceFilesDeps: vi.fn(), readIndex: vi.fn(), readPublicWorkspaceFile: vi.fn() }));
vi.mock("@/services/chat-images/store-chat-image", () => ({ normalizeChatImage: vi.fn(), readUploadedFile: vi.fn(), sendChatImageError: vi.fn(), storeNormalizedChatImage: vi.fn() }));
import { postDraftVideoUrl } from "../post-draft-photo";

async function read(path: string) {
  const result = { status: 200, body: {} as unknown };
  const response = { status: (code: number) => { result.status = code; return response; }, setHeader: vi.fn(), json: (body: unknown) => { result.body = body; } };
  await postDraftVideoUrl({ query: { path } } as unknown as Request, response as unknown as Response);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.authenticated = true;
  state.sign.mockResolvedValue({ data: { signedUrl: "https://example.com/video.mp4" }, error: null });
  state.storage.mockReturnValue({ from: (bucket: string) => { expect(bucket).toBe("launch-video-media"); return { createSignedUrl: state.sign }; } });
});

describe("draft video access", () => {
  it("signs only the authenticated tenant's media through tenant storage", async () => {
    expect(await read(`${tenant}/${filename}`)).toEqual({ status: 200, body: { signed_url: "https://example.com/video.mp4" } });
    expect(state.storage).toHaveBeenCalledWith(tenant);
    expect(state.sign).toHaveBeenCalledWith(`${tenant}/${filename}`, 600);
  });
  it.each([`33333333-3333-4333-8333-333333333333/${filename}`, `${tenant}/../${filename}`, `${tenant}/${filename}.jpg`])("refuses an invalid or cross-tenant path %s before accessing storage", async (path) => {
    expect((await read(path)).status).toBe(403);
    expect(state.storage).not.toHaveBeenCalled();
  });
  it("does not access storage without authentication", async () => {
    state.authenticated = false;
    await read(`${tenant}/${filename}`);
    expect(state.storage).not.toHaveBeenCalled();
  });
  it("fails closed when signing fails", async () => {
    state.sign.mockResolvedValue({ data: null, error: { message: "private failure" } });
    const result = await read(`${tenant}/${filename}`);
    expect(result.status).toBe(503);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(result.body).error.code).toBe("video_unavailable");
  });
});
