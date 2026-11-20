
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ getConnectorToken: vi.fn(), getSecret: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.getConnectorToken }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: m.getSecret }));

import { publishInstagramImage, isInstagramSocialConnected } from "../publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const IMG = "https://sb.example/storage/v1/object/sign/x.jpg?token=abc";

type Call = { url: string; init?: RequestInit };
function stubSeq(seq: Array<{ match: string; status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const step = seq[Math.min(i, seq.length - 1)];
      i++;
      if (!String(url).includes(step.match)) throw new Error(`call ${i} expected ${step.match}, got ${url}`);
      const status = step.status ?? 200;
      return { ok: status < 400, status, json: async () => step.body, text: async () => JSON.stringify(step.body) };
    }),
  );
  return calls;
}

beforeEach(() => {
  m.getConnectorToken.mockReset().mockResolvedValue("tok_ig");
  m.getSecret.mockReset().mockResolvedValue("17841499999");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishInstagramImage", () => {
  it("creates the container from the signed URL + caption, polls to FINISHED, publishes, reads the permalink", async () => {
    const calls = stubSeq([
      { match: "/17841499999/media", body: { id: "c-1" } },
      { match: "/c-1?fields=status_code", body: { status_code: "FINISHED" } },
      { match: "/17841499999/media_publish", body: { id: "m-9" } },
      { match: "/m-9?fields=permalink", body: { permalink: "https://www.instagram.com/p/AbC/" } },
    ]);
    const r = await publishInstagramImage(TENANT, "hello ig", IMG, { pollDelayMs: 0 });

    expect(r.ok).toBe(true);
    expect(r.raw.id).toBe("m-9");
    expect(r.raw.permalink).toBe("https://www.instagram.com/p/AbC/");
    expect(m.getConnectorToken).toHaveBeenCalledWith(TENANT, "instagram_social", "instagram_social.access_token");

    const create = calls[0];
    expect(create.url).toBe("https://graph.instagram.com/v23.0/17841499999/media");
    expect(create.init?.method).toBe("POST");
    const h = create.init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok_ig");
    expect(create.url).not.toContain("tok_ig");
    const form = new URLSearchParams(String(create.init?.body));
    expect(form.get("image_url")).toBe(IMG);
    expect(form.get("caption")).toBe("hello ig");

    const pub = calls[2];
    expect(new URLSearchParams(String(pub.init?.body)).get("creation_id")).toBe("c-1");
  });

  it("caps the caption at 2200 chars", async () => {
    const calls = stubSeq([
      { match: "/media", body: { id: "c" } },
      { match: "status_code", body: { status_code: "FINISHED" } },
      { match: "media_publish", body: { id: "m" } },
      { match: "permalink", body: {} },
    ]);
    await publishInstagramImage(TENANT, "a".repeat(3000), IMG, { pollDelayMs: 0 });
    expect(new URLSearchParams(String(calls[0].init?.body)).get("caption")).toHaveLength(2200);
  });

  it("passes a container-creation refusal through with the vendor status (→ vendor_rejected)", async () => {
    stubSeq([{ match: "/media", status: 400, body: { error: { message: "Only photo or video can be accepted as media type.", code: 9004 } } }]);
    const r = await publishInstagramImage(TENANT, "x", IMG, { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect((r.raw.error as { code: number }).code).toBe(9004);
  });

  it("a container that ends in ERROR is a stable 400, and media_publish is never called", async () => {
    const calls = stubSeq([
      { match: "/media", body: { id: "c-1" } },
      { match: "status_code", body: { status_code: "ERROR", status: "Error: Media download failed" } },
    ]);
    const r = await publishInstagramImage(TENANT, "x", IMG, { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  it("a container still IN_PROGRESS after the poll window is a 503 (transient → worker retries; nothing published)", async () => {
    const calls = stubSeq([
      { match: "/media", body: { id: "c-1" } },
      { match: "status_code", body: { status_code: "IN_PROGRESS" } },
    ]);
    const r = await publishInstagramImage(TENANT, "x", IMG, { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(calls.filter((c) => c.url.includes("status_code")).length).toBe(10);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  it("throws when not connected (resolver should have refused earlier)", async () => {
    m.getConnectorToken.mockResolvedValue(null);
    await expect(publishInstagramImage(TENANT, "x", IMG)).rejects.toThrow(/not connected/);
  });
});

describe("isInstagramSocialConnected", () => {
  it("true only when BOTH token and professional user id resolve; false on a refresh failure", async () => {
    expect(await isInstagramSocialConnected(TENANT)).toBe(true);
    m.getSecret.mockResolvedValue(null);
    expect(await isInstagramSocialConnected(TENANT)).toBe(false);
    m.getSecret.mockResolvedValue("178");
    m.getConnectorToken.mockRejectedValue(new Error("refresh failed"));
    expect(await isInstagramSocialConnected(TENANT)).toBe(false);
  });
});
