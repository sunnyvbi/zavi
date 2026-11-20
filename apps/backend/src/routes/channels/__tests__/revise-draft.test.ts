
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), create: vi.fn() }));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: m.create,
  DEFAULT_FAST_MODEL: "fast",
  cachedSystemBlock: (t: string) => ({ type: "text", text: t }),
}));

import { channelReviseDraft, xLength } from "../revise-draft";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
function res() {
  const r: { _status?: number; _body?: Record<string, unknown>; status: (n: number) => unknown; json: (b: Record<string, unknown>) => unknown } = {
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}
const reply = (text: string) => ({ content: [{ type: "text", text }] });
const req = (body: unknown, slug = "x_organic") => ({ params: { slug }, body }) as never;

beforeEach(() => {
  resetTenantPlan();
  m.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "u" });
  m.create.mockReset().mockResolvedValue(reply("Shorter."));
});

describe("POST /api/channels/x_organic/drafts/revise", () => {
  it("returns the rewrite", async () => {
    const r = res();
    await channelReviseDraft(req({ text: "A long draft.", instruction: "make it shorter" }), r as never);
    expect(r._body).toEqual({ ok: true, text: "Shorter.", thread: null, over_limit: false });
  });

  it("has no daily limit: fifty in a row all go through, and the route meters nothing", async () => {
    for (let i = 0; i < 50; i++) {
      const r = res();
      await channelReviseDraft(req({ text: "a", instruction: "shorter" }), r as never);
      expect(r._body).toMatchObject({ ok: true });
    }
    expect(m.create).toHaveBeenCalledTimes(50);
    const src = readFileSync(join(__dirname, "../revise-draft.ts"), "utf-8");
    expect(src).not.toMatch(/read-cap|consume_metered|PER_DAY/);
  });

  it("keeps a thread a thread", async () => {
    m.create.mockResolvedValue(reply("Root.\n---\nTwo.\n---\nThree."));
    const r = res();
    await channelReviseDraft(req({ text: "Root", thread: ["Two", "Three"], instruction: "tighten it" }), r as never);
    expect(r._body).toMatchObject({ text: "Root.", thread: ["Two.", "Three."] });
    expect(String(m.create.mock.calls[0][0].messages[0].content)).toContain("Root\n---\nTwo\n---\nThree");
  });

  it("reports an over-limit rewrite instead of hiding it", async () => {
    m.create.mockResolvedValue(reply("x".repeat(300)));
    const r = res();
    await channelReviseDraft(req({ text: "a", instruction: "make it much longer" }), r as never);
    expect(r._body).toMatchObject({ over_limit: true });
  });

  it("refuses other channels, empty instructions, and unauthenticated callers — before any model call", async () => {
    for (const [body, slug] of [[{ text: "a", instruction: "shorter" }, "reddit_organic"], [{ text: "a", instruction: "" }, "x_organic"], [{ instruction: "shorter" }, "x_organic"]] as const) {
      const r = res();
      await channelReviseDraft(req(body, slug), r as never);
      expect(r._status).toBe(400);
    }
    m.requireAuth.mockResolvedValue(null);
    await channelReviseDraft(req({ text: "a", instruction: "shorter" }), res() as never);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("a busy model gets its own honest message", async () => {
    m.create.mockRejectedValue(Object.assign(new Error("429 rate_limit_error"), { status: 429 }));
    const r = res();
    await channelReviseDraft(req({ text: "a", instruction: "shorter" }), r as never);
    expect(r._status).toBe(503);
    expect(r._body!.error).toMatchObject({ code: "llm_busy" });
  });

  it("a model failure or an empty answer is a clean error, never a fabricated rewrite", async () => {
    m.create.mockRejectedValue(Object.assign(new Error("boom"), { name: "TimeoutError" }));
    const r = res();
    await channelReviseDraft(req({ text: "a", instruction: "shorter" }), r as never);
    expect(r._status).toBe(504);
    expect(r._body!.text).toBeUndefined();
    m.create.mockReset().mockResolvedValue(reply("   "));
    const r2 = res();
    await channelReviseDraft(req({ text: "a", instruction: "shorter" }), r2 as never);
    expect(r2._status).toBe(502);
  });
});

describe("AI edit and the plan", () => {
  it("Free: 403 with the upgrade body, before any model call", async () => {
    tenantPlan.tier = "free";
    const r = res();
    await channelReviseDraft(req({ text: "A long draft.", instruction: "make it shorter" }), r as never);
    expect(r._status).toBe(403);
    expect(r._body!.error).toMatchObject({ code: "plan_upgrade_required", required_tier: "starter" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("Starter: the rewrite comes back as before", async () => {
    tenantPlan.tier = "starter";
    const r = res();
    await channelReviseDraft(req({ text: "A long draft.", instruction: "make it shorter" }), r as never);
    expect(r._body).toMatchObject({ ok: true, text: "Shorter." });
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe("xLength", () => {
  it("counts non-Latin characters with the same weights as publishing", () => {
    expect(xLength("界".repeat(141))).toBe(282);
  });
  it("counts any URL as 23, the way X does", () => {
    expect(xLength("hello")).toBe(5);
    expect(xLength("see https://www.upcar.ai/host/become-host?utm=1")).toBe(4 + 23);
    expect(xLength("see upcar.ai/host")).toBe(4 + 23);
  });
});
