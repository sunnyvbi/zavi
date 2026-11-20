import { beforeEach, describe, expect, it, vi } from "vitest";

const CARD = "9f8e7d6c-1111-4222-8333-444455556666";
const world = vi.hoisted(() => ({ run: null as unknown, card: null as unknown, cardFails: false, ledger: [] as Array<Record<string, unknown>>, reads: [] as string[] }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "gt", "in", "order"]) q[m] = () => q;
      q.limit = async () => ({ data: table === "agent_runs" ? [world.run] : [], error: null });
      q.maybeSingle = async () => {
        world.reads.push(table);
        if (world.cardFails) throw new Error("read failed");
        return { data: world.card, error: null };
      };
      q.then = (done: (v: unknown) => void) => done({ data: table === "tenant_credit_ledger" ? world.ledger : [], error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));

import { readTopActionMiss, repeatWords } from "@/services/channels/top-action-miss";

const NOW = Date.parse("2026-10-23T10:05:00Z");
const INPUTS = { route: "klaviyo", list_id: "VYfr94", brief: "Happy diwali" };
const payload = (inputs: Record<string, unknown> = INPUTS) => ({ channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs } });
const refused = (code: string, verb: string) => [{ name: "mcp__server__email__propose_campaign", status: "tool_error", code, output_preview: JSON.stringify({ error: code, message: `Not filed: the founder already ${verb} the same change (card ${CARD}).` }) }];
const run = (over: Record<string, unknown> = {}) => ({ id: "cada35f6-1111-4000-8000-000000000000", status: "success", payload: payload(), tool_calls: refused("channel_card_already_done", "approved"), finished_at: "2026-10-23T10:00:51Z", ...over });
const REAL_CARD = { exec_status: "executed", exec_payload: { audience_name: "Zavi QA", chosen_variant: 1, variants: [{ content: { subject: "Happy Diwali" } }] } };
const miss = () => readTopActionMiss("t1", "u1", "email_marketing", NOW);

beforeEach(() => {
  world.run = run();
  world.card = REAL_CARD;
  world.cardFails = false;
  world.ledger = [];
  world.reads = [];
});

describe("a refused repeat", () => {
  it("names the email and list from the earlier card and hands back the inputs, without ids or filing words", async () => {
    const m = await miss();
    expect(m?.repeat).toEqual({ title: "You already sent this email", detail: "Happy Diwali went to Zavi QA. Change the brief to write a different one.", credits: null, inputs: INPUTS });
    expect(JSON.stringify(m?.repeat)).not.toContain(CARD);
    expect(JSON.stringify(m?.repeat)).not.toMatch(/\bfile/i);
  });

  it("a turned down email uses turned down words", async () => {
    world.run = run({ tool_calls: refused("channel_card_already_rejected", "turned down") });
    expect((await miss())?.repeat).toMatchObject({ title: "You turned this email down earlier", detail: "Happy Diwali was for Zavi QA. Change the brief to write a different one." });
  });

  it("approved but never executed does not claim it went out", async () => {
    world.card = { ...REAL_CARD, exec_status: "failed" };
    const r = (await miss())?.repeat;
    expect(r?.title).toBe("You already approved this email");
    expect(r?.detail).not.toContain("went to");
  });

  it("a Zavi list card names its list", () => {
    expect(repeatWords("channel_card_already_done", { subject: "Sale", list: "VIPs", sent: true }).detail).toContain("Sale went to VIPs.");
  });

  it("an unreadable earlier card still gives an honest notice with the inputs, and claims no send", async () => {
    world.cardFails = true;
    expect((await miss())?.repeat).toEqual({ title: "You already approved this email", detail: "Change the brief to write a different one.", credits: null, inputs: INPUTS });
  });

  it("a pasted email round-trips its inputs", async () => {
    const pasted = { route: "klaviyo", list_id: "VYfr94", pasted: { subject: "Hello there", body: "A body long enough to count as a pasted email." } };
    world.run = run({ payload: payload(pasted) });
    expect((await miss())?.repeat?.inputs).toEqual(pasted);
  });

  it("the credits line appears only when credits were spent", async () => {
    world.ledger = [{ run_id: run().id, kind: "settle", amount: 71, attempt: 1, debited: 71, debited_daily: 0 }];
    const spent = await miss();
    expect(spent?.repeat?.credits).toBe("This attempt used 71 credits.");
    expect(spent?.reason).toContain("This attempt used 71 credits.");
    world.ledger = [{ run_id: run().id, kind: "settle", amount: 0, attempt: 1, debited: 0, debited_daily: 0 }];
    expect((await miss())?.repeat?.credits ?? null).toBeNull();
  });
});

describe("every other miss", () => {
  it("an unrelated refusal keeps its reason, gets no repeat, and never reads the earlier card", async () => {
    world.run = run({ tool_calls: [{ name: "mcp__server__email__propose_campaign", status: "tool_error", code: "email_audience_empty", output_preview: "{}" }] });
    const m = await miss();
    expect(m?.reason).toBe("That list has nobody on it.");
    expect(m?.repeat).toBeUndefined();
    expect(world.reads).toEqual([]);
  });

  it("a failed run that happened to log a refusal stays a plain failure", async () => {
    world.run = run({ status: "failed" });
    const m = await miss();
    expect(m?.reason).toBe("it stopped before it finished. Try again.");
    expect(m?.repeat).toBeUndefined();
  });
});
