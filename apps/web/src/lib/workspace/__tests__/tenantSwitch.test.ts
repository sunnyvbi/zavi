// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

let status = 200;
vi.mock("@/lib/api", () => ({ apiFetch: async () => ({ ok: status < 400, status }) as Response }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: async () => {} }));
vi.mock("@/lib/ensure-tenant-claim", () => ({ refreshSessionUntilClaim: async () => true }));
vi.mock("@/lib/active-tenant-client", () => ({ clearActiveTenantCache: () => {} }));

import { switchToTenantDetailed } from "../tenantSwitch";

describe("switchToTenantDetailed", () => {
  it("only a 400 or 403 is a no-change refusal; a 500 may have changed something", async () => {
    for (const [code, want] of [[400, "refused"], [403, "refused"], [500, "not_converged"], [502, "not_converged"], [200, "ok"]] as const) {
      status = code;
      expect(await switchToTenantDetailed("B"), String(code)).toBe(want);
    }
  });
});
