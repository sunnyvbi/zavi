import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => ({
  alreadySent: false,
  runs: [] as Array<{ id?: string; agent_slug: string; status: string; preview_action_types: string[] | null }>,
  open: [] as Array<{ run_id: string | null }>,
  openRunFilter: null as unknown,
  included: new Set<string>(),
  sent: [] as Array<Record<string, unknown>>,
  sendResult: { sent: true },
  flags: [] as unknown[],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const rows = table === "agent_runs" ? h.runs : table === "customer_visible_open_channel_actions" ? h.open : [{ name: "Acme Bikes" }];
      const chain = {
        select: () => chain,
        like: () => chain,
        in: (_c: string, v: unknown) => {
          h.openRunFilter = v;
          return chain;
        },
        not: () => chain,
        eq: () => chain,
        limit: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => h.alreadySent,
  claimTenantFlag: async (...args: unknown[]) => {
    if (h.alreadySent) return false;
    h.alreadySent = true;
    h.flags.push(args);
    return true;
  },
  setTenantSetting: async (...args: unknown[]) => {
    if (args[2] === null) h.alreadySent = false;
    h.flags.push(args);
  },
}));
vi.mock("../preview-plan", () => ({
  planIncludesChannel: async (_t: string, slug: string) => h.included.has(slug),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendPreviewReadyEmail: async (args: Record<string, unknown>) => {
    h.sent.push(args);
    return h.sendResult;
  },
}));
vi.mock("@/services/web-base", () => ({
  webBaseUrl: () => "https://www.zaviagent.com",
  channelUrl: (slug: string) => `https://www.zaviagent.com/workspace?tab=channels&channel=${slug}`,
}));

import { maybeSendPreviewReadyEmail } from "../preview-ready-email";

beforeEach(() => {
  h.alreadySent = false;
  h.included = new Set();
  h.runs = [
    { agent_slug: "seo", status: "success", preview_action_types: ["fix", "page"] },
    { agent_slug: "reddit_organic", status: "success", preview_action_types: ["reply"] },
    { agent_slug: "geo", status: "failed", preview_action_types: [] },
  ];
  h.sent = [];
  h.sendResult = { sent: true };
  h.flags = [];
  h.open = [];
  h.openRunFilter = null;
});

describe("preview-ready email: keep-cards round (real cards, no stored types)", () => {
  beforeEach(() => {
    h.runs = [
      { id: "r-seo", agent_slug: "seo", status: "success", preview_action_types: null },
      { id: "r-reddit", agent_slug: "reddit_organic", status: "success", preview_action_types: null },
    ];
  });

  it("counts the open cards of these preview runs and says they can be read now", async () => {
    h.open = [{ run_id: "r-seo" }, { run_id: "r-seo" }, { run_id: "r-reddit" }, { run_id: "someone-else" }];
    const out = await maybeSendPreviewReadyEmail(T);
    expect(out).toEqual({ sent: true, total: 3 });
    expect(h.openRunFilter).toEqual(["r-seo", "r-reddit"]);
    expect(h.sent[0]).toMatchObject({ total: 3, realCards: 3 });
    expect(h.sent[0]!.channelsUrl).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=seo");
  });

  it("a mixed round (keep-cards flipped while runs were queued) counts the dry types AND the real cards", async () => {
    h.runs = [
      { id: "r-dry", agent_slug: "reddit_organic", status: "success", preview_action_types: ["post", "comment"] },
      { id: "r-seo", agent_slug: "seo", status: "success", preview_action_types: null },
    ];
    h.open = [{ run_id: "r-seo" }, { run_id: "r-seo" }, { run_id: "r-seo" }];
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: true, total: 5 });
    expect(h.openRunFilter).toEqual(["r-seo"]);
    expect(h.sent[0]).toMatchObject({ total: 5, realCards: 3 });
    expect(h.sent[0]!.channelsUrl).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=seo");
  });

  it("sends nothing when the round left no open card", async () => {
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "nothing_found" });
    expect(h.sent).toHaveLength(0);
  });
});

describe("preview-ready email", () => {
  it("sends once every dry preview is done, counting their stored types", async () => {
    const out = await maybeSendPreviewReadyEmail(T);
    expect(out).toEqual({ sent: true, total: 3 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ total: 3, planName: "Starter" });
    expect(h.sent[0]!.channelNames).toHaveLength(2);
    expect(h.sent[0]!.channelsUrl).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=seo");
    expect(h.flags).toHaveLength(1);
  });

  it("waits while any preview run is still going", async () => {
    h.runs[0]!.status = "running";
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "still_running" });
  });

  it("stays quiet when the tenant already upgraded or nothing was found", async () => {
    h.included = new Set(["seo"]);
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "nothing_locked" });
    h.included = new Set();
    h.runs = h.runs.map((r) => ({ ...r, preview_action_types: [] }));
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "nothing_found" });
  });

  it("waits for a sibling still queued (not yet marked dry)", async () => {
    h.runs.push({ agent_slug: "x_organic", status: "queued", preview_action_types: null });
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "still_running" });
  });

  it("a preview that failed before it was marked dry does not hold the email back", async () => {
    h.runs.push({ agent_slug: "x_organic", status: "failed", preview_action_types: null });
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: true, total: 3 });
  });

  it("a round that kept its cards sends nothing: its runs stored no types", async () => {
    h.runs = [
      { agent_slug: "seo", status: "success", preview_action_types: null },
      { agent_slug: "reddit_organic", status: "success", preview_action_types: null },
      { agent_slug: "geo", status: "failed", preview_action_types: null },
    ];
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "nothing_found" });
    expect(h.sent).toHaveLength(0);
    expect(h.flags).toHaveLength(0);
  });

  it("gives the claim back when there was no address to send to", async () => {
    h.sendResult = { sent: false };
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "no_owner_email" });
    expect(h.alreadySent).toBe(false);
  });

  it("is sent once", async () => {
    h.alreadySent = true;
    expect(await maybeSendPreviewReadyEmail(T)).toEqual({ sent: false, reason: "already_sent" });
  });
});

describe("preview-ready email copy", () => {
  it("a keep-cards round says the cards can be read now; a dry round keeps the upgrade line", async () => {
    const { renderPreviewReadyEmail } = await import("@/email/templates/preview-ready");
    const base = { displayName: "Acme", total: 3, channelNames: ["SEO"], planName: "Starter", planUsd: 20, channelsUrl: "https://x.test" };
    const real = renderPreviewReadyEmail({ ...base, realCards: 3 });
    expect(real.text).toContain("Read and copy them now.");
    expect(real.html).toContain("Read and copy them now.");
    expect(real.text).not.toContain("with every action written out");
    expect(renderPreviewReadyEmail(base).text).toContain("with every action written out");
    const mixed = renderPreviewReadyEmail({ ...base, total: 5, realCards: 3 });
    expect(mixed.text).toContain("3 of them are ready to read and copy now.");
    expect(mixed.text).not.toContain("Read and copy them now.");
  });
});
