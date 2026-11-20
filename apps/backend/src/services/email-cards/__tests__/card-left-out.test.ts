import { describe, expect, it, vi } from "vitest";
import { cardSendFacts, cardSendState, cardView, type SendFacts, type ViewState } from "../cards";

const bulk = (over: Record<string, unknown> = {}) => ({
  status: "done", hold_reason: null, total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0,
  created_at: "2026-11-02T00:00:00Z", finished_at: "2026-11-02T00:01:00Z", next_run_at: null, ...over,
});
const facts = (b: ReturnType<typeof bulk> | null): SendFacts => ({ card: { status: "acted", approved: true }, bulk: b, results: null }) as SendFacts;
const view = { class: "bulk_outbound.send", status: "acted", body: { list_name: "Testing", est_recipient_count: 3, will_be_skipped: 2, variants: [] } } as unknown as ViewState;

const read = (b: ReturnType<typeof bulk> | null, leftOut: () => Promise<number | null>) =>
  cardSendFacts("t", "decisions", "D1", { rpc: (async () => facts(b)) as never, leftOut });

describe("left-out people on the email card", () => {
  it("a done send carries the count through to the card", async () => {
    const f = await read(bulk(), async () => 2);
    const state = cardSendState("decisions", view, f);
    expect(state).toMatchObject({ status: "sent", sent_count: 3, left_out_count: 2 });
    expect(state.skipped_count).toBeUndefined();
  });

  it("nobody left out: no field, so the card shows no line", async () => {
    const state = cardSendState("decisions", view, await read(bulk(), async () => 0));
    expect(state).not.toHaveProperty("left_out_count");
  });

  it("a failed read leaves the card working and silent", async () => {
    const state = cardSendState("decisions", view, await read(bulk(), async () => { throw new Error("down"); }));
    expect(state.status).toBe("sent");
    expect(state).not.toHaveProperty("left_out_count");
  });

  it("a send still going out does not pay for the read", async () => {
    const leftOut = vi.fn(async () => 2);
    await read(bulk({ status: "sending" }), leftOut);
    expect(leftOut).not.toHaveBeenCalled();
  });

  it("the tool rail never reads it", async () => {
    const leftOut = vi.fn(async () => 2);
    await cardSendFacts("t", "channel_actions", "A1", { rpc: (async () => facts(bulk())) as never, leftOut });
    expect(leftOut).not.toHaveBeenCalled();
  });

  it("before approval, the card carries the count sealed on the draft", () => {
    const v = cardView("decisions", "D1", { ...view, open: true } as ViewState);
    expect(v.list).toEqual({ name: "Testing", people: 3, left_out: 2 });
  });

  it("a draft with nobody blocked has no left_out field", () => {
    const v = cardView("decisions", "D1", { ...view, open: true, body: { list_name: "Testing", est_recipient_count: 3, variants: [] } } as unknown as ViewState);
    expect(v.list).toEqual({ name: "Testing", people: 3 });
  });
});
