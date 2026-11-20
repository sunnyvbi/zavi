import { describe, it, expect, vi, beforeEach } from "vitest";

const { create, resolveRoleModel } = vi.hoisted(() => ({
  create: vi.fn(),
  resolveRoleModel: vi.fn(),
}));

vi.mock("@/services/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/anthropic")>();
  return { ...actual, getAnthropic: () => ({ messages: { create } }) };
});
vi.mock("@/services/llm/resolve-role-model", () => ({ resolveRoleModel }));

import { synthMarkdown } from "@/services/llm/synthMarkdown";
import { DEFAULT_MODEL } from "@/services/anthropic";

const HAIKU = "claude-haiku-4-5-20251001";

function textResp(text: string) {
  return { content: [{ type: "text" as const, text }], usage: { input_tokens: 10, output_tokens: 20 } };
}

beforeEach(() => {
  create.mockReset();
  resolveRoleModel.mockReset();
});

describe("synthMarkdown model resolution + fallback", () => {
  it("honors an explicit model and does not consult resolveRoleModel", async () => {
    create.mockResolvedValue(textResp("# hi"));
    const out = await synthMarkdown({ system_prompt: "s", user_prompt: "u", model: HAIKU });
    expect(out.model).toBe(HAIKU);
    expect(resolveRoleModel).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: HAIKU }),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("resolves the role override (with tenant_id) when no explicit model", async () => {
    resolveRoleModel.mockResolvedValue(HAIKU);
    create.mockResolvedValue(textResp("# hi"));
    const out = await synthMarkdown({ role: "synthMarkdown", tenant_id: "t1", system_prompt: "s", user_prompt: "u" });
    expect(resolveRoleModel).toHaveBeenCalledWith("synthMarkdown", DEFAULT_MODEL, "t1");
    expect(out.model).toBe(HAIKU);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: HAIKU }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Helicone-Property-Tenant-Id": "t1",
          "Helicone-Property-Agent-Slug": "synthMarkdown",
        }),
      }),
    );
  });

  it("uses DEFAULT_MODEL when neither model nor role is given", async () => {
    create.mockResolvedValue(textResp("# hi"));
    const out = await synthMarkdown({ system_prompt: "s", user_prompt: "u" });
    expect(out.model).toBe(DEFAULT_MODEL);
    expect(resolveRoleModel).not.toHaveBeenCalled();
  });

  it("retries once on DEFAULT_MODEL when an override model fails at runtime", async () => {
    resolveRoleModel.mockResolvedValue(HAIKU);
    create.mockRejectedValueOnce(new Error("503 overloaded")).mockResolvedValueOnce(textResp("# recovered"));
    const out = await synthMarkdown({ role: "synthMarkdown", system_prompt: "s", user_prompt: "u" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe(HAIKU);
    expect(create.mock.calls[1][0].model).toBe(DEFAULT_MODEL);
    expect(out.model).toBe(DEFAULT_MODEL);
    expect(out.markdown).toBe("# recovered");
  });

  it("does NOT retry (re-throws) when the model in use is already DEFAULT_MODEL", async () => {
    resolveRoleModel.mockResolvedValue(DEFAULT_MODEL);
    create.mockRejectedValue(new Error("503 overloaded"));
    await expect(
      synthMarkdown({ role: "synthMarkdown", system_prompt: "s", user_prompt: "u" }),
    ).rejects.toThrow("503 overloaded");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("throws (does NOT fall back) on an explicit unknown model — caller bug stays loud", async () => {
    create.mockResolvedValue(textResp("# should-not-run"));
    await expect(
      synthMarkdown({ system_prompt: "s", user_prompt: "u", model: "claude-imaginary-9000" }),
    ).rejects.toThrow(/unknown model id.*claude-imaginary-9000/);
    expect(create).not.toHaveBeenCalled();
  });
});
