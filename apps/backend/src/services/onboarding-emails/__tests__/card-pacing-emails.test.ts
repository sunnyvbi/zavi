
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantClient: () => ({}) }));

import { openCardsByChannel, type WorkspaceFacts } from "../facts";
import { digestResults } from "../content";
import { channelOrderFor } from "../plan";

const NOW = new Date("2026-10-30T12:00:00Z").getTime();
const LATER = "2026-11-09T09:40:00Z";
let n = 0;
function row(channel_slug: string, over: Record<string, unknown> = {}) {
  n += 1;
  return {
    id: `c${n}`,
    channel_slug,
    title: `Card ${n} on ${channel_slug}`,
    status: "pending",
    snoozed_until: null,
    held_reason: null,
    blocking: false,
    position: n,
    score: 50,
    proposed_at: "2026-10-30T10:00:00Z",
    action_type: null,
    reason: "Why it matters.",
    responsibility: "client",
    deliverable_kind: null,
    ...over,
  };
}
const held = (slug: string) => row(slug, { status: "snoozed", snoozed_until: LATER, held_reason: "pacing" });

function facts(rows: ReturnType<typeof row>[]): WorkspaceFacts {
  const cards = openCardsByChannel(rows, NOW);
  return {
    company: "Acme",
    cards,
    plan: {
      openCards: new Map([...cards].map(([k, v]) => [k, v.length])),
      used: new Set(),
      inFlight: new Set(),
      upgradeEmailSent: false,
      paidRerunsInFlight: false,
    },
  };
}

describe("held signup cards in the email facts", () => {
  it("counts a held card as open and marks it held; a founder's own future snooze stays out", () => {
    const cards = openCardsByChannel(
      [row("linkedin_organic"), held("reddit_organic"), row("seo", { status: "snoozed", snoozed_until: LATER })],
      NOW,
    );
    expect(cards.get("linkedin_organic")?.[0]?.held).toBe(false);
    expect(cards.get("reddit_organic")?.[0]?.held).toBe(true);
    expect(cards.has("seo")).toBe(false);
  });

  it("orders the channel emails by every card, held ones included", () => {
    const f = facts([row("linkedin_organic"), held("reddit_organic"), held("reddit_organic")]);
    expect(channelOrderFor(f.plan)[0]).toBe(6);
  });
});

describe("the digest with held cards", () => {
  const f = facts([
    ...Array.from({ length: 5 }, () => row("linkedin_organic")),
    ...Array.from({ length: 8 }, () => held("x_organic")),
    ...Array.from({ length: 6 }, () => held("instagram_organic")),
    ...Array.from({ length: 5 }, () => held("reddit_organic")),
  ]);
  const d = digestResults({ facts: f, workspaceUrl: "https://www.zaviagent.com/workspace" })!;

  it("keeps the TOTAL in the subject", () => {
    expect(d.subject).toBe("Your first results for Acme: 24 steps ready");
  });

  it("shows the top 3 from the visible channel only", () => {
    expect(d.items).toHaveLength(3);
    expect(d.items.every((i) => i.prefix === "LinkedIn")).toBe(true);
  });

  it("says what is coming next instead of listing held channels as ready", () => {
    expect(d.moreLines).toEqual(["Also ready: 2 LinkedIn.", "Coming next: 8 X, 6 Instagram, 5 Reddit. One channel a day."]);
  });
  it("never shows a held card when the founder cleared every visible one", () => {
    const only = digestResults({ facts: facts([held("x_organic"), held("x_organic")]), workspaceUrl: "https://www.zaviagent.com/workspace" })!;
    expect(only.subject).toBe("Your first results for Acme: 2 steps ready");
    expect(only.items).toEqual([]);
    expect(only.moreLines).toEqual(["Coming next: 2 X. One channel a day."]);
  });
});
