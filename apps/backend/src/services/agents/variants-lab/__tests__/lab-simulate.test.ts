
import { describe, it, expect } from "vitest";
import { newLabReadCache, withLabReadCache } from "../lab-read-cache";
import { CREATIVE_UNGROUNDED_MESSAGE, isLabSimulatedTool, labSimulatedCall, noteLabToolCall, type LabSimulateDeps } from "../lab-simulate";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const inCase = <T>(fn: () => Promise<T>) => withLabReadCache(newLabReadCache(), fn);
const body = (r: { content: string } | null) => JSON.parse(r!.content) as Record<string, unknown>;
const deps: LabSimulateDeps = {
  brand: async () => ({ primary: "#027bff", accent: null, source: "scrape", source_url: "https://example.com", evidence: [] }),
  uuid: () => "00000000-0000-4000-8000-000000000001",
};
const post = (layout?: string) => ({ plate_prompt: "A parked sedan on a quiet street", headline: "Cars from $39/day", ...(layout ? { layout } : {}) });
const render = (run: string, args: unknown, d: LabSimulateDeps = deps) =>
  labSimulatedCall({ run_id: run, tenant_id: T }, "report", "render_social_image", args, d);
const brief = {
  title: "Refresh: Rent a car $35/day",
  angle: "Price-led, owner-rented",
  hook: "You are overpaying for a rental.",
  format: "9:16 UGC talking-head, 20-30s",
  rationale: "Click-through fell week over week on the one ad carrying this ad set.",
  evidence: [{ claim: "CTR 1.9% to 1.2%", source: "meta_ads__list_ads" }],
};

describe("lab stand-ins", () => {
  it("outside a lab case nothing is simulated", async () => {
    expect(isLabSimulatedTool("report", "render_social_image")).toBe(false);
    expect(await render("r1", { posts: [post()] })).toBeNull();
  });

  it("inside a lab case only the two listed tools are simulated", async () => {
    await inCase(async () => {
      expect(isLabSimulatedTool("report", "render_social_image")).toBe(true);
      expect(isLabSimulatedTool("growth", "propose_creative_brief")).toBe(true);
      expect(isLabSimulatedTool("meta_ads", "propose_budget_change")).toBe(false);
      expect(await labSimulatedCall({ run_id: "r1", tenant_id: T }, "meta_ads", "propose_budget_change", {})).toBeNull();
    });
  });

  it("render refuses once when the run has read nothing, with the real tool's words, then goes through", async () => {
    await inCase(async () => {
      const first = await render("run-a", { posts: [post("scrim")] });
      expect(first).toMatchObject({ ok: false, is_error: true });
      expect(body(first)).toEqual({ error: "creative_ungrounded", message: CREATIVE_UNGROUNDED_MESSAGE });
      expect(await render("run-a", { posts: [post("scrim")] })).toMatchObject({ ok: true, is_error: false });
    });
  });

  it("render after a real read: one image per post with a stageable path, the tenant's real brand source, and marked as a stand-in", async () => {
    await inCase(async () => {
      noteLabToolCall("run-b", "meta_ads", "list_ads");
      const b = body(await render("run-b", { posts: [post("block"), post("dark"), post()] }));
      expect(b).toMatchObject({ mode: "options", generated: 3, typeset: 0, cached: 0, skipped: [], lab_simulated: true });
      expect(b.brand).toMatchObject({ source: "scrape", primary: "#027bff" });
      const images = b.images as Array<{ filename: string; image_path: string }>;
      expect(images.map((i) => i.filename)).toEqual(["social-1-block.png", "social-2-dark.png", "social-3-block.png"]);
      expect(images[0].image_path).toBe(`${T}/00000000-0000-4000-8000-000000000001.jpg`);
    });
  });

  it("a carousel reports photographed panels as generated and type-only panels as typeset, like the real result", async () => {
    await inCase(async () => {
      noteLabToolCall("run-c", "meta_ads", "list_ads");
      const b = body(await render("run-c", { panels: [post(), { headline: "Step 2" }, { headline: "Step 3" }] }));
      expect(b).toMatchObject({ mode: "carousel", generated: 1, typeset: 2 });
      expect((b.images as unknown[]).length).toBe(3);
    });
  });

  it("an unreadable brand kit falls back to the default source, which the agent must disclose", async () => {
    await inCase(async () => {
      noteLabToolCall("run-d", "web_fetch", "fetch");
      const b = body(await render("run-d", { posts: [post()] }, { ...deps, brand: async () => { throw new Error("no site"); } }));
      expect(b.brand).toMatchObject({ source: "default" });
    });
  });

  it("input the real render schema rejects is rejected here, in the real envelope, and does not use up the one refusal", async () => {
    await inCase(async () => {
      const bad = await render("run-e", { posts: [{ headline: "no photograph prompt" }] });
      expect(bad).toMatchObject({ ok: false, is_error: true });
      expect(body(bad).error).toBe("invalid_input");
      expect(body(await render("run-e", { posts: [post()] })).error).toBe("creative_ungrounded");
    });
  });

  it("a report-family call does not count as having looked", async () => {
    await inCase(async () => {
      noteLabToolCall("run-f", "report", "render_pdf");
      expect(await render("run-f", { posts: [post()] })).toMatchObject({ is_error: true });
    });
  });

  it("the creative brief returns the fields the recipe asks the agent to report", async () => {
    await inCase(async () => {
      const b = body(await labSimulatedCall({ run_id: "run-g", tenant_id: T }, "growth", "propose_creative_brief", brief));
      expect(b).toMatchObject({ brief_id: "lab-brief", status: "draft", title: brief.title, lab_simulated: true });
      expect(b.utm_campaign).toBe("lab_refresh_rent_a_car_35_day");
      expect(String(b.next_step)).toContain("utm_campaign=lab_refresh_rent_a_car_35_day");
    });
  });

  it("a brief the real schema rejects (no evidence) comes back as tool_input_invalid, as in production", async () => {
    await inCase(async () => {
      const r = await labSimulatedCall({ run_id: "run-h", tenant_id: T }, "growth", "propose_creative_brief", { title: "x" });
      expect(r).toMatchObject({ ok: false, is_error: true });
      expect(body(r).error).toBe("tool_input_invalid");
    });
  });
});
