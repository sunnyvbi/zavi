
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshSession = vi.fn();
const getSession = vi.fn();
const writeStoredTenant = vi.fn();
const markSetupExpected = vi.fn();

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { getSession, refreshSession } }),
}));
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: (...a: unknown[]) => writeStoredTenant(...a) }));
vi.mock("@/lib/ensure-tenant-claim", () => ({ decodeActiveTenantClaim: () => "t-new" }));
vi.mock("@/components/workspace/setup/setupState", () => ({ markSetupExpected: () => markSetupExpected() }));

import { goToWorkspaceWithFreshClaim } from "./workspaceHandoff";

const replace = vi.fn();
function onPage(search: string) {
  vi.stubGlobal("window", { location: { search, replace } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session: { access_token: "old" } } });
  refreshSession.mockResolvedValue({ data: { session: { access_token: "new" } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("goToWorkspaceWithFreshClaim", () => {
  it("returns to the approval screen after refreshing the session", async () => {
    onPage(`?website=acme.com&next=${encodeURIComponent("/oauth/consent?req=eyJ.sig")}`);
    await goToWorkspaceWithFreshClaim("t-new", "/workspace?tab=autopilot&setupStep=connect-apps");
    expect(writeStoredTenant).toHaveBeenCalledWith(expect.anything(), "t-new");
    expect(replace).toHaveBeenCalledWith("/oauth/consent?req=eyJ.sig");
    expect(writeStoredTenant.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0]);
  });

  it("returns a new signup to the preserved Shopify install claim", async () => {
    onPage(`?next=${encodeURIComponent("/connectors/shopify/install?token=opaque.signed")}`);
    await goToWorkspaceWithFreshClaim("t-new", "/workspace?tab=autopilot&setupStep=your-business");
    expect(writeStoredTenant).toHaveBeenCalledWith(expect.anything(), "t-new");
    expect(replace).toHaveBeenCalledWith("/connectors/shopify/install?token=opaque.signed");
  });

  it("goes to the caller's destination when next is anything else", async () => {
    onPage(`?next=${encodeURIComponent("https://evil.com/oauth/consent?req=x")}`);
    await goToWorkspaceWithFreshClaim("t-new", "/workspace?tab=autopilot");
    expect(replace).toHaveBeenCalledWith("/workspace?tab=autopilot");
  });

  it("goes to the caller's destination when there is no next", async () => {
    onPage("?website=acme.com");
    await goToWorkspaceWithFreshClaim("t-new", "/workspace?tab=autopilot");
    expect(replace).toHaveBeenCalledWith("/workspace?tab=autopilot");
  });

  it("sends an opened tab (billing) to the caller's destination, never the approval screen", async () => {
    onPage(`?next=${encodeURIComponent("/oauth/consent?req=eyJ.sig")}`);
    const tab = { location: { href: "" } } as unknown as Window;
    await goToWorkspaceWithFreshClaim("t-new", "/settings/billing", tab);
    expect(tab.location.href).toBe("/settings/billing");
    expect(replace).not.toHaveBeenCalled();
  });
});
