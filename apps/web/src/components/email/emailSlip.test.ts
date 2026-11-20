import { describe, expect, it } from "vitest";
import { emailSlipHero, emailSlipStage, emailSlipSteps, type EmailSlipCard } from "./emailSlip";

const card = (o: Partial<EmailSlipCard> = {}): EmailSlipCard => ({ open: true, status: "proposed", route: "zavi_list", list: { name: "Lapsed guests", people: 2400 }, chosen_variant: null, ...o });
const none = { stalled: false, scheduled: false };
const cap1000 = (n: number) => Math.min(n, 1000);

describe("emailSlipStage", () => {
  it("anything that may have gone out is unknown, ahead of every other signal", () => {
    expect(emailSlipStage(card({ open: false, status: "dispatching" }), { stalled: true, scheduled: false })).toBe("unknown");
    expect(emailSlipStage(card({ open: false, status: "failed", may_have_sent: true }), none)).toBe("unknown");
    expect(emailSlipStage(card({ open: false, status: "outcome_unknown" }), none)).toBe("unknown");
  });
  it("an email approved for a planned time is queued though the card is still open", () => {
    expect(emailSlipStage(card({ open: true }), { stalled: false, scheduled: true })).toBe("queued");
    expect(emailSlipStage(card({ open: true }), none)).toBe("waiting");
  });
  it("paused or on hold is held, not sending", () => {
    expect(emailSlipStage(card({ open: false, status: "approved", pause_hold: "paused" }), none)).toBe("held");
    expect(emailSlipStage(card({ open: false, status: "held" }), none)).toBe("held");
  });
  it("maps the rest", () => {
    expect(emailSlipStage(card({ open: false, status: "queued" }), none)).toBe("queued");
    expect(emailSlipStage(card({ open: false, status: "waiting_for_tomorrow" }), none)).toBe("sending");
    expect(emailSlipStage(card({ open: false, status: "sent" }), none)).toBe("done");
    expect(emailSlipStage(card({ open: false, status: "partially_sent" }), none)).toBe("partial");
    expect(emailSlipStage(card({ open: false, status: "dispatch_failed" }), none)).toBe("failed");
    expect(emailSlipStage(card({ open: false, status: "stopped" }), none)).toBe("closed");
  });
});

describe("emailSlipHero", () => {
  it("before the send: the audience, capped like the send", () => {
    expect(emailSlipHero(card(), "waiting", cap1000)).toMatchObject({ eyebrow: "Audience", amount: "1,000", unit: "people" });
  });
  it("a held or paused send that already reached people says how many, never the audience", () => {
    expect(emailSlipHero(card({ open: false, status: "held", sent_count: 100 }), "held", cap1000)).toMatchObject({ eyebrow: "Sent so far", amount: "100" });
    expect(emailSlipHero(card({ open: false, status: "held", sent_count: 0 }), "held", cap1000)).toMatchObject({ eyebrow: "Audience" });
  });
  it("a send that reached nobody never says 'Sent to 0', and its step is not ticked", () => {
    const c = card({ open: false, status: "not_sent", sent_count: 0 });
    expect(emailSlipHero(c, "closed", cap1000)).toBeNull();
    expect(emailSlipSteps(c, "closed", "Zavi", "")[1]).toMatchObject({ state: "fail", sub: "Not sent." });
  });
  it("no number when the list size is unknown", () => {
    expect(emailSlipHero(card({ list: { name: "x", people: null } }), "waiting", cap1000)).toBeNull();
  });
  it("after: how many were sent, never the audience", () => {
    expect(emailSlipHero(card({ open: false, status: "sent", sent_count: 1236 }), "done", cap1000)).toMatchObject({ eyebrow: "Sent to", amount: "1,236" });
    expect(emailSlipHero(card({ open: false, status: "sent", sent_count: null }), "done", cap1000)).toBeNull();
    expect(emailSlipHero(card({ open: false, status: "failed" }), "failed", cap1000)).toBeNull();
    expect(emailSlipHero(card({ open: false, status: "outcome_unknown" }), "unknown", cap1000)).toBeNull();
  });
});

describe("emailSlipSteps", () => {
  it("never says Delivered; a stall says do not send again", () => {
    const all = (["queued", "sending", "held", "done", "partial", "failed", "unknown", "closed"] as const).map((st) => emailSlipSteps(card({ open: false, status: "sent" }), st, "SendGrid", "Starting"));
    expect(JSON.stringify(all)).not.toMatch(/Delivered/);
    expect(emailSlipSteps(card(), "unknown", "SendGrid", "")[1]).toMatchObject({ state: "warn", sub: "It may have gone out. Do not send it again yet." });
  });
  it("held is a warning with the card's own words, not a spinner", () => {
    expect(emailSlipSteps(card(), "held", "Zavi", "Email is paused")[1]).toMatchObject({ state: "warn", sub: "Email is paused" });
  });
});
