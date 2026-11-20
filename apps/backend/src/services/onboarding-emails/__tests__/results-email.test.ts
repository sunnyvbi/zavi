
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; columns: string }>,
}));

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): unknown => {
    const p: Record<string, unknown> = {};
    for (const m of ["eq", "in", "is", "not", "gte", "like", "order", "limit", "lte"]) p[m] = () => p;
    p.select = (columns: string) => (db.selects.push({ table, columns }), p);
    p.maybeSingle = () => p;
    p.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: db.rows[table] ?? [], error: null }).then(res);
    return p;
  };
  return { asTenantId: (s: string) => s, tenantClient: () => ({ from: (t: string) => chain(t) }) };
});

import { EMAIL_CARD_COLUMNS, loadWorkspaceFacts, openCardsByChannel } from "../facts";
import { channelResults, digestResults, STARTER_LINE } from "../content";
import { renderOnboardingSequenceEmail, DETAIL_MAX } from "@/email/templates/onboarding-sequence";
import { stepByNumber } from "../steps";

const SENTINEL = "SENTINEL-DRAFT-7f3a";
const NOW = new Date("2026-10-06T10:00:00Z");
const WS = "https://www.zaviagent.com/workspace";
const base = {
  firstName: "Priya",
  workspaceUrl: WS,
  imageBaseUrl: "https://www.zaviagent.com",
  unsubscribeUrl: "https://api.zaviagent.com/api/onboarding-emails/unsubscribe?t=abc",
};

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    channel_slug: "reddit_organic",
    title: "Reply to the invoicing thread on r/smallbusiness",
    status: "pending",
    snoozed_until: null,
    blocking: false,
    position: 1,
    score: 60,
    proposed_at: "2026-10-05T12:00:00Z",
    action_type: "reply",
    reason: "Three owners asked which tool chases late invoices; your product does exactly that.",
    responsibility: "client",
    deliverable_kind: "reply",
    body: { step: { body: "reason", deliverable: { content: SENTINEL } }, rendered_markdown: SENTINEL },
    edited_body: SENTINEL,
    exec_payload: { text: SENTINEL },
    exec_result: { text: SENTINEL },
    how_to: SENTINEL,
    note: SENTINEL,
    ...over,
  };
}

beforeEach(() => {
  db.rows = {};
  db.selects = [];
});

describe("the narrow card read", () => {
  it("never selects body, edited_body or exec_payload", () => {
    const cols = EMAIL_CARD_COLUMNS.split(",").map((c) => c.trim().split(":")[0]);
    for (const banned of ["body", "edited_body", "exec_payload", "exec_result", "how_to", "note"]) {
      expect(cols, banned).not.toContain(banned);
    }
  });

  it("is what loadWorkspaceFacts asks the database for", async () => {
    await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const card = db.selects.find((s) => s.table === "channel_actions");
    expect(card?.columns).toBe(EMAIL_CARD_COLUMNS);
  });

  it("drops plans, operator notes and closed or still-snoozed cards; ranks the rest", () => {
    const m = openCardsByChannel(
      [
        dbRow({ id: "plan", deliverable_kind: "strategy" }),
        dbRow({ id: "note", responsibility: "zavi" }),
        dbRow({ id: "done", status: "acted" }),
        dbRow({ id: "later", status: "snoozed", snoozed_until: "2026-10-09T00:00:00Z" }),
        dbRow({ id: "low", position: 2, score: 10 }),
        dbRow({ id: "top", position: 1, score: 20 }),
      ] as never,
      NOW.getTime(),
    );
    expect(m.get("reddit_organic")?.map((c) => c.id)).toEqual(["top", "low"]);
  });
});

describe("no draft ever reaches an email", () => {
  it("a sentinel in every excluded field is absent from both results emails", async () => {
    db.rows.channel_actions = [dbRow(), dbRow({ id: "a2", title: "Second reply", position: 2 })];
    db.rows.tenants = { display_name: "Acme" };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const channel = channelResults({ step: 6, facts, workspaceUrl: WS, planLacks: () => true })!;
    const digest = digestResults({ facts, workspaceUrl: WS })!;
    for (const [step, results] of [
      [6, channel],
      [10, digest],
    ] as const) {
      const r = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(step)!, results });
      expect(r.html).toContain("Reply to the invoicing thread");
      for (const part of [r.html, r.text, r.subject]) expect(part).not.toContain(SENTINEL);
    }
  });
});

describe("rendering the cards", () => {
  it("a <script> card title renders as text, in the body and never as markup", async () => {
    db.rows.channel_actions = [dbRow({ title: `<script>alert("x")</script>`, reason: `<img src=x onerror=alert(1)>` })];
    db.rows.tenants = { display_name: `Acme <b>Co</b>` };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const results = channelResults({ step: 6, facts, workspaceUrl: WS, planLacks: () => false })!;
    const r = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(6)!, results });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).not.toContain("<b>Co</b>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("the line under a title is the reason on one line, cut at 160 characters", async () => {
    const long = `First line\n\nsecond line ${"word ".repeat(80)}`;
    db.rows.channel_actions = [dbRow({ reason: long })];
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const results = channelResults({ step: 6, facts, workspaceUrl: WS, planLacks: () => true })!;
    const r = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(6)!, results });
    const detail = r.text.split("\n").find((l) => l.startsWith("  First line"))!.trim();
    expect(detail.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(detail).toMatch(/^First line second line word/);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("channel results: top 2, the count of the rest, a deep link on the first card", async () => {
    db.rows.channel_actions = [1, 2, 3, 4].map((i) => dbRow({ id: `a${i}`, title: `Reply ${i}`, position: i }));
    db.rows.tenants = { display_name: "Acme" };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const results = channelResults({ step: 6, facts, workspaceUrl: WS, planLacks: () => true })!;
    expect(results.subject).toBe("4 Reddit steps are ready for Acme");
    expect(results.items.map((i) => i.title)).toEqual(["Reply 1", "Reply 2"]);
    expect(results.moreLines).toEqual(["2 more steps on the Reddit page"]);
    expect(results.button).toBe("Review the drafts");
    expect(results.ctaUrl).toBe(`${WS}?tab=channels&channel=reddit_organic&action=a1&src=onb_6`);
    expect(results.afterButton).toBe(STARTER_LINE);
  });

  it("creators results: cards across the creator channels, each with its channel prefix", async () => {
    db.rows.channel_actions = [
      dbRow({ id: "u1", channel_slug: "ugc", title: "Brief a creator on the invoice demo", position: 1 }),
      dbRow({ id: "g1", channel_slug: "generated_video", title: "AI video: chasing a late invoice", position: 2 }),
      dbRow({ id: "r1", channel_slug: "reddit_organic", title: "Not a creator card", position: 0 }),
    ];
    db.rows.tenants = { display_name: "Acme" };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const results = channelResults({ step: 8, facts, workspaceUrl: WS, planLacks: () => false })!;
    expect(results.subject).toBe("2 UGC Videos and AI UGC Videos steps are ready for Acme");
    expect(results.items.map((i) => i.prefix)).toEqual(["UGC Videos", "AI UGC Videos"]);
    expect(results.items.map((i) => i.title)).not.toContain("Not a creator card");
    expect(results.ctaUrl).toBe(`${WS}?tab=channels&channel=ugc&action=u1&src=onb_8`);
    const locked = channelResults({ step: 8, facts, workspaceUrl: WS, planLacks: () => true })!;
    expect(locked.afterButton).toContain("On Growth I post for you");
  });

  it("creators results: null when no creator channel has cards (the intro goes)", async () => {
    db.rows.channel_actions = [dbRow()];
    db.rows.tenants = { display_name: "Acme" };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    expect(channelResults({ step: 8, facts, workspaceUrl: WS, planLacks: () => false })).toBeNull();
  });

  it("digest: top 3 across channels with a prefix, the rest per channel, still-working, Growth Strategy link", async () => {
    db.rows.channel_actions = [
      dbRow({ id: "r1" }),
      dbRow({ id: "r2", position: 2 }),
      dbRow({ id: "s1", channel_slug: "seo", title: "Fix the pricing page title" }),
      dbRow({ id: "l1", channel_slug: "linkedin_organic", title: "Post the launch story", position: 2, score: 1 }),
      dbRow({ id: "l2", channel_slug: "linkedin_organic", title: "Post the customer quote", position: 3, score: 1 }),
    ];
    db.rows.tenants = { display_name: "Acme" };
    db.rows.agent_runs = [{ agent_slug: "instagram_organic", status: "running", channel_slug: null }];
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const d = digestResults({ facts, workspaceUrl: WS })!;
    expect(d.subject).toBe("Your first results for Acme: 5 steps ready");
    expect(d.items).toHaveLength(3);
    expect(d.items.every((i) => !!i.prefix)).toBe(true);
    expect(d.moreLines).toEqual(["Also ready: 2 LinkedIn.", "1 more channel is still working."]);
    expect(d.ctaUrl).toBe(`${WS}?tab=channels&src=onb_10`);
    const r = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(10)!, results: d });
    expect(r.html).toContain(`<a href="${WS}?tab=growth-strategy&amp;src=onb_10">Growth Strategy</a>`);
    expect(r.html).toContain("See all results");
  });

  it.skipIf(!process.env.WRITE_EMAIL_PREVIEWS)("writes one results and one fallback email to .context/email-previews for reading", async () => {
    db.rows.channel_actions = [
      dbRow(),
      dbRow({ id: "a2", title: "Start a thread on chasing late invoices", position: 2, reason: "No one in r/freelance has covered the follow-up email that gets paid; a how-to fits your voice." }),
      dbRow({ id: "a3", title: "Answer the Stripe-fees question", position: 3 }),
    ];
    db.rows.tenants = { display_name: "Acme Invoicing" };
    const facts = await loadWorkspaceFacts("t-1", "2026-10-01T00:00:00Z", NOW);
    const results = channelResults({ step: 6, facts, workspaceUrl: WS, planLacks: () => true })!;
    const out = join(__dirname, "../../../../../../.context/email-previews");
    mkdirSync(out, { recursive: true });
    const res = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(6)!, results });
    const fallback = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(6)! });
    const digest = renderOnboardingSequenceEmail({ ...base, step: stepByNumber(10)!, results: digestResults({ facts, workspaceUrl: WS })! });
    writeFileSync(join(out, "results-reddit.html"), res.html);
    writeFileSync(join(out, "fallback-reddit.html"), fallback.html);
    writeFileSync(join(out, "digest.html"), digest.html);
    writeFileSync(join(out, "subjects.txt"), [res.subject, fallback.subject, digest.subject].join("\n") + "\n");
    expect(fallback.subject).toBe("Meet your Reddit channel");
  });
});
