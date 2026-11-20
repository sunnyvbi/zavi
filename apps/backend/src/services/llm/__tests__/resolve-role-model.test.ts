import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSetting } = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("@/services/settings", () => ({ getSetting }));

import { resolveRoleModel } from "@/services/llm/resolve-role-model";

const DEFAULT = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5-20251001";

beforeEach(() => {
  getSetting.mockReset();
});

describe("resolveRoleModel", () => {
  it("returns the override when it is a valid PRICING key", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: HAIKU });
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(HAIKU);
  });

  it("returns the default when no override map entry exists", async () => {
    getSetting.mockResolvedValue({});
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("ignores an override that is not a known PRICING key (typo/stale → default)", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: "gpt-4o-mini" });
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("ignores a prototype key (e.g. 'toString') as an override value", async () => {
    getSetting.mockResolvedValue({ synthMarkdown: "toString" });
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("only matches the requested role, not a different overridden role", async () => {
    getSetting.mockResolvedValue({ someOtherRole: HAIKU });
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });

  it("passes tenant_id through to getSetting (per-tenant scope)", async () => {
    getSetting.mockResolvedValue({});
    await resolveRoleModel("synthMarkdown", DEFAULT, "tenant-123");
    expect(getSetting).toHaveBeenCalledWith("llm_role_model_overrides", "tenant-123");
  });

  it("falls back to default when getSetting returns null", async () => {
    getSetting.mockResolvedValue(null);
    expect(await resolveRoleModel("synthMarkdown", DEFAULT)).toBe(DEFAULT);
  });
});
