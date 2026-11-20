
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn() }));

import { postUrlFor, publisherFor, verifyPost } from "../publications";

const answer = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("postUrlFor", () => {
  it("takes the platform's own https links only", () => {
    expect(postUrlFor("tiktok", "https://www.tiktok.com/@coupleapp/video/1")).toBe("https://www.tiktok.com/@coupleapp/video/1");
    expect(postUrlFor("youtube", "https://youtu.be/abc")).toBe("https://youtu.be/abc");
    expect(postUrlFor("tiktok", "https://evil.example/tiktok.com")).toBeNull();
    expect(postUrlFor("instagram", "http://instagram.com/p/1")).toBeNull();
    expect(postUrlFor("other", "https://blog.example/post")).toBe("https://blog.example/post");
    expect(postUrlFor("x", "not a url")).toBeNull();
  });
});

describe("publisherFor", () => {
  it("is the business for a creation-only package and the creator for an audience post", () => {
    expect(publisherFor({ kind: "ugc_video" })).toBe("business");
    expect(publisherFor({ kind: "audience_post" })).toBe("creator");
    expect(publisherFor(null)).toBe("business");
  });
});

describe("verifyPost", () => {
  const url = "https://www.tiktok.com/@coupleapp/video/1";

  it("verifies a post the platform finds under the entered account", async () => {
    const f = answer(200, { author_name: "Couple App", author_url: "https://www.tiktok.com/@coupleapp" });
    expect((await verifyPost("tiktok", url, "@coupleapp", f)).verification).toBe("verified");
  });

  it("fails a post by another account, naming who it is by", async () => {
    const f = answer(200, { author_name: "Someone Else", author_url: "https://www.tiktok.com/@someone" });
    const r = await verifyPost("tiktok", url, "coupleapp", f);
    expect(r.verification).toBe("failed");
    expect(r.note).toContain("Someone Else");
  });

  it("never verifies a handle that only starts with the entered one, or an empty account", async () => {
    const f = answer(200, { author_name: "coupleapp", author_url: "https://www.tiktok.com/@coupleapp.clips" });
    expect((await verifyPost("tiktok", url, "coupleapp", f)).verification).toBe("failed");
    const g = answer(200, { author_name: "Couple App", author_url: "https://www.tiktok.com/@coupleapp" });
    expect((await verifyPost("tiktok", url, "@", g)).verification).toBe("manual");
    expect((await verifyPost("tiktok", url, null, g)).verification).toBe("manual");
  });

  it("matches a non-ASCII handle the platform returns percent-encoded", async () => {
    const f = answer(200, { author_name: "Cat", author_url: "https://www.youtube.com/@%E7%8C%AB%E5%8B%95%E7%94%BB" });
    expect((await verifyPost("youtube", "https://youtu.be/x", "@猫動画", f)).verification).toBe("verified");
  });

  it("is manual, not failed, when the platform refuses the check", async () => {
    expect((await verifyPost("youtube", "https://youtu.be/x", "chan", answer(401))).verification).toBe("manual");
    expect((await verifyPost("tiktok", url, "coupleapp", answer(403))).verification).toBe("manual");
  });

  it("fails a link the platform does not find", async () => {
    expect((await verifyPost("youtube", "https://youtu.be/gone", null, answer(404))).verification).toBe("failed");
  });

  it("is pending, not failed, when the platform cannot be reached", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await verifyPost("youtube", "https://youtu.be/x", null, f)).verification).toBe("pending");
  });

  it("is manual where the platform has no public check, without calling out", async () => {
    const f = answer(200);
    expect((await verifyPost("instagram", "https://www.instagram.com/p/1", "coupleapp", f)).verification).toBe("manual");
    expect(f).not.toHaveBeenCalled();
  });
});
