import type { Request, Response } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const ZLIST = "9b2f0c2e-0000-4000-8000-0000000000aa";
const RUN = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({
  role: true as boolean | "throw",
  enqueue: vi.fn(),
  start: vi.fn(),
  inngestSend: vi.fn(),
  rpc: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  railRead: { data: null, error: null } as { data: unknown; error: { message: string } | null },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: USER, access_token: "t" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (h.role === "throw") throw new Error("tenant_users role read failed: connection reset");
    if (h.role) return true;
    res.status(403).json({ error: { code: "forbidden_role" } });
    return false;
  }),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: h.enqueue, canCurrentUserReadRun: vi.fn() }));
vi.mock("@/routes/channels/run", () => ({ startChannelRun: h.start }));
vi.mock("@/../workers/client", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: h.rpc,
  tenantClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        h.inserts.push({ table, row });
        return { select: async () => ({ data: [{ id: RUN }], error: null }) };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => h.railRead }) }),
    }),
  }),
}));

import { makePostEmailPasteHandler } from "../paste";
import { LIVE_PASTE_DEPS, PASTE_BUTTON_LABEL, pastedContent, pastedParagraphs, pasteRationale, type PasteDeps } from "@/services/email-cards/paste";
import { LIVE_PROPOSE_CAMPAIGN_DEPS, makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { emailSendBodySchema, parseEmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { buildEmailSendCardBody } from "@/services/tools/email-campaign/_exec-action";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { UNSUBSCRIBE_HREF, type EmailTemplate } from "@/services/email-templates/render";
import { shaOf, testListKey } from "@/services/email-cards/variants";
import type { ListSummary } from "@/services/comms/bulk-outbound/lists";
import type { TierDecision } from "@/services/agents/entitlement";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);

const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#1a73e8",
  button_color: "#0b8043",
  font_key: "system",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};

const BODY = "Hi there,\n\nWe shipped shared workspaces today. Read the notes at https://brightloop.test/changelog.\n\nThanks for building with us.";

type Emitted = { cls: string; body: Record<string, unknown>; run_id: string };

function harness(over: { tool?: Partial<ProposeCampaignDeps>; tier?: Partial<TierDecision>; locked?: boolean } = {}) {
  const sg = fakeSendgrid();
  const emitted: Emitted[] = [];
  const rpcEmitted: Emitted[] = [];
  const toolSpy = {
    template: vi.fn(async () => TEMPLATE),
    testLists: vi.fn(async () => new Set<string>()),
    reserveCard: vi.fn(async () => ({ ok: true as const, id: "res-1" })),
  };
  const tool: Partial<ProposeCampaignDeps> = {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as ProposeCampaignDeps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: toolSpy.template,
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: toolSpy.testLists,
    setting: async () => null,
    railOf: async () => "channel_actions",
    replaceCard: async () => true,
    now: () => new Date("2026-10-20T12:00:00Z"),
    reserveCard: toolSpy.reserveCard,
    releaseCard: async () => {},
    settleCard: async () => {},
    checkSender: (async () => ({ ok: true, sender: { from_address: "news@brightloop.test" } })) as unknown as ProposeCampaignDeps["checkSender"],
    lists: (async () =>
      [
        {
          id: ZLIST,
          name: "Clinic patients",
          needs_consent: false,
          active: { id: "ver-1", sendable: 40, unsubscribed_or_bounced: 0, source_kind: "csv" },
        } as unknown as ListSummary,
      ]) as unknown as ProposeCampaignDeps["lists"],
    source: (() => ({
      async fetchCandidates() {
        return [
          { email: "a@x.test", opt_in_marketing: true },
          { email: "b@x.test", opt_in_marketing: true },
        ];
      },
    })) as unknown as ProposeCampaignDeps["source"],
    replyTo: async () => null,
    ...over.tool,
  };
  const deps: Partial<PasteDeps> = {
    tool,
    website: async () => "www.brightloop.test",
    insertRun: LIVE_PASTE_DEPS.insertRun,
    now: () => new Date("2026-10-20T12:00:00Z"),
    resolveCardEmit: vi.fn(async (ctx) => {
      expect(ctx.emit_decision).toBeTypeOf("function");
      return async (cls: string, body: unknown) => {
        emitted.push({ cls, body: body as Record<string, unknown>, run_id: ctx.run_id as string });
        return "card-sg-1";
      };
    }),
    emitDecisionRpc: vi.fn(async (_t: string, run_id: string, cls: string, body: unknown) => {
      rpcEmitted.push({ cls, body: body as Record<string, unknown>, run_id });
      return "dec-z-1";
    }),
  };
  const tierCheck = vi.fn(async () => ({ enforced: true, tier: "pro", required_tier: "pro", allowed: true, ...over.tier }) as TierDecision);
  const lockCheck = vi.fn(async (_slug: string) => over.locked === true);
  const handler = makePostEmailPasteHandler(deps, tierCheck, lockCheck);
  return { handler, emitted, rpcEmitted, deps, toolSpy, tierCheck, lockCheck, sg };
}

function res() {
  const r = {
    _status: 200,
    _body: undefined as unknown,
    _releasedAtSend: undefined as unknown,
    locals: {} as Record<string, unknown>,
    status(n: number) {
      r._status = n;
      return r;
    },
    json(b: unknown) {
      r._body = b;
      r._releasedAtSend = r.locals.idempotencyRelease;
      return r;
    },
  };
  return r;
}

const post = (inputs: unknown) => ({ params: {}, body: { inputs } }) as unknown as Request;

async function call(hx: ReturnType<typeof harness>, inputs: unknown) {
  const r = res();
  await hx.handler(post(inputs), r as unknown as Response);
  return r;
}

const sgPaste = (over: Record<string, unknown> = {}) => ({ route: "sendgrid", list_id: SG_LIST, pasted: { subject: "Shared workspaces are here", preview_text: "Out today", body: BODY }, ...over });

function noAgentRunAndNoCredits() {
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.inngestSend).not.toHaveBeenCalled();
  expect(h.rpc.mock.calls.map((c) => c[1])).not.toContain("reserve_run_credits");
  for (const i of h.inserts.filter((x) => x.table === "agent_runs")) {
    expect(["queued", "running", "blocked"]).not.toContain(i.row.status);
  }
}

function newestReserveTrigger(): string {
  const dir = join(__dirname, "../../../../../../supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const body = files
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .filter((s) => s.includes("function _trg_reserve_run_credits()"))
    .pop()!;
  const start = body.indexOf("function _trg_reserve_run_credits()");
  return body.slice(start, body.indexOf("end $$;", start));
}

beforeEach(() => {
  h.role = true;
  h.enqueue.mockReset();
  h.start.mockReset();
  h.inngestSend.mockReset();
  h.rpc.mockReset();
  h.inserts.length = 0;
  h.railRead = { data: null, error: null };
});

describe("POST /api/email-cards/paste files the founder's email with no agent run", () => {
  it("files exactly one card with the pasted email rendered, sealed and checked, and starts no run and reserves no credits", async () => {
    const hx = harness();
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, card: { rail: "channel_actions", id: "card-sg-1" }, link: "/workspace/email-cards/channel_actions/card-sg-1", route: "sendgrid", versions: 1 });
    expect(hx.emitted).toHaveLength(1);
    expect(hx.rpcEmitted).toHaveLength(0);
    const { cls, body, run_id } = hx.emitted[0];
    expect(cls).toBe("email_campaign.create_and_send");
    expect(run_id).toBe(RUN);
    const { rationale, ...sealedBody } = body;
    expect(rationale).toBe("You wrote this email and pasted it in. Zavi kept your words as written, put your subject at the top as the heading, and added a Read more button that goes to the first https link in your email, https://brightloop.test/changelog. Check both in your test send.");
    expect(emailSendBodySchema.strict().safeParse(sealedBody).success).toBe(true);
    const parsed = parseEmailSendBody(sealedBody)!;
    expect(parsed.audience_id).toBe(SG_LIST);
    expect(parsed.variants).toHaveLength(1);
    const v = parsed.variants![0];
    expect(v.content).toEqual({
      subject: "Shared workspaces are here",
      preview_text: "Out today",
      title: "Shared workspaces are here",
      paragraphs: ["Hi there,", "We shipped shared workspaces today. Read the notes at https://brightloop.test/changelog.", "Thanks for building with us."],
      button: { label: PASTE_BUTTON_LABEL, url: "https://brightloop.test/changelog" },
    });
    expect(v.html).toContain("We shipped shared workspaces today.");
    expect(v.html).toContain("12 Harbor Way, Portland OR 97201");
    expect(v.html).toContain(UNSUBSCRIBE_HREF.sendgrid);
    expect(v.html).toContain("utm_campaign=");
    expect(v.render_sha).toBe(shaOf(parsed.renderer_version!, v.html, v.text));
    expect(buildEmailSendCardBody(parsed, null).title).toBe('Send "Shared workspaces are here" to Brightloop members');
    expect(hx.toolSpy.reserveCard).toHaveBeenCalledTimes(1);
    expect(hx.toolSpy.reserveCard).toHaveBeenCalledWith(TENANT, null);
    const runs = h.inserts.filter((x) => x.table === "agent_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0].row).toMatchObject({ agent_slug: "email_marketing", channel_slug: "email_marketing", status: "success", cost_usd: 0, cost_tokens: 0 });
    noAgentRunAndNoCredits();
    const trigger = newestReserveTrigger();
    expect(trigger).toMatch(/if NEW\.status in \('queued', 'running'\) then\s+perform reserve_run_credits/);
    expect(trigger).not.toMatch(/'success'\s*\)\s*then\s+perform reserve_run_credits/);
  });

  it("files a Zavi list paste on the decisions rail with the paste's own record run, and nothing else", async () => {
    const hx = harness();
    const r = await call(hx, { route: "zavi_list", list_id: ZLIST, pasted: { subject: "Flu shots this week", body: "Walk in any day this week for a flu shot.\n\nNo appointment needed." } });
    expect(r._status).toBe(200);
    expect(r._body).toMatchObject({ ok: true, card: { rail: "decisions", id: "dec-z-1" }, link: "/workspace/email-cards/decisions/dec-z-1", route: "zavi_list" });
    expect(hx.emitted).toHaveLength(0);
    expect(hx.rpcEmitted).toHaveLength(1);
    expect(hx.rpcEmitted[0]).toMatchObject({ cls: "bulk_outbound.send", run_id: RUN });
    const v = (hx.rpcEmitted[0].body.variants as Array<{ content: Record<string, unknown>; html: string }>)[0];
    expect(v.content.paragraphs).toEqual(["Walk in any day this week for a flu shot.", "No appointment needed."]);
    expect(v.content.preview_text).toBe("");
    expect(v.content.button).toEqual({ label: PASTE_BUTTON_LABEL, url: "https://www.brightloop.test" });
    expect(hx.rpcEmitted[0].body.rationale).toBe("You wrote this email and pasted it in. Zavi kept your words as written, put your subject at the top as the heading, and added a Read more button that goes to your website, https://www.brightloop.test. Check both in your test send.");
    expect(v.html).toContain(UNSUBSCRIBE_HREF.zavi_list);
    noAgentRunAndNoCredits();
  });

  it("keeps a long paste word for word within the card's paragraph limits", async () => {
    const blocks = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the founder's own words.`);
    const long = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const body = [...blocks, long].join("\n\n");
    const hx = harness();
    const r = await call(hx, sgPaste({ pasted: { subject: "A long one", body } }));
    expect(r._status).toBe(200);
    const paragraphs = (hx.emitted[0].body.variants as Array<{ content: { paragraphs: string[] } }>)[0].content.paragraphs;
    expect(paragraphs.length).toBeLessThanOrEqual(20);
    for (const p of paragraphs) expect(p.length).toBeLessThanOrEqual(5000);
    expect(paragraphs.join(" ").replace(/\s+/g, " ")).toBe(body.replace(/\s+/g, " "));
    expect(pastedParagraphs("a b\r\n\r\nc")).toEqual(["a b", "c"]);
  });

  it("refuses a list marked as a test list, files nothing and leaves the key free to retry", async () => {
    const hx = harness();
    hx.toolSpy.testLists.mockResolvedValue(new Set([testListKey("sendgrid", SG_LIST)]));
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(409);
    expect(r._body).toMatchObject({ error: { code: "email_test_list" } });
    expect(hx.emitted).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    expect(r.locals.idempotencyRelease).toBe(true);
    noAgentRunAndNoCredits();
  });

  it("at the daily card limit the founder gets plain words, not the agent's instruction", async () => {
    for (const code of ["tenant_cap", "run_cap"] as const) {
      const hx = harness({ tool: { reserveCard: async () => ({ ok: false, code, count: 20 }) } });
      const r = await call(hx, sgPaste());
      expect(r._status).toBe(409);
      const err = (r._body as { error: { code: string; message: string } }).error;
      expect(err.code).toBe("email_card_cap_reached");
      expect(err.message).toBe("Zavi already put the most emails it may up for approval in one day. Try again tomorrow.");
      expect(err.message).not.toMatch(/stop proposing/i);
      expect(err.message).not.toMatch(/summaris/i);
      expect(err.message).not.toMatch(/nothing was proposed/i);
      expect(r._releasedAtSend).toBe(true);
      expect(h.inserts.filter((x) => x.table === "agent_runs")).toHaveLength(0);
      expect(hx.emitted).toHaveLength(0);
    }
  });

  it("refuses a member who is not an owner or admin before reading anything", async () => {
    h.role = false;
    const hx = harness();
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(403);
    expect(hx.tierCheck).not.toHaveBeenCalled();
    expect(hx.toolSpy.template).not.toHaveBeenCalled();
    expect(hx.toolSpy.reserveCard).not.toHaveBeenCalled();
    expect(hx.emitted).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    noAgentRunAndNoCredits();
  });

  it("a refused role is already marked to release the key when the 403 goes out, so a retry after a promotion runs", async () => {
    h.role = false;
    const r = await call(harness(), sgPaste());
    expect(r._status).toBe(403);
    expect(r._releasedAtSend).toBe(true);
  });

  it("a role read that throws answers 503 and releases the key instead of hanging", async () => {
    h.role = "throw";
    const hx = harness();
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(503);
    expect(r._body).toMatchObject({ error: { code: "role_unreadable" } });
    expect(r._releasedAtSend).toBe(true);
    expect(hx.tierCheck).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it("an allowed role does not leave the key marked for release, so a filed card is stored against it", async () => {
    const r = await call(harness(), sgPaste());
    expect(r._status).toBe(200);
    expect(r._releasedAtSend).not.toBe(true);
  });

  it("a plain failure before anything is written answers 500 and releases the key", async () => {
    const hx = harness({ tool: { template: async () => { throw new Error("email_templates read failed"); } } });
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(500);
    expect(r._body).toMatchObject({ error: { code: "paste_failed" } });
    expect(r._releasedAtSend).toBe(true);
    expect(h.inserts).toHaveLength(0);
  });

  it("a plain failure after the record run was written answers 500 and keeps the key, so a retry cannot file it twice", async () => {
    const hx = harness();
    (hx.deps as PasteDeps).resolveCardEmit = vi.fn(async () => async () => {
      throw new Error("decision insert timed out");
    }) as unknown as PasteDeps["resolveCardEmit"];
    const handler = makePostEmailPasteHandler(hx.deps, hx.tierCheck, hx.lockCheck);
    const r = res();
    await handler(post(sgPaste()), r as unknown as Response);
    expect(r._status).toBe(500);
    expect(r._body).toMatchObject({ error: { code: "paste_failed" } });
    expect(r._releasedAtSend).not.toBe(true);
    expect(h.inserts.filter((x) => x.table === "agent_runs")).toHaveLength(1);
  });

  it("a record run insert that fails answers 500 with nothing filed and releases the key, so a retry can file it", async () => {
    const hx = harness();
    const insertRun = vi.fn(async () => {
      throw new Error("email paste run: insert failed: connection reset");
    });
    (hx.deps as PasteDeps).insertRun = insertRun;
    const handler = makePostEmailPasteHandler(hx.deps, hx.tierCheck, hx.lockCheck);
    const r = res();
    await handler(post(sgPaste()), r as unknown as Response);
    expect(insertRun).toHaveBeenCalledTimes(1);
    expect(r._status).toBe(500);
    expect(r._body).toMatchObject({ error: { code: "paste_failed" } });
    expect(r._releasedAtSend).toBe(true);
    expect(hx.emitted).toHaveLength(0);
    expect(hx.rpcEmitted).toHaveLength(0);
  });

  it("the service reports nothing written when the record run insert fails", async () => {
    const hx = harness();
    const { filePastedEmail } = await import("@/services/email-cards/paste");
    const out = await filePastedEmail(TENANT, sgPaste(), {
      ...hx.deps,
      insertRun: async () => {
        throw new Error("insert failed");
      },
    });
    expect(out).toMatchObject({ ok: false, code: "paste_failed", wrote: false });
    expect((out as { message: string }).message).toContain("Nothing was filed");
  });

  it.each(["\u0085", "\u009b", "\u2028", "\u2029"])("a subject or preview with the line-breaking character %j is refused as not on one line, before anything is filed", async (ch) => {
    for (const pasted of [
      { subject: `Shared${ch}workspaces`, body: BODY },
      { subject: "Shared workspaces", preview_text: `Out${ch}today`, body: BODY },
    ]) {
      const hx = harness();
      const r = await call(hx, sgPaste({ pasted }));
      expect(r._status).toBe(400);
      expect(r._body).toMatchObject({ error: { code: "validation" } });
      expect((r._body as { error: { message: string } }).error.message).toMatch(/one line/);
      expect(r._releasedAtSend).toBe(true);
      expect(hx.emitted).toHaveLength(0);
    }
    expect(h.inserts).toHaveLength(0);
  });

  it("a first link longer than a button can hold sends the button to the company website instead, and the card still files", async () => {
    const huge = `https://brightloop.test/changelog?ref=${"a".repeat(2100)}`;
    const hx = harness();
    const r = await call(hx, sgPaste({ pasted: { subject: "Shared workspaces are here", body: `Read the notes at ${huge} today.\n\nThanks for building with us.` } }));
    expect(r._status).toBe(200);
    const v = (hx.emitted[0].body.variants as Array<{ content: { button: { url: string }; paragraphs: string[] } }>)[0];
    expect(v.content.button.url).toBe("https://www.brightloop.test");
    expect(hx.emitted[0].body.rationale).toMatch(/Read more button that goes to your website, https:\/\/www\.brightloop\.test\. /);
    expect(hx.emitted[0].body.rationale).not.toMatch(/word for word|no https link/i);
    expect(v.content.paragraphs[0]).toContain(huge);
  });

  it("a long first link with no website saved is refused as having nowhere for the button to go", async () => {
    const huge = `https://brightloop.test/changelog?ref=${"a".repeat(2100)}`;
    const hx = harness();
    (hx.deps as PasteDeps).website = async () => null;
    const r = await call(hx, sgPaste({ pasted: { subject: "Hi", body: `Read the notes at ${huge} today, please.` } }));
    expect(r._status).toBe(400);
    expect(r._body).toMatchObject({ error: { code: "email_button_link_missing" } });
    expect(h.inserts).toHaveLength(0);
  });

  it("a saved website longer than a button can hold is not used as the button", async () => {
    const { websiteButtonUrl } = await import("@/services/email-cards/paste");
    expect(websiteButtonUrl(`https://brightloop.test/${"p".repeat(2100)}`)).toBe("https://brightloop.test");
    expect(websiteButtonUrl("https://brightloop.test/pricing")).toBe("https://brightloop.test/pricing");
    expect(websiteButtonUrl(`${"x".repeat(2050)}.test`)).toBeNull();
  });

  it("refuses a workspace whose plan does not include Email campaigns", async () => {
    const hx = harness({ tier: { allowed: false, tier: "starter", required_tier: "pro" } });
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(403);
    expect(r._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "pro" } });
    expect(hx.toolSpy.reserveCard).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it("refuses while staff have locked Email campaigns, files nothing, writes no run, and releases the key", async () => {
    const hx = harness({ locked: true });
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(409);
    expect(r._body).toEqual({ error: { code: "coming_soon", message: "Email campaigns is not available right now." } });
    expect(r._releasedAtSend).toBe(true);
    expect(hx.lockCheck).toHaveBeenCalledWith("email_marketing");
    expect(hx.toolSpy.reserveCard).not.toHaveBeenCalled();
    expect(hx.toolSpy.template).not.toHaveBeenCalled();
    expect(hx.emitted).toHaveLength(0);
    expect(hx.rpcEmitted).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    expect(hx.sg.requests).toHaveLength(0);
  });

  it("an unlocked channel is checked and the paste still files", async () => {
    const hx = harness({ locked: false });
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(200);
    expect(hx.lockCheck).toHaveBeenCalledWith("email_marketing");
    expect(hx.emitted).toHaveLength(1);
  });

  it("refuses content that fails the render checks: no postal address, or a link with a login in it", async () => {
    const noPostal = harness({ tool: { template: async () => ({ ...TEMPLATE, postal_address: null }) } });
    const a = await call(noPostal, sgPaste());
    expect(a._status).toBe(400);
    expect(a._body).toMatchObject({ error: { code: "email_render_missing_postal_address" } });
    expect(noPostal.emitted).toHaveLength(0);

    const badUrl = harness();
    const b = await call(badUrl, sgPaste({ pasted: { subject: "Hi", body: "Log in at https://admin:secret@brightloop.test/login to see it." } }));
    expect(b._status).toBe(400);
    expect(b._body).toMatchObject({ error: { code: "email_render_bad_url" } });
    expect(badUrl.emitted).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
    noAgentRunAndNoCredits();
  });

  it("refuses a brief (only a pasted email is free) and a paste with nowhere for the button to go", async () => {
    const hx = harness();
    const a = await call(hx, { route: "sendgrid", list_id: SG_LIST, brief: "Write about shared workspaces" });
    expect(a._status).toBe(400);
    expect(a._body).toMatchObject({ error: { code: "paste_required" } });
    const noLink = harness();
    (noLink.deps as PasteDeps).website = async () => null;
    const b = await makePostEmailPasteHandler(noLink.deps, noLink.tierCheck);
    const r2 = res();
    await b(post(sgPaste({ pasted: { subject: "Hi", body: "No links in this one, just words for you." } })), r2 as unknown as Response);
    expect(r2._status).toBe(400);
    expect(r2._body).toMatchObject({ error: { code: "email_button_link_missing" } });
    expect(h.inserts).toHaveLength(0);
    expect(hx.emitted).toHaveLength(0);
  });
});

describe("paste: the card's rail, its links and what is written before a writer exists", () => {
  it("opens the rail the card was written to, even when the rail read after the write says decisions", async () => {
    const hx = harness({ tool: { railOf: async () => "decisions" } });
    const r = await call(hx, sgPaste());
    expect(r._status).toBe(200);
    expect(r._body).toMatchObject({ card: { rail: "channel_actions", id: "card-sg-1" }, link: "/workspace/email-cards/channel_actions/card-sg-1" });
    expect(hx.emitted).toHaveLength(1);
  });

  it("a failed rail read is a failure, not a card on decisions, and the tool reads it again before guessing", async () => {
    h.railRead = { data: null, error: { message: "connection reset" } };
    await expect(LIVE_PROPOSE_CAMPAIGN_DEPS.railOf(TENANT, "card-sg-1")).rejects.toThrow(/connection reset/);
    h.railRead = { data: { id: "card-sg-1" }, error: null };
    await expect(LIVE_PROPOSE_CAMPAIGN_DEPS.railOf(TENANT, "card-sg-1")).resolves.toBe("channel_actions");
    h.railRead = { data: null, error: null };
    await expect(LIVE_PROPOSE_CAMPAIGN_DEPS.railOf(TENANT, "card-sg-1")).resolves.toBe("decisions");

    const hx = harness();
    const reads = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue("channel_actions");
    const tool = makeProposeCampaignTool({ ...(hx.deps.tool as Partial<ProposeCampaignDeps>), railOf: reads });
    const pasted = { subject: "Shared workspaces are here", body: BODY };
    const url = "https://brightloop.test/changelog";
    const out = (await tool.execute(
      { tenant_id: TENANT, log: () => {}, emit_decision: async () => "card-sg-1" },
      { route: "sendgrid", audience_id: SG_LIST, variants: [pastedContent(pasted, url)], rationale: pasteRationale(url, true) },
    )) as { card: { rail: string; id: string } };
    expect(out.card).toEqual({ rail: "channel_actions", id: "card-sg-1" });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("keeps brackets that belong to a link and drops the ones around it, on the button and in the body", async () => {
    const hx = harness();
    const body = "Hi there,\n\nRead https://en.wikipedia.org/wiki/Mercury_(planet). It is small (see https://brightloop.test/notes).";
    const r = await call(hx, sgPaste({ pasted: { subject: "Mercury", body } }));
    expect(r._status).toBe(200);
    const v = (hx.emitted[0].body.variants as Array<{ content: { button: { url: string } }; html: string }>)[0];
    expect(v.content.button.url).toBe("https://en.wikipedia.org/wiki/Mercury_(planet)");
    expect(v.html).toContain('href="https://en.wikipedia.org/wiki/Mercury_(planet)"');
    expect(v.html).toContain(">https://en.wikipedia.org/wiki/Mercury_(planet)</a>.");
    expect(v.html).toMatch(/href="https:\/\/brightloop\.test\/notes\?[^"]*"[^>]*>https:\/\/brightloop\.test\/notes<\/a>\)\./);
  });

  it("puts the button on an HTTPS link in capitals, the same links the body turns into links", async () => {
    const hx = harness();
    const r = await call(hx, sgPaste({ pasted: { subject: "Caps", body: "Our news is at HTTPS://brightloop.test/News today." } }));
    expect(r._status).toBe(200);
    const v = (hx.emitted[0].body.variants as Array<{ content: { button: { url: string } } }>)[0];
    expect(v.content.button.url).toBe("HTTPS://brightloop.test/News");
  });

  it("a first link too long to use does not hide the next valid link from the button", async () => {
    const hx = harness();
    const long = `https://brightloop.test/${"a".repeat(2100)}`;
    const r = await call(hx, sgPaste({ pasted: { subject: "Two links", body: `Old link ${long} and the real one https://brightloop.test/changelog here.` } }));
    expect(r._status).toBe(200);
    const v = (hx.emitted[0].body.variants as Array<{ content: { button: { url: string } } }>)[0];
    expect(v.content.button.url).toBe("https://brightloop.test/changelog");
  });

  it("with no card writer, writes no run and frees the key for a retry", async () => {
    const hx = harness();
    (hx.deps as Record<string, unknown>).resolveCardEmit = undefined;
    const handler = makePostEmailPasteHandler(hx.deps, hx.tierCheck, hx.lockCheck);
    const r = res();
    await handler(post(sgPaste()), r as unknown as Response);
    expect(r._status).not.toBe(200);
    expect(h.inserts.filter((x) => x.table === "agent_runs")).toHaveLength(0);
    expect(r.locals.idempotencyRelease).toBe(true);
    expect(hx.emitted).toHaveLength(0);
  });

  it("a writer that resolves to no card rail files nothing and frees the key", async () => {
    const hx = harness();
    (hx.deps as PasteDeps).resolveCardEmit = vi.fn(async () => undefined);
    const handler = makePostEmailPasteHandler(hx.deps, hx.tierCheck, hx.lockCheck);
    const r = res();
    await handler(post(sgPaste()), r as unknown as Response);
    expect(r._status).not.toBe(200);
    expect(r._body).toMatchObject({ error: { code: "email_card_rail_missing" } });
    expect(r.locals.idempotencyRelease).toBe(true);
  });
});
