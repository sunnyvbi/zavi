
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
let roleAllowed = true;
const h = vi.hoisted(() => ({ start: vi.fn(), runRow: null as unknown, canRead: vi.fn(), list: vi.fn(), tenantFor: [] as string[] }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));
vi.mock("../run", () => ({ startChannelRun: h.start }));
const currency = vi.hoisted(() => ({ code: "USD" }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", () => ({ readGoogleAccountCurrency: async () => currency.code }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: h.canRead }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: h.list }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (t: string) => {
    h.tenantFor.push(t);
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: h.runRow, error: null }) };
    return { from: () => q };
  },
}));

import { runNote, runSummary, startTopAction, topActionRun } from "../top-actions";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const RUN = "11111111-1111-4111-8111-111111111111";
function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const inputs = { about: "Halloween deal", link: "https://upcar.ai/h", goal: "visit", placement: "both", daily_budget: 20 };
const post = (slug: string, key: string, body: unknown) => ({ params: { slug, key }, body }) as unknown as Request;

beforeEach(() => {
  authResult = { tenant_id: TENANT, user_id: USER, access_token: "t" };
  roleAllowed = true;
  h.start.mockReset().mockImplementation(async (r: Response) => { r.json({ ok: true, run_id: RUN }); });
  h.canRead.mockReset().mockResolvedValue(true);
  h.list.mockReset().mockResolvedValue([{ id: "a1", title: "New ad" }]);
  h.runRow = { status: "running", channel_slug: "meta_ads" };
  h.tenantFor.length = 0;
});

describe("POST /api/channels/:slug/top-actions/:key", () => {
  it("refuses a Google create on a non-USD account before any run starts", async () => {
    const g = { about: "Spring offer", link: "https://example.com/o", goal: "visit", daily_budget: 20, places: [{ id: "2276", name: "Germany" }] };
    currency.code = "EUR";
    const r = res();
    await startTopAction(post("google_ads", "create_new_ad", { request_id: "req-12345678", inputs: g }), r as never);
    expect(r._status).toBe(409);
    expect(JSON.stringify(r._body)).toContain("US dollars");
    expect(h.start).not.toHaveBeenCalled();
    currency.code = "USD";
    const ok = res();
    await startTopAction(post("google_ads", "create_new_ad", { request_id: "req-12345679", inputs: g }), ok as never);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("refuses a Google create when the account currency cannot be read (fails closed, no paid run)", async () => {
    const g = { about: "Spring offer", link: "https://example.com/o", goal: "visit", daily_budget: 20, places: [{ id: "2276", name: "Germany" }] };
    currency.code = "";
    const r = res();
    await startTopAction(post("google_ads", "create_new_ad", { request_id: "req-12345680", inputs: g }), r as never);
    expect(r._status).toBe(409);
    expect(JSON.stringify(r._body)).toContain("could not read");
    expect(h.start).not.toHaveBeenCalled();
    currency.code = "USD";
  });

  it("starts the channel run with a server-built top_action", async () => {
    const r = res();
    await startTopAction(post("meta_ads", "create_new_ad", { request_id: "req-12345678", inputs }), r as never);
    expect(r._body).toEqual({ ok: true, run_id: RUN });
    const [, auth, slug, opts] = h.start.mock.calls[0];
    expect(auth.tenant_id).toBe(TENANT);
    expect(slug).toBe("meta_ads");
    expect(opts.requestId).toBe("req-12345678");
    expect(opts.topAction).toMatchObject({ key: "create_new_ad", inputs, by: USER });
    expect(opts.topAction.instruction).toMatch(/Create new ad/);
  });

  it("404s an unknown channel or action", async () => {
    for (const [slug, key] of [["meta_ads", "nope"], ["pinterest_ads", "create_new_ad"], ["meta_ads", "__proto__"]]) {
      const r = res();
      await startTopAction(post(slug, key, { request_id: "req-12345678", inputs }), r as never);
      expect(r._status).toBe(404);
    }
    expect(h.start).not.toHaveBeenCalled();
  });

  it("400s bad inputs (Message me is not a goal; the link is required)", async () => {
    for (const bad of [{ ...inputs, goal: "message" }, { ...inputs, link: undefined }, { ...inputs, daily_budget: -1 }]) {
      const r = res();
      await startTopAction(post("meta_ads", "create_new_ad", { request_id: "req-12345678", inputs: bad }), r as never);
      expect(r._status).toBe(400);
    }
    const r = res();
    await startTopAction(post("meta_ads", "create_new_ad", { inputs }), r as never);
    expect(r._status).toBe(400);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("refuses a tenant-override session and a non-owner", async () => {
    authResult = { tenant_id: TENANT, user_id: USER, access_token: "t", tenant_overridden: true };
    const a = res();
    await startTopAction(post("meta_ads", "create_new_ad", { request_id: "req-12345678", inputs }), a as never);
    expect(a._status).toBe(403);
    authResult = { tenant_id: TENANT, user_id: USER, access_token: "t" };
    roleAllowed = false;
    const b = res();
    await startTopAction(post("meta_ads", "create_new_ad", { request_id: "req-12345678", inputs }), b as never);
    expect(b._status).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("GET /api/channels/:slug/top-actions/runs/:run_id", () => {
  const get = (slug: string, run_id = RUN) => ({ params: { slug, run_id } }) as unknown as Request;

  it("returns the run's status and the cards it filed, tenant-scoped", async () => {
    const r = res();
    await topActionRun(get("meta_ads"), r as never);
    expect(r._body).toEqual({ status: "running", actions: [{ id: "a1", title: "New ad" }], summary: null, note: null });
    expect(h.tenantFor).toEqual([TENANT]);
    expect(h.list).toHaveBeenCalledWith(TENANT, RUN, "meta_ads");
  });

  it("a finished run that filed nothing new returns its own short summary", async () => {
    h.runRow = { status: "success", channel_slug: "meta_ads", output_text: "**Done.** A new ad for this offer is <b>already</b> waiting for your approval." };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("meta_ads"), r as never);
    expect(r._body).toEqual({
      status: "success",
      actions: [],
      summary: "Done. A new ad for this offer is already waiting for your approval.",
      note: "Done. A new ad for this offer is already waiting for your approval.",
    });
  });

  it("a long run that ends by asking for facts keeps the ask, not the preamble", async () => {
    const preamble = "I read the brief and looked for creators who could fit this offer. ".repeat(12);
    const ask = "Before I name anyone, send me the bakery's site address, the town, and your first-test ceiling?";
    h.runRow = { status: "success", channel_slug: "ugc", output_text: `## What I did\n\n${preamble}\n\n**${ask}**` };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("ugc"), r as never);
    const summary = (r._body as { summary: string }).summary;
    expect(summary.endsWith(ask)).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary.startsWith("…")).toBe(true);
    expect(summary).toMatch(/^…[A-Z]/);
    expect(h.list).toHaveBeenCalledWith(TENANT, RUN, "ugc");
  });

  it("a failed run returns no summary", async () => {
    h.runRow = { status: "parse_failed", channel_slug: "meta_ads", output_text: "partial" };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("meta_ads"), r as never);
    expect((r._body as { summary: unknown }).summary).toBeNull();
  });

  it("404s another tenant's run, another channel's run, and a member who may not read it", async () => {
    h.runRow = null;
    const a = res();
    await topActionRun(get("meta_ads"), a as never);
    expect(a._status).toBe(404);
    h.runRow = { status: "success", channel_slug: "google_ads" };
    const b = res();
    await topActionRun(get("meta_ads"), b as never);
    expect(b._status).toBe(404);
    h.runRow = { status: "success", channel_slug: "meta_ads" };
    h.canRead.mockResolvedValue(false);
    const c = res();
    await topActionRun(get("meta_ads"), c as never);
    expect(c._status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe("runSummary", () => {
  it("a long run that asks nothing keeps its opening line, not a trailing sources list", () => {
    const text = `Done. A new ad is waiting for your approval. ${"Detail sentence. ".repeat(40)}Sources: https://a.example, https://b.example`;
    const out = runSummary(text)!;
    expect(out.startsWith("Done. A new ad is waiting")).toBe(true);
    expect(out).not.toContain("Sources:");
    expect(out.length).toBeLessThanOrEqual(400);
  });
});

const LINKEDIN_OUTPUT = [
  "## What I read",
  "",
  "Mode: linked. Ad account 559880687, \"Developer's Ad Account\" (USD, ACTIVE), returned 1 campaign for the last 30 days.",
  "",
  "**Totals:** 0 impressions, 0 clicks, $0 spend, 0 conversions. The campaign is a draft that never ran, so there is nothing to judge yet.",
  "",
  "Your buyer is a fleet manager at a 50 to 500 person logistics company, which LinkedIn can target by job title and company size. The next step is to launch the draft at $40 a day for two weeks and read the cost per lead on Nov 18.",
  "",
  "I filed no new card because the launch card from the last run is still waiting for your approval in the list.",
].join("\n");

describe("the drawer's note for a LinkedIn Ads run that filed nothing", () => {
  const get = (slug: string) => ({ params: { slug, run_id: RUN } }) as unknown as Request;
  it("serves the whole note, so Show all reaches the last sentence", async () => {
    h.runRow = { status: "success", channel_slug: "linkedin_ads", output_text: LINKEDIN_OUTPUT };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("linkedin_ads"), r as never);
    const body = r._body as { summary: string; note: string };
    expect(body.note.length).toBeGreaterThan(400);
    expect(body.note).toContain("0 impressions, 0 clicks, $0 spend, 0 conversions.");
    expect(body.note.endsWith("is still waiting for your approval in the list.")).toBe(true);
    expect(body.note).not.toContain("…");
    expect(h.list).toHaveBeenCalledWith(TENANT, RUN, "linkedin_ads");
  });

  it("names the account in plain words: no mode tag, no account number, no currency or status code", async () => {
    h.runRow = { status: "success", channel_slug: "linkedin_ads", output_text: LINKEDIN_OUTPUT };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("linkedin_ads"), r as never);
    const body = r._body as { summary: string; note: string };
    expect(body.summary.startsWith("What I read. Developer's Ad Account, returned 1 campaign")).toBe(true);
    expect(body.note.startsWith("What I read.\n\nDeveloper's Ad Account, returned 1 campaign")).toBe(true);
    for (const text of [body.note, body.summary]) {
      expect(text).not.toMatch(/\bmode\b/i);
      expect(text).not.toContain("559880687");
      expect(text).not.toContain("ACTIVE");
      expect(text).not.toContain("(USD");
    }
  });

  it("a short summary ends on a whole sentence, never mid-number", async () => {
    h.runRow = { status: "success", channel_slug: "linkedin_ads", output_text: LINKEDIN_OUTPUT };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("linkedin_ads"), r as never);
    const { summary } = r._body as { summary: string };
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toMatch(/[.!?]$/);
    expect(summary).not.toContain("…");
    expect(summary).toContain("0 impressions, 0 clicks, $0 spend, 0 conversions.");
  });

  it("a failed run serves no note", async () => {
    h.runRow = { status: "failed", channel_slug: "linkedin_ads", output_text: LINKEDIN_OUTPUT };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(get("linkedin_ads"), r as never);
    expect((r._body as { note: unknown }).note).toBeNull();
  });
});

describe("runNote account wording", () => {
  it("rewrites every shape a run uses to cite an account, and leaves other numbers alone", () => {
    const li = (t: string) => runNote(t, "linkedin_ads");
    expect(li("Mode: account-blind. No ad account is connected.")).toBe("No ad account is connected.");
    expect(li("Read \u201cAcme Ads\u201d (EUR, ACTIVE) for 30 days.")).toBe("Read Acme Ads for 30 days.");
    expect(li("Spend on ad account 559880687 was $0.")).toBe("Spend on the ad account was $0.");
    expect(li("Spend on an ad account 1234567890 was $0.")).toBe("Spend on an ad account was $0.");
    expect(li("Acme Ads (account id 559880687) ran 2 campaigns.")).toBe("Acme Ads ran 2 campaigns.");
    expect(li("Budget is $20000 (20000 impressions) on 12 campaigns.")).toBe("Budget is $20000 (20000 impressions) on 12 campaigns.");
  });

  it("leaves another channel's words exactly as the run wrote them", async () => {
    const META = "spend on an ad account 1234567890 was $0, and mode: linked is how the account is set. Ad account 559880687, \"Acme\" (USD, ACTIVE) ran.";
    expect(runNote(META, "meta_ads")).toBe(META);
    expect(runSummary(META, "meta_ads")).toBe(META);
    h.runRow = { status: "success", channel_slug: "meta_ads", output_text: META };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(({ params: { slug: "meta_ads", run_id: RUN } }) as unknown as Request, r as never);
    expect(r._body).toMatchObject({ summary: META, note: META });
  });

  it("a long note with no sentence end in the first 400 chars cuts at a word, not inside a number", () => {
    const text = `${"0 clicks, $0 spend, 1234567 impressions, ".repeat(12)}done.`;
    const out = runSummary(text)!;
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith("…")).toBe(true);
    const lastToken = out.slice(0, -1).split(" ").pop()!;
    expect(["0", "clicks", "$0", "spend", "1234567", "impressions"]).toContain(lastToken);
  });
});

describe("where a long summary or note is cut", () => {
  it("an early sentence end does not swallow the rest: a run-on after 'Done.' is cut at a word", () => {
    const text = `Done. ${"the launch card stays in the list while spend and clicks are read again each morning ".repeat(6)}end.`;
    const out = runSummary(text)!;
    expect(out).not.toBe("Done.");
    expect(out.length).toBeGreaterThan(300);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith("\u2026")).toBe(true);
  });

  it("an abbreviation is not a sentence end", () => {
    const lead = "the launch card stays in the list while spend and clicks are read again ".repeat(4);
    for (const abbr of ["e.g.", "i.e.", "Nov.", "etc.", "vs.", "U.S."]) {
      const text = `${lead}${abbr} ${"more words follow here without any stop at all ".repeat(5)}`;
      const out = runSummary(text)!;
      expect(out.endsWith(abbr)).toBe(false);
      expect(out.endsWith("\u2026")).toBe(true);
    }
  });

  it("a real sentence end past the first half is kept", () => {
    const first = `${"Spend and clicks were read for the last thirty days on every campaign ".repeat(4).trim()}.`;
    const text = `${first} ${"more words follow here without any stop at all ".repeat(6)}`;
    expect(runSummary(text)).toBe(first);
  });

  it("the note is capped near 4000 chars and ends on a sentence", () => {
    const text = "Clicks held at zero on the draft campaign this week. ".repeat(200);
    const note = runNote(text)!;
    expect(text.length).toBeGreaterThan(10000);
    expect(note.length).toBeLessThanOrEqual(4000);
    expect(note.length).toBeGreaterThan(3900);
    expect(note.endsWith("this week.")).toBe(true);
  });

  it("a heading or paragraph break ends a sentence instead of running into the next", () => {
    const text = "## What I read\nThe account had 0 clicks\n\n### Next step\n\nLaunch the draft at $40 a day\n\nIt is waiting for you.";
    expect(runSummary(text)).toBe("What I read. The account had 0 clicks. Next step. Launch the draft at $40 a day. It is waiting for you.");
    expect(runNote(text)).toBe("What I read.\n\nThe account had 0 clicks.\n\nNext step.\n\nLaunch the draft at $40 a day.\n\nIt is waiting for you.");
  });
});

describe("the last run note keeps the run's shape and its words", () => {
  const RUN_TEXT = [
    "## What changed",
    "",
    "The **draft** is _still_ paused. Spend held at $0",
    "and clicks at 0.",
    "",
    "Next steps:",
    "- Launch the draft at $40 a day",
    "- Point the ad at https://acme.com/book_demo?utm_source=li_ads",
    "  so demo signups are counted",
    "1. Read cost per lead on Nov 18",
    "",
    "> Zavi will not spend without your approval.",
    "",
    "| Campaign | Spend | Clicks |",
    "|---|---:|---|",
    "| Fleet_Q4 | $0 | 0 |",
    "| Ops leads | $12 | 3 |",
  ].join("\n");

  it("keeps paragraph and list breaks for the page to render", () => {
    expect(runNote(RUN_TEXT, "linkedin_ads")).toBe([
      "What changed.",
      "",
      "The draft is still paused. Spend held at $0 and clicks at 0.",
      "",
      "Next steps:",
      "",
      "- Launch the draft at $40 a day",
      "- Point the ad at https://acme.com/book_demo?utm_source=li_ads so demo signups are counted",
      "1. Read cost per lead on Nov 18",
      "",
      "Zavi will not spend without your approval.",
      "",
      "- Campaign: Fleet_Q4, Spend: $0, Clicks: 0",
      "- Campaign: Ops leads, Spend: $12, Clicks: 3",
    ].join("\n"));
  });

  it("the one-line summary reads the same words without markdown", () => {
    const summary = runSummary(RUN_TEXT, "meta_ads")!;
    expect(summary).not.toMatch(/[\n|>#*]/);
    expect(summary).toContain("https://acme.com/book_demo?utm_source=li_ads so demo signups are counted.");
    expect(summary).toContain("Campaign: Fleet_Q4, Spend: $0, Clicks: 0.");
    expect(summary.startsWith("What changed. The draft is still paused.")).toBe(true);
  });

  it("serves the shaped note from the run route", async () => {
    h.runRow = { status: "success", channel_slug: "linkedin_ads", output_text: RUN_TEXT };
    h.list.mockResolvedValue([]);
    const r = res();
    await topActionRun(({ params: { slug: "linkedin_ads", run_id: RUN } }) as unknown as Request, r as never);
    const { note } = r._body as { note: string };
    expect(note).toContain("\n- Launch the draft at $40 a day\n");
    expect(note).toContain("book_demo");
  });
});
