
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
import { getBoolSetting } from "@/services/settings";

import {
  generateSlug,
  SLUG_RE,
  scanArtifactForLeaks,
  shareablePreviewEnabled,
  publishPrototypeLink,
  publishWireframeLink,
  wireframeToolEnabled,
  prototypeLinkBaseUrl,
} from "../prototype-links";

describe("generateSlug", () => {
  it("produces a 20-24 char base62 slug matching SLUG_RE", () => {
    for (let i = 0; i < 50; i++) {
      const s = generateSlug();
      expect(SLUG_RE.test(s)).toBe(true);
    }
  });
  it("is deterministic given fixed bytes", () => {
    const b = Buffer.alloc(16, 7);
    expect(generateSlug(b)).toBe(generateSlug(b));
  });
  it("distinct random slugs (unguessability sanity)", () => {
    const set = new Set(Array.from({ length: 200 }, () => generateSlug()));
    expect(set.size).toBe(200);
  });
});

describe("SLUG_RE gate", () => {
  it("rejects traversal / injection shapes", () => {
    for (const bad of [
      "../etc/passwd",
      "abc/def",
      "x".repeat(30),
      "short",
      "has spaces here 1234567",
      "semi;colon0123456789012",
      "",
    ]) {
      expect(SLUG_RE.test(bad)).toBe(false);
    }
  });
});

describe("scanArtifactForLeaks (fail-closed publish gate)", () => {
  const clean = JSON.stringify({
    kind: "html_preview",
    title: "Hero redesign",
    summary: "Bigger headline, trust stats.",
    html: "<html><style>h1{color:#111}</style><h1>Find your tutor</h1></html>",
    html_before: "<html><h1>Old hero</h1></html>",
    rationale: [{ change: "Bigger headline", why: "Improves scannability" }],
  });

  it("passes a clean envelope", () => {
    expect(scanArtifactForLeaks(clean)).toEqual({ ok: true });
  });

  it.each([
    ["stripe_key", "sk_live_abcdefghijklmnop123456"],
    ["aws_access_key", "AKIAABCDEFGHIJKLMNOP"],
    ["github_token", "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
    ["slack_token", "xoxb-123456789-abcdefghij"],
    ["private_key_pem", "-----BEGIN RSA PRIVATE KEY-----"],
    ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"],
    ["env_secret_pair", 'SUPABASE_SERVICE_ROLE_KEY="abcdefgh12345678"'],
  ])("blocks %s anywhere in the serialized envelope", (_name, secret) => {
    const dirty = JSON.stringify({
      kind: "html_preview",
      title: "t",
      summary: "s",
      html: "<html></html>",
      rationale: [{ change: "c", why: `note ${secret}` }],
    });
    const res = scanArtifactForLeaks(dirty);
    expect(res.ok).toBe(false);
  });
});

describe("shareablePreviewEnabled (flag gate)", () => {
  beforeEach(() => {
    vi.mocked(getBoolSetting).mockReset();
  });
  it("false without tenant", async () => {
    expect(await shareablePreviewEnabled(null)).toBe(false);
  });
  it("resolves the app-setting", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(true);
    expect(await shareablePreviewEnabled("t1")).toBe(true);
    expect(getBoolSetting).toHaveBeenCalledWith(
      "engineer_shareable_preview_enabled",
      "t1",
    );
  });
  it("fail-closed on settings error", async () => {
    vi.mocked(getBoolSetting).mockRejectedValueOnce(new Error("db down"));
    expect(await shareablePreviewEnabled("t1")).toBe(false);
  });
});

describe("publishPrototypeLink", () => {
  beforeEach(() => {
    vi.mocked(getBoolSetting).mockReset();
  });
  it("returns disabled without touching supabase when the flag is OFF", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(false);
    const res = await publishPrototypeLink({
      tenant_id: "t1",
      run_id: "r1",
      envelope: { kind: "html_preview", title: "t", summary: "s", html: "<html></html>" },
    });
    expect(res).toEqual({ published: false, reason: "disabled" });
  });
});

describe("wireframeToolEnabled (default-ON flag gate)", () => {
  beforeEach(() => {
    vi.mocked(getBoolSetting).mockReset();
  });
  it("false without tenant (no run context, no publish)", async () => {
    expect(await wireframeToolEnabled(null)).toBe(false);
  });
  it("resolves the agent_wireframe_enabled app-setting", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(true);
    expect(await wireframeToolEnabled("t1")).toBe(true);
    expect(getBoolSetting).toHaveBeenCalledWith("agent_wireframe_enabled", "t1");
  });
  it("respects an explicit per-tenant OFF override (getBoolSetting returns false)", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(false);
    expect(await wireframeToolEnabled("t1")).toBe(false);
  });
});

describe("publishWireframeLink", () => {
  beforeEach(() => {
    vi.mocked(getBoolSetting).mockReset();
  });
  it("returns disabled without touching supabase when the flag is OFF", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(false);
    const res = await publishWireframeLink({
      tenant_id: "t1",
      run_id: "r1",
      envelope: { kind: "html_preview", title: "t", summary: "s", html: "<html></html>" },
    });
    expect(res).toEqual({ published: false, reason: "disabled" });
  });
  it("blocks (fail-closed) when a secret is planted in the wireframe html — even with the flag ON", async () => {
    vi.mocked(getBoolSetting).mockResolvedValueOnce(true);
    const res = await publishWireframeLink({
      tenant_id: "t1",
      run_id: "r1",
      envelope: {
        kind: "html_preview",
        title: "t",
        summary: "s",
        html: '<html><script>const k="sk_live_abcdefghijklmnop123456";</script></html>',
      },
    });
    expect(res.published).toBe(false);
    expect(res).toMatchObject({ reason: "blocked" });
  });
});

describe("prototypeLinkBaseUrl", () => {
  it("defaults to preview.zaviagent.com and strips trailing slashes", () => {
    const prev = process.env.PROTOTYPE_LINK_BASE_URL;
    delete process.env.PROTOTYPE_LINK_BASE_URL;
    expect(prototypeLinkBaseUrl()).toBe("https://preview.zaviagent.com");
    process.env.PROTOTYPE_LINK_BASE_URL = "http://localhost:3001/";
    expect(prototypeLinkBaseUrl()).toBe("http://localhost:3001");
    if (prev === undefined) delete process.env.PROTOTYPE_LINK_BASE_URL;
    else process.env.PROTOTYPE_LINK_BASE_URL = prev;
  });
});
