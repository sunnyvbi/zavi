import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state, readiness } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null },
  readiness: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { changed: true, status: "approved" }, error: null });
    },
  }),
}));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({ resolvePinterestPublishReadiness: readiness }));
vi.mock("@/services/growth/move-group", () => ({ checkPairedLeg: async () => ({ kind: "go" }) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn() }));

import { decideOnDecision } from "../decide-service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const IMAGE = `${TENANT}/22222222-2222-4222-8222-222222222222.jpg`;
const PASS = { status: "pass" };
const base = () => ({ decision_id: "d-1", tenant_id: TENANT, action: "approve" as const, actor: { user_id: "u-1" } });
const flips = () => rpcCalls.filter((c) => c.fn === "approve_social_draft_as_actor" || c.fn.startsWith("decide_decision_as"));

function stored(checks: Record<string, unknown> = {}) {
  return { ok: true, checks: { board: PASS, media: PASS, link: PASS, identity: PASS, ...checks }, board: { id: "222", name: "Linen bedding", privacy: "PUBLIC" }, board_count: 2 };
}

function unverified(code: string, reason: string) {
  return { status: "unverified", reason_code: code, reason };
}

function pinRow(readinessBody: unknown = stored()) {
  return {
    id: "d-1",
    tenant_id: TENANT,
    status: "proposed",
    decision_class: "social.publish.v2",
    agent_run_id: null,
    body: {
      channel: "pinterest_pin",
      scheduled_at: null,
      readiness: readinessBody,
      payload: {
        title: "Linen duvet cover",
        text: "Stonewashed linen that softens with every wash.",
        image_path: IMAGE,
        board_id: "222",
        board_name: "Linen bedding",
        link: "https://acme.com/p/duvet",
      },
    },
  };
}

beforeEach(() => {
  rpcCalls.length = 0;
  readiness.mockReset();
  state.row = pinRow();
});

describe("approve with an edited pin title, board and link", () => {
  it("re-checks the edited board and link like staging, and approves the edited pin with the new board's name", async () => {
    const fresh = { ...stored(), board: { id: "333", name: "Gift ideas", privacy: "PUBLIC" } };
    readiness.mockResolvedValue(fresh);
    const r = await decideOnDecision({ ...base(), payload_edit: { title: "Linen duvet, sage", board_id: "333", link: "https://acme.com/p/duvet-sage" } });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(readiness).toHaveBeenCalledWith(TENANT, { board_id: "333", image_path: IMAGE, link: "https://acme.com/p/duvet-sage" });
    expect(flips()).toHaveLength(1);
    const body = flips()[0].args.p_body as { payload: Record<string, unknown>; readiness: unknown };
    expect(body.payload).toEqual({
      title: "Linen duvet, sage",
      text: "Stonewashed linen that softens with every wash.",
      image_path: IMAGE,
      board_id: "333",
      board_name: "Gift ideas",
      link: "https://acme.com/p/duvet-sage",
    });
    expect(body.readiness).toEqual(fresh);
    expect(flips()[0].args.p_expected_body).toEqual(pinRow().body);
  });

  it("refuses a board the readiness check turns down with its plain reason, and posts nothing", async () => {
    readiness.mockResolvedValue({
      ok: false,
      checks: { board: { status: "fail", reason_code: "pinterest_board_secret" }, media: PASS, link: PASS, identity: PASS },
      board: { id: "444", name: "Private", privacy: "SECRET" },
      board_count: 2,
      reason_code: "pinterest_board_secret",
      reason: "That board is secret, so nobody but you would see the pin.",
    });
    const r = await decideOnDecision({ ...base(), payload_edit: { board_id: "444" } });
    expect(r).toMatchObject({ ok: false, code: "invalid_edit", changed: false, detail: "That board is secret, so nobody but you would see the pin." });
    expect(flips()).toEqual([]);
  });

  it("refuses an edited link the site check fails (another company's site)", async () => {
    readiness.mockResolvedValue({ ...stored({ identity: { status: "fail", reason_code: "pinterest_identity_mismatch" } }), ok: false, reason: "The pin links to a site that is not your company's website." });
    const r = await decideOnDecision({ ...base(), payload_edit: { link: "https://other.example/p" } });
    expect(r).toMatchObject({ ok: false, code: "invalid_edit", detail: "The pin links to a site that is not your company's website." });
    expect(flips()).toEqual([]);
  });

  it("refuses a non-https link and a bad board id before any lookup", async () => {
    for (const link of ["http://acme.com/p", "acme.com/p", "https://", "javascript:alert(1)"]) {
      const r = await decideOnDecision({ ...base(), payload_edit: { link } });
      expect(r).toMatchObject({ ok: false, code: "invalid_edit", detail: "The pin link must be a full web address that starts with https://." });
    }
    expect(await decideOnDecision({ ...base(), payload_edit: { board_id: "abc" } })).toMatchObject({ ok: false, code: "invalid_edit", detail: "Pick one of your Pinterest boards." });
    expect(readiness).not.toHaveBeenCalled();
    expect(flips()).toEqual([]);
  });

  it("refuses an empty or over-100 title, and accepts exactly 100", async () => {
    for (const title of ["   ", "x".repeat(101)]) {
      expect(await decideOnDecision({ ...base(), payload_edit: { title } })).toMatchObject({ ok: false, code: "invalid_edit", detail: "The pin title must be 1 to 100 characters." });
    }
    expect(flips()).toEqual([]);
    const r = await decideOnDecision({ ...base(), payload_edit: { title: "y".repeat(100) } });
    expect(r.ok).toBe(true);
    expect((flips()[0].args.p_body as { payload: { title: string } }).payload.title).toBe("y".repeat(100));
  });

  it("a title-only edit keeps the board and its stored checks without a new lookup", async () => {
    const r = await decideOnDecision({ ...base(), payload_edit: { title: "New title" } });
    expect(r.ok).toBe(true);
    expect(readiness).not.toHaveBeenCalled();
    const body = flips()[0].args.p_body as { payload: Record<string, unknown>; readiness: unknown };
    expect(body.payload).toMatchObject({ title: "New title", board_id: "222", board_name: "Linen bedding" });
    expect(body.readiness).toEqual(stored());
  });

  it("a blank left in an edited title is refused without the old 'title can't be edited' line", async () => {
    const r = await decideOnDecision({ ...base(), payload_edit: { title: "Linen for [city]" } });
    expect(r).toMatchObject({ ok: false, code: "invalid_edit", detail: "Fill before publishing: [city]" });
    expect(flips()).toEqual([]);
  });

  it("refuses a title, board or link edit on a post that is not a pin", async () => {
    state.row = { ...pinRow(), body: { channel: "linkedin", payload: { text: "hi" }, scheduled_at: null } };
    for (const edit of [{ title: "t" }, { board_id: "1" }, { link: "https://acme.com" }]) {
      expect(await decideOnDecision({ ...base(), payload_edit: edit })).toMatchObject({ ok: false, code: "invalid_edit", detail: "Only a pin's title, board and link can be edited here." });
    }
    expect(flips()).toEqual([]);
  });
});

describe("a pin with an unverified check needs an explicit confirm to post", () => {
  const CASES: Array<[string, string, string]> = [
    ["identity", "pinterest_identity_unverified", "Your company website is not on file."],
    ["identity", "pinterest_identity_related", "The link is on a different address under the same domain."],
    ["link", "pinterest_link_unchecked", "Zavi could not open the page this pin links to."],
    ["link", "pinterest_link_partial", "The page this pin links to only partly loaded."],
  ];

  for (const [check, code, reason] of CASES) {
    it(`${code}: a plain approve is refused with the reason and nothing flips; confirming posts it`, async () => {
      state.row = pinRow(stored({ [check]: unverified(code, reason) }));
      const label = check === "identity" ? "Your site" : "Link";
      const r = await decideOnDecision(base());
      expect(r).toMatchObject({ ok: false, code: "requires_unverified_confirm", changed: false, status: "proposed", unverified: [`${label}: ${reason}`] });
      expect(r.detail).toBe(`Zavi could not check everything on this pin. ${label}: ${reason}`);
      expect(flips()).toEqual([]);
      const ok = await decideOnDecision({ ...base(), confirm_unverified: true });
      expect(ok).toMatchObject({ ok: true, changed: true });
      expect(flips()).toHaveLength(1);
    });
  }

  it("lists every unverified check", async () => {
    state.row = pinRow(stored({ link: unverified("pinterest_link_partial", "Partly loaded."), identity: unverified("pinterest_identity_unverified", "No website on file.") }));
    const r = await decideOnDecision(base());
    expect(r.unverified).toEqual(["Link: Partly loaded.", "Your site: No website on file."]);
  });

  it("a fully checked pin still approves with one click", async () => {
    const r = await decideOnDecision(base());
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(flips()).toHaveLength(1);
  });

  it("an edit whose fresh check comes back unverified is held for the confirm too", async () => {
    readiness.mockResolvedValue(stored({ identity: unverified("pinterest_identity_related", "Different address under your domain.") }));
    const r = await decideOnDecision({ ...base(), payload_edit: { link: "https://shop.acme.com/p" } });
    expect(r).toMatchObject({ ok: false, code: "requires_unverified_confirm", unverified: ["Your site: Different address under your domain."] });
    expect(flips()).toEqual([]);
    const ok = await decideOnDecision({ ...base(), payload_edit: { link: "https://shop.acme.com/p" }, confirm_unverified: true });
    expect(ok.ok).toBe(true);
    expect((flips()[0].args.p_body as { payload: { link: string } }).payload.link).toBe("https://shop.acme.com/p");
  });

  it("staff and cgo approvals cannot skip the confirm", async () => {
    state.row = pinRow(stored({ link: unverified("pinterest_link_unchecked", "Could not open it.") }));
    expect(await decideOnDecision({ ...base(), staff_override: true })).toMatchObject({ ok: false, code: "requires_unverified_confirm" });
    expect(await decideOnDecision({ ...base(), approver_source: "cgo" })).toMatchObject({ ok: false, code: "requires_unverified_confirm" });
    expect(flips()).toEqual([]);
  });

  it("reject is never held", async () => {
    state.row = pinRow(stored({ link: unverified("pinterest_link_unchecked", "Could not open it.") }));
    const r = await decideOnDecision({ ...base(), action: "reject" });
    expect(r.code).not.toBe("requires_unverified_confirm");
  });
});
