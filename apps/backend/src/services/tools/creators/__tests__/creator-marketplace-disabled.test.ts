import { describe, expect, it, vi } from "vitest";

vi.mock("@zavi/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zavi/shared")>()),
  CREATOR_MARKETPLACE_ENABLED: false,
}));

import { callCreatorTool, listCreatorTools } from "../facade";

describe("creator marketplace disabled", () => {
  it("does not advertise creator communication or hiring tools", () => {
    expect(listCreatorTools()).toEqual([]);
  });

  it("refuses a direct tool call before it reaches marketplace services", async () => {
    const out = await callCreatorTool(
      { tenant_id: "11111111-1111-1111-1111-111111111111", run_id: "22222222-2222-2222-2222-222222222222" },
      "book_package",
      { package_id: "6e2a9c1d-4b7f-4a3e-8c5d-2f1b9e7a3c84" },
    );
    expect(out.is_error).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: "tool_unknown" });
  });
});
