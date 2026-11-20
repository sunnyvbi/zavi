import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const rows: Row[] = [];
let failRead = false;
let autopilot = true;
let budget: object | null = { left_usd: 100 };

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      let out = rows.filter((r) => r.table === table && r.tenant_id === tid);
      const b = {
        select: () => b,
        eq(c: string, v: unknown) {
          out = out.filter((r) => r[c] === v);
          return b;
        },
        maybeSingle: async () => (failRead ? { data: null, error: { message: "tenant_channels down" } } : { data: out[0] ?? null, error: null }),
      };
      return b;
    },
  }),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => autopilot }));
vi.mock("../cgo-ads", async (orig) => ({ ...((await orig()) as object), cgoAdBudget: async () => budget }));
vi.mock("../open-advice", () => ({ readOpenCards: async () => [], refsOfRow: () => ({ ids: [], names: [] }), textNamesCard: () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { authorizeUnattended, evaluateUnattended, heldReasonWords } from "../unattended-policy";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const run = (target: string) => authorizeUnattended(T, { kind: "dispatch_specialist", target, intent: "draft three posts", origin_action_id: null }, { where: "executor" });
const sw = (tenant_id: string, channel_slug: string, autorun: boolean) => rows.push({ table: "tenant_channels", tenant_id, channel_slug, autorun });

beforeEach(() => {
  rows.length = 0;
  failRead = false;
  autopilot = true;
  budget = { left_usd: 100 };
});

describe("the switch, pure", () => {
  const d = { kind: "dispatch_specialist" as const, target: "x_organic", intent: "x" };
  it("on: allow; off: the founder's; unreadable: the founder's; not a channel: no rule", () => {
    expect(evaluateUnattended(d, { targetAllowed: true, channelAutorun: true }).verdict).toBe("allow");
    expect(evaluateUnattended(d, { targetAllowed: true, channelAutorun: false })).toEqual({ verdict: "ask_founder", reasons: ["channel_asks_first"] });
    expect(evaluateUnattended(d, { targetAllowed: true, channelAutorun: null })).toEqual({ verdict: "ask_founder", reasons: ["autorun_unreadable"] });
    expect(evaluateUnattended({ ...d, target: "research" }, { targetAllowed: true }).verdict).toBe("allow");
  });
  it("has plain words for the founder", () => {
    expect(heldReasonWords(["channel_asks_first"])).toEqual(["you set this channel to ask you first"]);
  });
});

describe("the switch, read live", () => {
  const ON = "2026-10-12T09:00:00.000Z";
  const BEFORE = "2026-10-11T09:00:00.000Z";
  const AFTER = "2026-10-12T10:00:00.000Z";
  const onAt = (tenant_id: string, on_at: string | null) => rows.push({ table: "cgo_autopilot_state", tenant_id, on_at });
  const askFirst = (tenant_id: string, channel_slug: string, autorun_set_at: string | null) =>
    rows.push({ table: "tenant_channels", tenant_id, channel_slug, autorun: false, autorun_set_by: "founder", autorun_set_at });

  it("Autopilot on, no row at all: cgo may run it", async () => {
    onAt(T, ON);
    expect((await run("x_organic")).verdict).toBe("allow");
  });

  it("Autopilot on, a plan-written off: cgo may run it (nothing a model writes asks first)", async () => {
    onAt(T, ON);
    rows.push({ table: "tenant_channels", tenant_id: T, channel_slug: "x_organic", autorun: false, autorun_set_by: "plan" });
    expect((await run("x_organic")).verdict).toBe("allow");
  });

  it("the founder set it to ask first AFTER the latest ON: left for the founder", async () => {
    onAt(T, ON);
    askFirst(T, "x_organic", AFTER);
    sw(OTHER, "x_organic", true);
    expect(await run("x_organic")).toEqual({ verdict: "ask_founder", reasons: ["channel_asks_first"] });
  });

  it("a founder off from BEFORE the latest ON (or unstamped, from before this existed) no longer counts", async () => {
    onAt(T, ON);
    askFirst(T, "x_organic", BEFORE);
    expect((await run("x_organic")).verdict).toBe("allow");
    rows.length = 0;
    onAt(T, ON);
    askFirst(T, "x_organic", null);
    expect((await run("x_organic")).verdict).toBe("allow");
  });

  it("turning Autopilot on again resets the ask-first", async () => {
    onAt(T, ON);
    askFirst(T, "x_organic", AFTER);
    expect((await run("x_organic")).verdict).toBe("ask_founder");
    (rows.find((r) => r.table === "cgo_autopilot_state") as Row).on_at = "2026-10-13T08:00:00.000Z";
    expect((await run("x_organic")).verdict).toBe("allow");
  });

  it("Autopilot off: never runs, whatever the switch says", async () => {
    sw(T, "x_organic", true);
    autopilot = false;
    expect((await run("x_organic")).verdict).toBe("deny");
  });

  it("an unreadable read fails closed", async () => {
    sw(T, "x_organic", true);
    failRead = true;
    expect(await run("x_organic")).toEqual({ verdict: "ask_founder", reasons: ["autorun_unreadable"] });
  });

  it("an ad channel under a budget: on under Autopilot, asks first when the founder said so", async () => {
    onAt(T, ON);
    expect((await run("meta_ads")).verdict).toBe("allow");
    askFirst(T, "meta_ads", AFTER);
    expect((await run("meta_ads")).reasons).toContain("channel_asks_first");
  });

  it("research needs no switch, but does need Autopilot still on (read live)", async () => {
    expect((await run("research")).verdict).toBe("allow");
    autopilot = false;
    expect((await run("research")).verdict).toBe("deny");
  });
});
