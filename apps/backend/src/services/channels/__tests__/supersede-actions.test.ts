import { describe, expect, it } from "vitest";
import { supersededOpenCards, type NewCard, type OpenCard } from "../supersede-actions";

const RUN = "run-new";

function open(id: string, extra: Partial<OpenCard> = {}): OpenCard {
  return {
    id,
    run_id: "run-old",
    status: "pending",
    exec_status: null,
    approved_by: null,
    steps_done: [],
    edited_body: null,
    exec_class: null,
    customer: true,
    ...extra,
  };
}

function card(title: string, repeat_of: string | null, customer = true): NewCard {
  return { title, repeat_of, customer };
}

describe("supersededOpenCards", () => {
  it("retires the card a new one names in repeat_of, even when reworded", () => {
    const flags = supersededOpenCards(
      RUN,
      [card('Rebuild "40% to Turo" as a conversion campaign now', "m1")],
      [open("m1")],
    );
    expect(flags).toEqual([
      { action_id: "m1", evidence: 'Replaced by a newer card: Rebuild "40% to Turo" as a conversion campaign now' },
    ]);
  });

  it("matches repeat_of regardless of case or surrounding space", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const flags = supersededOpenCards(RUN, [card("Restated", ` ${id.toUpperCase()} `)], [open(id)]);
    expect(flags.map((f) => f.action_id)).toEqual([id]);
  });

  it("a matching title alone retires nothing: a title does not identify a target", () => {
    expect(
      supersededOpenCards(RUN, [card("Pause the ad group that is not converting", null)], [open("p1")]),
    ).toEqual([]);
  });

  it("never retires a card the founder touched, started, or that is executing", () => {
    const flags = supersededOpenCards(
      RUN,
      ["snoozed", "acted", "rejected", "queued", "dispatching", "failed", "approved", "half-done"].map((id) =>
        card("Rebuild the campaign", id),
      ),
      [
        open("snoozed", { status: "snoozed" }),
        open("acted", { status: "acted" }),
        open("rejected", { status: "rejected" }),
        open("queued", { exec_status: "queued" }),
        open("dispatching", { exec_status: "dispatching" }),
        open("failed", { exec_status: "failed" }),
        open("approved", { approved_by: "user-1" }),
        open("half-done", { steps_done: [0] }),
      ],
    );
    expect(flags).toEqual([]);
  });

  it("never retires a pending draft the founder reviewed or edited (e.g. a ChatGPT Ads campaign)", () => {
    const flags = supersededOpenCards(
      RUN,
      [card("New campaign", "reviewed"), card("New campaign", "edited"), card("New campaign", "model-exec")],
      [
        open("reviewed", { exec_class: "chatgpt_ads.create_campaign_bundle" }),
        open("edited", { edited_body: { step: { title: "mine" } } }),
        open("model-exec", { exec_class: "meta_ads.update_budget" }),
      ],
    );
    expect(flags.map((f) => f.action_id)).toEqual(["model-exec"]);
  });

  it("matches only within the same customer/operator class", () => {
    expect(supersededOpenCards(RUN, [card("Operator note", "c1", false)], [open("c1", { customer: true })])).toEqual(
      [],
    );
    expect(
      supersededOpenCards(RUN, [card("Operator note", "o1", false)], [open("o1", { customer: false })]).map(
        (f) => f.action_id,
      ),
    ).toEqual(["o1"]);
  });

  it("never retires a card of the current run, and flags each open card once", () => {
    const flags = supersededOpenCards(
      RUN,
      [card("Update your headline", "o1"), card("Update your headline, again", "o1"), card("x", "mine")],
      [open("mine", { run_id: RUN }), open("o1")],
    );
    expect(flags.map((f) => f.action_id)).toEqual(["o1"]);
  });

  it("a card the matcher paired never retires an executable card; a model's own repeat_of still may", () => {
    const matched: NewCard = { title: "Pause it by hand", repeat_of: "exec", customer: true, matched: true };
    expect(supersededOpenCards(RUN, [matched], [open("exec", { exec_class: "meta_ads.pause_ad" })])).toEqual([]);
    expect(
      supersededOpenCards(RUN, [{ ...matched, repeat_of: "manual" }], [open("manual")]).map((f) => f.action_id),
    ).toEqual(["manual"]);
    expect(
      supersededOpenCards(RUN, [card("Pause it", "exec")], [open("exec", { exec_class: "meta_ads.pause_ad" })]).map(
        (f) => f.action_id,
      ),
    ).toEqual(["exec"]);
  });
});
