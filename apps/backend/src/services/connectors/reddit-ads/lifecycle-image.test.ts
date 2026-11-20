import { describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ sign: vi.fn(async () => "https://store.test/signed.png?token=x"), post: vi.fn(async () => ({ id: "post_1" })), pages: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [{ id: "profile" }]), path: vi.fn(async (): Promise<string | null> => "tenant-a/run/social-1.png") }));
vi.mock("./creative-images", async (orig) => ({ ...(await orig<typeof import("./creative-images")>()), signCreativeImage: m.sign, creativeImagePath: m.path }));
vi.mock("./writes", () => ({ createImagePost: m.post, createObject: vi.fn(), patchObject: vi.fn() }));
vi.mock("./adapter", async (orig) => ({ ...(await orig<typeof import("./adapter")>()), pages: m.pages }));
import { createCreative, findStepPost } from "./lifecycle";
import type { OperationStore } from "./operations";

function store(): OperationStore & { claims: Array<Record<string, unknown>> } {
  const claims: Array<Record<string, unknown>> = [];
  return { claims, read: async () => null, list: async () => [], claim: async (_s, req) => (claims.push(req), true), save: async () => undefined };
}

describe("createCreative with image_artifact_id", () => {
  it("signs at the write for the account's tenant; the durable request never carries the link", async () => {
    const s = store();
    const order: string[] = [];
    m.sign.mockImplementation(async () => (order.push("sign"), "https://store.test/signed.png?token=x"));
    const account = { tenant_id: "tenant-a", connected_account_id: "ca", toolkit: "reddit_ads", auth_config_id: "ac" } as never;
    await createCreative(account, "acct", "profile", "op_spring_1", 0, { name: "Ad one", headline: "A headline", image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", destination_url: "https://shop.example.com", allow_comments: false }, s, async () => void order.push("write"));
    expect(m.sign).toHaveBeenCalledWith("tenant-a", "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
    expect(order).toEqual(["sign", "write"]);
    expect(JSON.stringify(s.claims)).not.toContain("signed.png");
    expect(s.claims[0]).toMatchObject({ content: [{ image_artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", destination_url: "https://shop.example.com" }] });
    expect(m.post).toHaveBeenCalledWith(account, "profile", expect.objectContaining({ content: [{ media_url: "https://store.test/signed.png?token=x", destination_url: "https://shop.example.com" }] }));
  });
});

process.env.SUPABASE_URL = "https://x.supabase.co";

describe("recovering a lost post write adopts only the post THIS step made", () => {
  const CLAIMED = "2026-10-12T10:00:00.000Z";
  const ART = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
  const request = { type: "IMAGE", headline: "A headline", allow_comments: false, content: [{ image_artifact_id: ART, destination_url: "https://shop.example.com" }], profile_id: "profile" };
  const post = (id: string, media: string, created_at: string | undefined) => ({ id, profile_id: "profile", headline: "A headline", type: "IMAGE", allow_comments: false, content: [{ media_url: media, destination_url: "https://shop.example.com" }], ...(created_at ? { created_at } : {}) });
  const ours = "https://x.supabase.co/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-1.png?token=abc";
  const other = "https://x.supabase.co/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-2.png?token=abc";

  it("an older post with the same words but another image is never adopted; the new post with this image is", async () => {
    const older = post("post_old", other, "2026-10-01T00:00:00Z");
    expect(await findStepPost("tenant-a", [older], request, CLAIMED)).toBeNull();
    const olderSameImage = post("post_old2", ours, "2026-10-01T00:00:00Z");
    expect(await findStepPost("tenant-a", [older, olderSameImage], request, CLAIMED)).toBeNull();
    const mine = post("post_new", ours, "2026-10-12T10:00:05Z");
    expect(await findStepPost("tenant-a", [older, olderSameImage, mine], request, CLAIMED)).toMatchObject({ id: "post_new" });
  });

  it("the same object key on another host, under a longer path, or a near-miss key: never adopted", async () => {
    const at = "2026-10-12T10:00:05Z";
    for (const media of [
      "https://evil.example.com/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-1.png?token=abc",
      "https://x.supabase.co.evil.example/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-1.png",
      "https://x.supabase.co/proxy/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-1.png",
      "https://x.supabase.co/storage/v1/object/sign/agent-artifacts/other/tenant-a/run/social-1.png",
      "https://x.supabase.co/storage/v1/object/sign/agent-artifacts/tenant-a/run/social-1.png.jpg",
    ]) {
      expect(await findStepPost("tenant-a", [post("p", media, at)], request, CLAIMED), media).toBeNull();
    }
  });

  it("a post made long after the claim (outside the attempt window) is not this attempt's", async () => {
    expect(await findStepPost("tenant-a", [post("p_late", ours, "2026-10-12T10:30:00Z")], request, CLAIMED)).toBeNull();
    expect(await findStepPost("tenant-a", [post("p_ok", ours, "2026-10-12T10:09:00Z")], request, CLAIMED)).toMatchObject({ id: "p_ok" });
  });

  it("no claim time, no post time, or an image that is no longer this tenant's: nothing adopted (the step stays unknown)", async () => {
    const mine = post("post_new", ours, "2026-10-12T10:00:05Z");
    expect(await findStepPost("tenant-a", [mine], request, null)).toBeNull();
    expect(await findStepPost("tenant-a", [post("p", ours, undefined)], request, CLAIMED)).toBeNull();
    m.path.mockResolvedValueOnce(null);
    expect(await findStepPost("tenant-a", [mine], request, CLAIMED)).toBeNull();
  });

  it("a founder link: the exact content, and only when made after the claim", async () => {
    const link = { ...request, content: [{ media_url: "https://cdn.example.com/a.jpg", destination_url: "https://shop.example.com" }] };
    expect(await findStepPost("tenant-a", [post("p_old", "https://cdn.example.com/a.jpg", "2026-10-01T00:00:00Z")], link, CLAIMED)).toBeNull();
    expect(await findStepPost("tenant-a", [post("p_new", "https://cdn.example.com/a.jpg", "2026-10-12T10:01:00Z")], link, CLAIMED)).toMatchObject({ id: "p_new" });
  });

  it("through the write itself: a lost write whose only candidate is an older post leaves the step unknown, never adopted", async () => {
    const s = store();
    s.claim = async () => false;
    s.read = async () => ({ step: "post_0", state: "unknown", result: null, request_hash: "", request: {}, created_at: CLAIMED }) as never;
    const { requestHash } = await import("./operations");
    const req = { type: "IMAGE", headline: "A headline", allow_comments: false, content: [{ image_artifact_id: ART, destination_url: "https://shop.example.com" }], profile_id: "profile" };
    s.read = async () => ({ step: "post_0", state: "unknown", result: null, request_hash: requestHash(req), request: req, created_at: CLAIMED }) as never;
    m.pages.mockImplementation(async (_a: unknown, slug: unknown) => (slug === "LIST_POSTS" ? [post("post_old", other, "2026-10-01T00:00:00Z")] : [{ id: "profile" }]));
    const account = { tenant_id: "tenant-a" } as never;
    await expect(createCreative(account, "acct", "profile", "op", 0, { name: "Ad one", headline: "A headline", image_artifact_id: ART, destination_url: "https://shop.example.com", allow_comments: false }, s, async () => undefined)).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    m.pages.mockImplementation(async () => [{ id: "profile" }]);
  });
});
