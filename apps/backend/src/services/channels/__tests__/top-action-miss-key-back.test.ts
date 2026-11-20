import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ runs: [] as unknown[] }));
const conn = vi.hoisted(() => ({ caller: null as null | ((t: string, tool: string) => Promise<unknown>) }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "in", "gt"]) q[m] = () => q;
    q.limit = async () => ({ data: db.runs, error: null });
    return {
      from: (table: string) => {
        if (table !== "agent_runs") {
          const none: Record<string, unknown> = { select: () => none, in: () => none, gt: () => none, eq: () => none, limit: async () => ({ data: [], error: null }), then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }) };
          return none;
        }
        return q;
      },
    };
  },
}));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));
vi.mock("@/services/email-test-lists/lists", async (actual) => ({
  ...(await actual<typeof import("@/services/email-test-lists/lists")>()),
  liveToolCaller: (t: string, tool: string) => conn.caller!(t, tool),
}));
vi.mock("@/services/email-plan/preflight", () => ({ emailRunPreflight: async () => ({ verdict: "ok" }) }));

import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { forgetEmailToolKeys } from "../email-tool-key";
import { readTopActionMiss } from "../top-action-miss";
import { TOP_ACTIONS } from "../top-actions";

const NOW = Date.parse("2026-10-23T10:05:00Z");
const MIN = 60_000;
const DEAD = "SG.deadKey";
const run = (over: Record<string, unknown> = {}) => ({
  id: "1caaac04-1111-4000-8000-000000000000",
  status: "success",
  payload: { channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs: { route: "sendgrid", list_id: "list-1", brief: "Announce the spring sale" } } },
  tool_calls: [{ name: "email__propose_campaign", status: "tool_error", code: "tool_key_rejected" }],
  finished_at: "2026-10-23T10:00:51Z",
  ...over,
});

let f: FakeSendgrid;
let vendor: number;
let saved: string;

const connect = () => {
  conn.caller = async () => {
    const call = sendgridHttpCall(saved, f.fetch);
    return async (slug: string, args: unknown) => {
      vendor += 1;
      return (call as (s: string, a: unknown) => Promise<unknown>)(slug, args);
    };
  };
};

beforeEach(() => {
  forgetEmailToolKeys();
  f = fakeSendgrid();
  vendor = 0;
  saved = DEAD;
  db.runs = [run()];
  connect();
});
afterEach(() => {
  vi.useRealTimers();
});

const miss = (at: number = NOW, tenant = "t1") => readTopActionMiss(tenant, "u1", "email_marketing", at);

describe("the 'rejected the key' notice after a reconnect", () => {
  it("stays while the key is dead, and five polls in a minute make one vendor call", async () => {
    for (let i = 0; i < 5; i += 1) expect((await miss(NOW + i * 10_000))?.reason).toMatch(/rejected the key/);
    expect(vendor).toBe(1);
  });

  it("clears once the key works again, on the first read after the cached answer ages out", async () => {
    expect(await miss()).not.toBeNull();
    saved = BRIGHTLOOP_KEY;
    expect(await miss(NOW + MIN - 1)).not.toBeNull();
    expect(await miss(NOW + MIN)).toBeNull();
    expect(vendor).toBe(2);
  });

  it("clears straight away when the key already works on the first read", async () => {
    saved = BRIGHTLOOP_KEY;
    expect(await miss()).toBeNull();
  });

  it("stays when the tool is not connected at all: the words are still true", async () => {
    conn.caller = async () => null;
    expect((await miss())?.reason).toMatch(/rejected the key/);
  });

  it("stays when the check itself fails or says nothing about the key", async () => {
    conn.caller = async () => {
      throw new Error("vault down");
    };
    expect(await miss()).not.toBeNull();
    forgetEmailToolKeys();
    conn.caller = async () => async () => ({ ok: false, status: 503, error: "busy" });
    expect(await miss()).not.toBeNull();
  });

  it("a hung tool does not hold the page: the poll answers with the notice, and a later poll sees the result", async () => {
    vi.useFakeTimers();
    let finish!: (v: unknown) => void;
    conn.caller = () => new Promise((done) => { finish = done; });
    const first = miss();
    await vi.advanceTimersByTimeAsync(2_600);
    expect(await first).not.toBeNull();
    saved = BRIGHTLOOP_KEY;
    finish(sendgridHttpCall(saved, f.fetch));
    await vi.advanceTimersByTimeAsync(10);
    expect(await miss(NOW + 1_000)).toBeNull();
  });

  it("one workspace's working key never clears another's notice", async () => {
    saved = BRIGHTLOOP_KEY;
    expect(await miss(NOW, "t-good")).toBeNull();
    saved = DEAD;
    expect((await miss(NOW, "t-bad"))?.reason).toMatch(/rejected the key/);
  });

  it("any other refusal, or a stopped run, never calls the tool", async () => {
    db.runs = [run({ tool_calls: [{ name: "email__propose_campaign", status: "tool_error", code: "email_audience_empty" }] })];
    expect((await miss())?.reason).toMatch(/nobody on it/);
    db.runs = [run({ status: "error" })];
    expect((await miss())?.reason).toMatch(/stopped before/);
    expect(vendor).toBe(0);
  });

  it("a healthy key does not clear a different refusal", async () => {
    saved = BRIGHTLOOP_KEY;
    db.runs = [run({ tool_calls: [{ name: "email__propose_campaign", status: "tool_error", code: "email_audience_empty" }] })];
    expect(await miss()).not.toBeNull();
  });
});

describe("New email on a dead key", () => {
  const precheck = TOP_ACTIONS.email_marketing.new_email.precheck!;
  const go = (route = "sendgrid") => precheck("t1", { route, list_id: "list-1" });

  it("refuses before a run starts, in the tool's own words", async () => {
    expect(await go()).toMatch(/SendGrid rejected the key Zavi has saved/);
    expect(vendor).toBe(1);
  });

  it("a click always reads afresh: a key fixed a moment ago is not refused from the poll's memory", async () => {
    await miss();
    saved = BRIGHTLOOP_KEY;
    expect(await go()).toBeNull();
    expect(vendor).toBe(2);
  });

  it("a tool that cannot be checked lets the run start: only a proven dead key refuses", async () => {
    conn.caller = async () => async () => ({ ok: false, status: 503, error: "busy" });
    expect(await go()).toBeNull();
    conn.caller = async () => null;
    expect(await go()).toBeNull();
  });
});
