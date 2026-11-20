
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = { from: vi.fn() };

vi.mock("@/services/supabase", () => ({
  serviceClient: () => mockClient,
}));

const mockGetAgentDefaultState = vi.fn();
const mockListAgents = vi.fn();
const mockListAlwaysOnSlugs = vi.fn();
const mockListDefaultDisabledSlugs = vi.fn();

vi.mock("@/services/agents/registry", () => ({
  getAgentDefaultState: (...a: unknown[]) => mockGetAgentDefaultState(...a),
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  listAlwaysOnSlugs: (...a: unknown[]) => mockListAlwaysOnSlugs(...a),
  listDefaultDisabledSlugs: (...a: unknown[]) => mockListDefaultDisabledSlugs(...a),
}));

import { isAgentSchedulable } from "@/services/agents/visibility";

let tenantRows: Array<{ agent_slug: string; override_state: string; source: string }> = [];
let tenantReadError: { message: string } | null = null;
let globalHide: string[] = [];
let globalReadError: { message: string } | null = null;

function wireClient() {
  mockClient.from.mockImplementation((table: string) => {
    if (table === "tenant_agent_kill_switch") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: tenantReadError ? null : tenantRows, error: tenantReadError });
      return chain;
    }
    if (table === "system_config") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: globalReadError ? null : { blob: { disabled_agent_slugs: globalHide } },
              error: globalReadError,
            }),
          }),
        }),
      };
    }
    return {};
  });
}

beforeEach(() => {
  mockClient.from.mockReset();
  mockGetAgentDefaultState.mockReset();
  mockListAgents.mockReset();
  mockListAlwaysOnSlugs.mockReset();
  mockListDefaultDisabledSlugs.mockReset();
  tenantRows = [];
  tenantReadError = null;
  globalHide = [];
  globalReadError = null;
  mockListAlwaysOnSlugs.mockReturnValue([]);
  mockListDefaultDisabledSlugs.mockReturnValue([]);
  mockListAgents.mockReturnValue([
    { slug: "operator" },
    { slug: "pm" },
    { slug: "engineer" },
  ]);
  wireClient();
});

describe("isAgentSchedulable — precedence (happy paths)", () => {
  it("default-enabled known agent with no overrides → schedulable", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    expect(await isAgentSchedulable("t-1", "operator")).toBe(true);
  });

  it("always_on → schedulable even if global-hidden", async () => {
    mockGetAgentDefaultState.mockReturnValue("always_on");
    globalHide = ["operator"];
    expect(await isAgentSchedulable("t-1", "operator")).toBe(true);
  });

  it("tenant hidden-override → NOT schedulable", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    tenantRows = [{ agent_slug: "operator", override_state: "hidden", source: "staff" }];
    expect(await isAgentSchedulable("t-1", "operator")).toBe(false);
  });

  it("tenant visible-override beats global hide → schedulable", async () => {
    mockGetAgentDefaultState.mockReturnValue("disabled");
    tenantRows = [{ agent_slug: "operator", override_state: "visible", source: "tenant" }];
    globalHide = ["operator"];
    expect(await isAgentSchedulable("t-1", "operator")).toBe(true);
  });

  it("global-hidden (no tenant override) → NOT schedulable", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    globalHide = ["operator"];
    expect(await isAgentSchedulable("t-1", "operator")).toBe(false);
  });

  it("default-disabled (no overrides) → schedulable (default_state no longer hides)", async () => {
    mockGetAgentDefaultState.mockReturnValue("disabled");
    expect(await isAgentSchedulable("t-1", "operator")).toBe(true);
  });

  it("UNKNOWN slug (not in registry) → NOT schedulable, no DB read needed", async () => {
    expect(await isAgentSchedulable("t-1", "ban-everyone")).toBe(false);
  });
});

describe("isAgentSchedulable — FAIL-CLOSED on read error (the trust property)", () => {
  it("tenant-override read error PROPAGATES (caller fails closed)", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    tenantReadError = { message: "tenant read down" };
    await expect(isAgentSchedulable("t-1", "operator")).rejects.toThrow(/tenant read down/);
  });

  it("global-override read error PROPAGATES (caller fails closed)", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    globalReadError = { message: "global read down" };
    await expect(isAgentSchedulable("t-1", "operator")).rejects.toThrow(/global read down/);
  });

  it("throws when tenantId missing", async () => {
    await expect(isAgentSchedulable("", "operator")).rejects.toThrow(/tenantId required/);
  });

  it("throws when slug missing", async () => {
    await expect(isAgentSchedulable("t-1", "")).rejects.toThrow(/slug required/);
  });
});
