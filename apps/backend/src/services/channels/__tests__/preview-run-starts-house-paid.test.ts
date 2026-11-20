import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q: Record<string, unknown> = {};
    for (const op of ["from", "select", "eq"]) q[op] = () => q;
    q.maybeSingle = async () => ({ data: h.row, error: null });
    return q;
  },
}));

import { isPreviewRunId } from "../preview-run-starts";
import { doneForYouKey, previewRunKey } from "@/services/billing/tiers";

const T = "11111111-1111-4111-8111-111111111111";
const run = (over: Record<string, unknown>) => ({ id: "r1", agent_slug: "instagram_organic", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: null, ...over });

describe("isPreviewRunId (house-paid media)", () => {
  it("a done-for-you run and a signup preview run are house-paid", async () => {
    h.row = run({ cron_dedupe_key: doneForYouKey(T, 2) });
    expect(await isPreviewRunId(T, "r1")).toBe(true);
    h.row = run({ cron_dedupe_key: previewRunKey(T, "instagram_organic") });
    expect(await isPreviewRunId(T, "r1")).toBe(true);
  });

  it("a plain channel run, a user-written run or another tenant's key is not", async () => {
    for (const over of [{}, { cron_dedupe_key: doneForYouKey(T, 1), enqueued_by: "u1" }, { cron_dedupe_key: doneForYouKey("22222222-2222-4222-8222-222222222222", 1) }, { cron_dedupe_key: doneForYouKey(T, 1), trigger: "chat" }]) {
      h.row = run(over);
      expect(await isPreviewRunId(T, "r1")).toBe(false);
    }
  });
});
