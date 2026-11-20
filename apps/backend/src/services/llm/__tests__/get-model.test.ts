import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSetting } = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("@/services/settings", () => ({ getSetting }));

import { getModel } from "@/services/llm/resolve-role-model";

const DEFAULT = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5-20251001";
const OPENAI = "gpt-5.5";

beforeEach(() => {
  getSetting.mockReset();
});

describe("getModel", () => {
  it("no override → defaultModel", async () => {
    getSetting.mockResolvedValue({});
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("valid anthropic override → that id", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: HAIKU });
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(HAIKU);
  });

  it("valid openai override → that id (cross-vendor accepted)", async () => {
    getSetting.mockResolvedValue({ pm_critic: OPENAI });
    expect(await getModel("anthropic", "pm_critic", DEFAULT)).toBe(OPENAI);
  });

  it("unknown/typo override → defaultModel (fail-safe)", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: "gpt-4o-mini-typo" });
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("prototype-key value (e.g. 'toString') is ignored → defaultModel", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: "toString" });
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("null override map → defaultModel", async () => {
    getSetting.mockResolvedValue(null);
    expect(await getModel("openai", "pm_critic", DEFAULT)).toBe(DEFAULT);
  });

  it("getSetting throws → defaultModel (never throws)", async () => {
    getSetting.mockRejectedValue(new Error("db down"));
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("only matches the requested role, not a different overridden role", async () => {
    getSetting.mockResolvedValue({ someOtherRole: HAIKU });
    expect(await getModel("anthropic", "synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("passes tenant_id through to getSetting (per-tenant scope)", async () => {
    getSetting.mockResolvedValue({});
    await getModel("anthropic", "synthMarkdown", DEFAULT, "tenant-xyz");
    expect(getSetting).toHaveBeenCalledWith("llm_role_model_overrides", "tenant-xyz");
  });

  it("accepts an arbitrary string role (not in the Role union)", async () => {
    getSetting.mockResolvedValue({ brand_new_role: HAIKU });
    expect(await getModel("anthropic", "brand_new_role", DEFAULT)).toBe(HAIKU);
  });
});
