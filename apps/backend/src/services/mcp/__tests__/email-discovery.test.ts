import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";

beforeEach(() => {
  _clearToolCacheForTests();
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
          }),
        }),
      }),
    }),
  });
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  });
});

describe("email__send is discoverable via platform-internal server", () => {
  it("agent declaring email__send resolves to a usable tool, not a console warning", async () => {
    const res = await discoverToolsForTenant("t-1", ["email__send"]);
    const emailTool = res.tools.find((t) => t.name === "email__send");
    expect(emailTool).toBeDefined();
    expect(emailTool?.server_id).toBe("email");
    expect(res.disconnected_connectors).not.toContain("email");
  });
});

describe("source-file structural guards", () => {

  it("discovery.ts registers email as platform-internal + has listToolsForServer branch", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../discovery.ts"),
      "utf-8",
    );
    expect(src).toMatch(/server_id:\s*"email".*enabled:\s*true/);
    expect(src).toContain('server.server_id === "email"');
    expect(src).toContain("listEmailTools()");
  });
});
