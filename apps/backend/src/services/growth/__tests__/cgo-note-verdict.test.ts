import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({}), tenantMarkerAt: async () => null }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import { adDisconnectedBlocker, adReadFailedBlocker, adReadSlowBlocker, alertHeadline, blockerItem, overspendBlocker } from "../cgo-blockers";
import { buildNoteItems, channelCardNoteItem, deriveHeadline, lineAfterHeadline, type NoteItem } from "../cgo-note-items";
import { renderCgoNoteSlack, renderCgoNoteSlackMessage } from "../cgo-note-slack";
import { renderCgoNoteEmail } from "@/email/templates/cgo-note";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const url = "https://www.zaviagent.com/workspace?tab=growth-strategy";
const base = { companyName: "UpcarAI", changed: [], need: [], nextReviewAt: "2026-10-10T16:00:00.000Z", growthUrl: url, tenantId: T, adsEvery2h: true };
const NOW = new Date("2026-10-09T22:07:00.000Z");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
type Block = { type: string; text?: { text: string }; accessory?: { text: { text: string }; url: string }; elements?: Array<{ text?: { text: string } | string; url?: string }> };

describe("a held change is a decision, not a change", () => {
  const held = channelCardNoteItem({
    outcome: "reject",
    row: { id: "c-held", channel_slug: "meta_ads", title: "Raise Host Recommended Areas (copy)" },
    bucket: null,
    action: "Keep Host Recommended Areas (copy) at $136.12 a day",
    why: "Only $88.22 of October's cap is free, and this raise needs about $4,138 more",
    usd: null,
    platform: "Meta Ads",
    fixText: null,
  });

  it("goes under Decisions I made and the headline never says a change was made", () => {
    expect(held.section).toBe("decided");
    const items = buildNoteItems([held]);
    const headline = deriveHeadline(items)!;
    expect(headline).toBe("Held back a change: Keep Host Recommended Areas (copy) at $136.12 a day.");
    const text = renderCgoNoteSlack({ ...base, items, headline, kind: "scheduled" });
    expect(text).not.toMatch(/change made|What I changed|Rejected/);
    expect(text.split("\n")[0]).toBe("*UpcarAI: Held back a change: Keep Host Recommended Areas (copy) at $136.12 a day.*");
    expect(count(text, "Keep Host Recommended Areas")).toBe(1);
    expect(text).toContain("Only $88.22 of October's cap is free, and this raise needs about $4,138 more.");
  });

  it("with a real change beside it, the count is of real changes and the decision keeps its section", () => {
    const applied: NoteItem = { section: "changed", text: "Applied: Raise Sofa Search to $110 a day", action_id: "c-up", channel_slug: "google_ads" };
    const items = buildNoteItems([held, applied]);
    expect(deriveHeadline(items)).toBe("1 change made. Applied: Raise Sofa Search to $110 a day.");
    const text = renderCgoNoteSlack({ ...base, items, headline: deriveHeadline(items), kind: "scheduled" });
    expect(text).toContain("*What I did*\n• Said no to: Keep Host Recommended Areas (copy) at $136.12 a day.");
    expect(count(text, "Raise Sofa Search")).toBe(1);
  });
});

describe("a direct alert reads as sentences, with its fix as a button", () => {
  const tiktok = adReadFailedBlocker({ budget_id: "b1", platform: "tiktok_ads", name: "TikTok Ads", day: "2026-10-09", since: NOW.toISOString() });
  const over = overspendBlocker({ budget_id: "b1", day: "2026-10-09", projected_usd: 27347, cap_usd: 25000 });
  const alarm = (b: typeof tiktok) => {
    const ranked = { b, severity: "urgent" as const, state: "new" as const };
    return { ...base, items: [blockerItem(b, "urgent", "new", NOW)], headline: alertHeadline([ranked]), kind: "alarm" };
  };

  it("the TikTok alert: no field labels, said once, a Reconnect button, no check-in footer", () => {
    const n = alarm(tiktok);
    const text = renderCgoNoteSlack(n);
    expect(text).not.toMatch(/Who:|Meanwhile:|\bNew\.|Waiting since today|Next full check-in|Next check-in/);
    expect(text.split("\n")[0]).toBe("*UpcarAI: Needs you now: Reconnect TikTok Ads: TikTok Ads connection stopped working*");
    expect(count(text, "Reconnect TikTok Ads:")).toBe(1);
    expect(text).toContain("Budget raises on TikTok Ads wait; your other ad accounts keep working. Money is at risk until this is fixed.");
    const blocks = renderCgoNoteSlackMessage(n).blocks as Block[];
    const fix = blocks.find((b) => b.accessory)?.accessory;
    expect(fix?.text.text).toBe("Reconnect");
    expect(fix?.url).toContain("tab=growth-strategy");
    expect(fix?.url).toContain("#growth-needs");
    expect(fix?.url).toContain(`company=${T}`);
    expect(JSON.stringify(blocks)).not.toContain("Needs you*");
  });

  it("a platform that has not answered for 3 hours, or was disconnected: sentences, and no Reconnect button", () => {
    const slow = adReadSlowBlocker({ budget_id: "b1", platform: "tiktok", name: "TikTok Ads", day: "2026-10-09", since: NOW.toISOString() });
    const gone = adDisconnectedBlocker({ budget_id: "b1", platform: "linkedin", name: "LinkedIn Ads", day: "2026-10-09", since: NOW.toISOString(), usd: 412.4 });
    const s1 = renderCgoNoteSlack(alarm(slow));
    expect(s1.split("\n")[0]).toBe("*UpcarAI: Needs you now: TikTok Ads hasn't answered for 3 hours*");
    expect(s1).toContain("Budget raises on TikTok Ads wait");
    expect(s1).not.toContain("Money is at risk");
    const s2 = renderCgoNoteSlack(alarm(gone));
    expect(s2).toContain("LinkedIn Ads was disconnected");
    expect(s2).toContain("Zavi last saw $412 spent on it this month, and that still counts toward your cap");
    expect(s2).toContain("Campaigns still live on your own LinkedIn Ads account keep spending, and Zavi can no longer see or count that spend. Connect LinkedIn Ads again from Connectors, or pause those campaigns in LinkedIn Ads");
    expect(s2).not.toMatch(/nothing to do/i);
    for (const b of [slow, gone]) {
      const blocks = renderCgoNoteSlackMessage(alarm(b)).blocks as Block[];
      expect(blocks.find((x) => x.accessory)?.accessory?.text.text).not.toBe("Reconnect");
    }
  });

  it("the overspend alert: the title is the first sentence, the body the fix, an Ad budget button", () => {
    const n = alarm(over);
    expect(n.headline).toBe("Needs you now: Your ads are on track to spend $27,347 this month, $2,347 over your $25,000 cap");
    const text = renderCgoNoteSlack(n);
    expect(count(text, "$27,347")).toBe(1);
    expect(text).toContain("Zavi doesn't lower budgets on its own when the month runs over. To stop it, lower daily budgets in your ad accounts or raise the cap on your Ad budget page. $2,347 a month at stake.");
    expect(count(text, "lower daily budgets")).toBe(1);
    expect(text).not.toContain("I lower budgets");
    const fix = (renderCgoNoteSlackMessage(n).blocks as Block[]).find((b) => b.accessory)?.accessory;
    expect(fix?.text.text).toBe("Ad budget");
    expect(fix?.url).toContain("#ad-budget");
  });

  it("the email of the same alert drops the check-in line and names the fix", () => {
    const n = alarm(tiktok);
    const r = renderCgoNoteEmail({ ...n, autopilot: true, saw: [] });
    expect(r.subject).toBe("UpcarAI: Needs you now: Reconnect TikTok Ads: TikTok Ads connection stopped working");
    expect(r.text).not.toMatch(/Next full check-in|Who:|Meanwhile:/);
    expect(r.text).toContain("Reconnect: http");
    expect(count(r.text, "Reconnect TikTok Ads:")).toBe(1);
  });
});

describe("what the headline rule must not touch", () => {
  const card = (id: string, text: string, reason?: string): NoteItem => ({ section: "needs_you", text, action_id: id, channel_slug: "google_ads", ...(reason ? { reason } : {}) });

  it("a headline about something else keeps every row whole", () => {
    expect(lineAfterHeadline(card("a", "Count sign-ups", "Spent $468"), "One fix lets Google see sign-ups.")).toBeNull();
  });

  it("a headline that only starts the same word, or was cut short, keeps the row whole", () => {
    expect(lineAfterHeadline(card("a", "Raise Search to $1100 a day"), "Needs you now: Raise Search to $110")).toBeNull();
    expect(lineAfterHeadline(card("a", "Raise Search to $110 a day and pause Brand"), "Needs you now: Raise Search to $110 a day and…")).toBeNull();
  });

  it("several asks keep every row and the section title; only the single-row note loses its title", () => {
    const items = buildNoteItems([card("a", "Count sign-ups", "Spent $468"), card("b", "Fix checkout")]);
    const text = renderCgoNoteSlack({ ...base, items, headline: deriveHeadline(items), kind: "scheduled" });
    expect(text).toContain("*Your calls*");
    expect(text).toContain("• Count sign-ups. Spent $468.");
    expect(text).toContain("• Fix checkout.");
  });

  it("a question is never cut by the headline", () => {
    expect(lineAfterHeadline({ section: "needs_you", text: "Keep Reddit?", question_ordinal: 1 }, "Keep Reddit?")).toBeNull();
  });

  it("a scheduled review keeps its check-in footer", () => {
    const items = buildNoteItems([card("a", "Count sign-ups")]);
    expect(renderCgoNoteSlack({ ...base, items, kind: "scheduled" })).toContain("Next full check-in: Oct 10");
  });
});

describe("a dense note never passes Slack's 50-block limit", () => {
  it("falls back to inline links when the buttons would push it over", () => {
    const qs = Array.from({ length: 22 }, (_, k) => ({ id: `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`, ordinal: k + 1, ask: `Keep channel ${k}?`, recommended: "yes" as const, why: null, yesNo: true, noteLine: `q${k}` }));
    const items = buildNoteItems([
      ...qs.map((q): NoteItem => ({ section: "needs_you", text: q.ask, question_ordinal: q.ordinal })),
      ...Array.from({ length: 5 }, (_, k): NoteItem => ({ section: "needs_you", text: `Card ${k}`, reason: "Spent $40", action_id: `c${k}`, channel_slug: `ch${k}` })),
    ]);
    const msg = renderCgoNoteSlackMessage({ ...base, items, questions: qs, kind: "scheduled" });
    const blocks = msg.blocks as Block[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.some((b) => b.accessory)).toBe(false);
    expect(JSON.stringify(blocks)).toContain("|Open>");
    expect(blocks.filter((b) => b.type === "actions")).toHaveLength(22);
  });
});

