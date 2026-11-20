
import { describe, it, expect, vi } from "vitest";
import { listSocialTools, callSocialTool } from "../social";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("listSocialTools", () => {
  it("advertises exactly the three propose/read tools", () => {
    const tools = listSocialTools();
    expect(tools.map((t) => `${t.server_id}__${t.tool_name}`)).toEqual([
      "social__propose_post",
      "social__propose_standing_order",
      "social__list_posts",
      "social__linkedin_tracking_link",
    ]);
    for (const t of tools) expect(t.input_schema.type).toBe("object");
  });

  it("advertises NO publish tool — the facade grants may-ask, never may-post", () => {
    const names = listSocialTools().map((t) => t.tool_name);
    for (const n of names) {
      expect(n).not.toMatch(/^(publish|post|send|create_post)$/);
    }
    expect(listSocialTools().every(t => /^propose_/.test(t.tool_name) || t.effect === "read")).toBe(true);
  });

  it("the description says it stages and does NOT publish", () => {
    const [t] = listSocialTools();
    expect(t.description).toMatch(/Publishes NOTHING/);
    expect(t.description).toMatch(/approval/);
  });
});

describe("callSocialTool", () => {
  it("plumbs emit_decision through to the tool", async () => {
    const emit = vi.fn().mockResolvedValue("dec-9");
    const r = await callSocialTool({ tenant_id: TENANT, emit_decision: emit }, "propose_post", {
      channel: "linkedin",
      text: "hi",
      rationale: "r",
    });
    expect(r.ok).toBe(true);
    expect(emit).toHaveBeenCalledOnce();
    expect(JSON.parse(r.content)).toMatchObject({ decision_id: "dec-9", staged: true });
  });

  it("maps the tool's refusal to an is_error result the agent can read", async () => {
    const r = await callSocialTool({ tenant_id: TENANT }, "propose_post", {
      channel: "linkedin",
      text: "hi",
      rationale: "r",
    });
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content).error).toBe("social_propose_no_emit");
  });

  it("unknown tool → tool_unknown, never a throw", async () => {
    const r = await callSocialTool({ tenant_id: TENANT }, "publish_now", {});
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("tool_unknown");
  });
});
