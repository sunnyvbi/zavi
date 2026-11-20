import { describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({ value: null as null | { tenant_id: string; cron_dedupe_key: string | null } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const c = {
        select: () => c,
        eq: () => c,
        maybeSingle: async () => ({ data: row.value, error: null }),
      };
      return c;
    },
  }),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock("@/services/growth/preview-upgrade", () => ({
  PREVIEW_DONE_KEY_PREFIX: "first-run-preview-done:",
  rerunPreviewsOnUpgrade: vi.fn(),
}));

import { tenantOfPreviewRun } from "../preview-upgrade-rerun";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("tenantOfPreviewRun", () => {
  it("returns the run's own tenant for a preview-key run", async () => {
    row.value = { tenant_id: T, cron_dedupe_key: `first-run-preview:${T}:seo` };
    expect(await tenantOfPreviewRun("r1")).toBe(T);
    row.value = { tenant_id: T, cron_dedupe_key: `first-run-preview-done:${T}:seo` };
    expect(await tenantOfPreviewRun("r1")).toBe(T);
  });

  it("refuses a run that is not a preview run, or whose key names another tenant", async () => {
    row.value = { tenant_id: T, cron_dedupe_key: null };
    expect(await tenantOfPreviewRun("r1")).toBeNull();
    row.value = { tenant_id: T, cron_dedupe_key: `first-run-preview:${OTHER}:seo` };
    expect(await tenantOfPreviewRun("r1")).toBeNull();
    row.value = null;
    expect(await tenantOfPreviewRun("missing")).toBeNull();
  });
});
