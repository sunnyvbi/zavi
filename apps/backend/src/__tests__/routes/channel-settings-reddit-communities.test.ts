import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/tenant-client", () => ({
  tenantRpc: vi.fn(async (_tenant: string, fn: string, args: Record<string, unknown>) => {
    h.calls.push({ fn, args });
    return { data: { ok: true, written: 0, deleted: 0, dropped: 0, fields: {} }, error: null };
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "jwt" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn().mockResolvedValue(true) }));

import { channelSettingsPut } from "../../routes/channels/settings";
import { buildSweepJobs } from "@/services/channels/reddit/sweep";

function mkRes() {
  let code = 200;
  let payload: unknown = null;
  const res = {
    status(c: number) {
      code = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => code, body: () => payload as { error?: { code?: string } } };
}

async function put(slug: string, fieldId: string, items: unknown[]) {
  const r = mkRes();
  await channelSettingsPut({ params: { slug, fieldId }, body: { items } } as unknown as Request, r.res);
  return r;
}

const sentItems = () =>
  (h.calls.at(-1)?.args.p_items as Array<{ item: string; status: string | null }>) ?? [];

describe("reddit communities saved from the Settings tab", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it("stores the bare name for r/ and URL forms, so the sweep builds a job for every one", async () => {
    const r = await put("reddit_organic", "communities", [
      { item: "r/SaaS", status: "tracking" },
      { item: "https://www.reddit.com/r/startups/top/?t=week", status: "tracking" },
      "/r/smallbusiness/",
    ]);

    expect(r.status()).toBe(200);
    expect(sentItems().map((i) => i.item)).toEqual(["SaaS", "startups", "smallbusiness"]);

    const ws = {
      keywords: [],
      competitors: [],
      communities: sentItems().map((i, n) => ({
        id: `c${n}`,
        name: i.item,
        selected: true,
        rules_verdict: null,
        rules_verdict_at: null,
      })),
    };
    expect(buildSweepJobs(ws, 12).map((j) => j.key)).toEqual(["sub:saas", "sub:startups", "sub:smallbusiness"]);
  });

  it("collapses two spellings of one subreddit into the first one", async () => {
    await put("reddit_organic", "communities", [
      { item: "SaaS", status: "tracking" },
      { item: "r/saas", status: "paused" },
    ]);
    expect(sentItems()).toEqual([expect.objectContaining({ item: "SaaS", status: "tracking" })]);
  });

  it("refuses a name that is not a subreddit and writes nothing", async () => {
    const r = await put("reddit_organic", "communities", [{ item: "SaaS" }, { item: "small business!" }]);
    expect(r.status()).toBe(400);
    expect(r.body().error?.code).toBe("invalid_subreddit");
    expect(h.calls).toHaveLength(0);
  });

  it("leaves other reddit fields and other channels untouched", async () => {
    await put("reddit_organic", "keywords", [{ item: "r/SaaS", status: "tracking" }]);
    expect(sentItems()[0].item).toBe("r/SaaS");
    await put("x_organic", "communities", [{ item: "r/SaaS" }]);
    expect(sentItems()[0].item).toBe("r/SaaS");
  });
});
