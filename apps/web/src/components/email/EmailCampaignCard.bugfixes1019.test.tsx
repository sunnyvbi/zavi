// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
type Answer = { status: number; body: unknown };
const answers: Record<string, Answer> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => (a.body instanceof Error ? Promise.reject(a.body) : Promise.resolve(a.body)) });
  },
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_o: { title: string; description?: string }) => true) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: confirm.fn }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { cardPoll, DISPATCH_UNKNOWN_LINE, DISPATCH_UNKNOWN_TITLE, EmailCampaignCard, KLAVIYO_TEST_LINE, PAUSED_LINE, RESUMED_LINE, type EmailCardRail, type EmailCardView } from "./EmailCampaignCard";

const ID = "33333333-3333-4333-8333-333333333333";
const base = (rail: EmailCardRail) => `/api/email-cards/${rail}/${ID}`;
const saved = { ...cardPoll };

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "bulk_outbound.send",
    status: "pending",
    open: true,
    route: "zavi_list",
    list: { name: "Test list 1016", people: 1 },
    sender: { email: "hello@brightloop.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: "", html: `<p>${n}</p>`, tested_by_me: true, tested_by_approver: true })),
    can_approve: [true, true],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET ${base(c.rail)}`] = { status: 200, body: { card: c } };
};
const reads = (rail: EmailCardRail = "decisions") => calls.filter((c) => c.method === "GET" && c.url === base(rail)).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const approved = (over: Partial<EmailCardView> = {}) => card({ open: false, status: "queued", chosen_variant: 1, can_approve: [false, false], ...over });

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  confirm.fn.mockClear();
  confirm.fn.mockResolvedValue(true);
  cardPoll.ms = 20;
  cardPoll.pausedMs = 20;
  cardPoll.dispatchingMs = saved.dispatchingMs;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.assign(cardPoll, saved);
});

describe("an email approved while email is paused", () => {
  it("says email is paused, never 'starting', and says it starts once email is resumed", async () => {
    serve(approved({ pause_hold: "paused" }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBe("Approved: A, email paused"));
    expect(screen.getByTestId("email-card-in-flight").textContent).toContain(PAUSED_LINE);
    expect(screen.getByTestId("email-card-in-flight").textContent).not.toMatch(/Starting the send/);
    expect(screen.queryByRole("button", { name: /Resume approved send/ })).toBeNull();

    serve(approved({ pause_hold: "resumed" }));
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toContain(RESUMED_LINE));
    expect(screen.getByTestId("email-card-in-flight").textContent).not.toContain(PAUSED_LINE);
  });

  it("an approve answered paused: true says nothing goes out yet instead of 'Sending'", async () => {
    serve(card());
    answers[`GET ${base("decisions")}/count`] = { status: 200, body: { people: 1 } };
    answers[`POST ${base("decisions")}/approve`] = { status: 200, body: { ok: true, queued: true, changed: true, paused: true } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send A/ }));
    serve(approved({ pause_hold: "paused" }));
    expect(await screen.findByText("Approved A. Email is paused")).toBeDefined();
    expect(screen.queryByText(/^Sending A to/)).toBeNull();
    expect(screen.getByText(/The send starts when email is resumed/)).toBeDefined();
  });

  it("with email on, the same approve still says it is sending", async () => {
    serve(card());
    answers[`GET ${base("decisions")}/count`] = { status: 200, body: { people: 1 } };
    answers[`POST ${base("decisions")}/approve`] = { status: 200, body: { ok: true, queued: true, changed: true } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send A/ }));
    serve(approved());
    expect(await screen.findByText("Sending A to 1 person")).toBeDefined();
    expect(screen.queryByText(/Email is paused/)).toBeNull();
  });
});

describe("a Zavi list over the 1,000 cap", () => {
  const confirmFor = async (route: string, people: number, rail: EmailCardRail = "decisions") => {
    cleanup();
    calls.length = 0;
    confirm.fn.mockClear();
    confirm.fn.mockResolvedValue(false);
    serve(card({ rail, route, list: { name: "Big list", people } }));
    answers[`GET ${base(rail)}/count`] = { status: 200, body: { people } };
    render(<EmailCampaignCard rail={rail} id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send A/ }));
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    return confirm.fn.mock.calls[0][0];
  };

  it("the dialog says how many get it, how many are left out, and that it is not the same people each time", async () => {
    const big = await confirmFor("zavi_list", 5000);
    expect(big.title).toBe("Send to 1,000 people of the 5,000 on this list?");
    expect(big.description).toContain("4,000 people on this list do not get this one");
    expect(big.description).toContain("not the same people left out every time");
    expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(false);
  });

  it("at the cap or under it the dialog is unchanged, and an email tool's own list is never capped", async () => {
    expect((await confirmFor("zavi_list", 1000)).title).toBe("Send to 1,000 people?");
    expect((await confirmFor("zavi_list", 1000)).description).not.toMatch(/do not get this one/);
    const tool = await confirmFor("sendgrid", 5000, "channel_actions");
    expect(tool.title).toBe("Send to 5,000 people?");
    expect(tool.description).not.toMatch(/do not get this one/);
  });

  it("the sending notice counts the people who actually get it", async () => {
    serve(card({ list: { name: "Big list", people: 5000 } }));
    answers[`GET ${base("decisions")}/count`] = { status: 200, body: { people: 5000 } };
    answers[`POST ${base("decisions")}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send A/ }));
    serve(approved({ list: { name: "Big list", people: 5000 } }));
    expect(await screen.findByText("Sending A to 1,000 people")).toBeDefined();
  });
});

describe("a send whose outcome is unknown stays dispatching", () => {
  it("long past its start: the card says it may have gone out and does not poll", async () => {
    serve(approved({ status: "dispatching", dispatching_since: new Date(Date.now() - 60 * 60_000).toISOString() }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    expect(await screen.findByText(DISPATCH_UNKNOWN_TITLE)).toBeDefined();
    expect(screen.getByText(DISPATCH_UNKNOWN_LINE, { exact: false })).toBeDefined();
    expect(screen.getByTestId("email-card-status").textContent).toBe("May have gone out");
    expect(screen.queryByText(/checks every few seconds/)).toBeNull();
    await sleep(150);
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("no start time from the server: the card bounds its own wait from when it first saw it dispatching", async () => {
    cardPoll.dispatchingMs = 80;
    serve(approved({ status: "dispatching", dispatching_since: null }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toMatch(/Starting the send/));
    expect(await screen.findByText(DISPATCH_UNKNOWN_TITLE, {}, { timeout: 2000 })).toBeDefined();
    const after = reads();
    await sleep(150);
    expect(reads()).toBe(after);
  });

  it("a send that just started keeps checking and says it is starting", async () => {
    serve(approved({ status: "dispatching", dispatching_since: new Date().toISOString() }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(reads()).toBeGreaterThan(2));
    expect(screen.queryByText(DISPATCH_UNKNOWN_TITLE)).toBeNull();
    expect(screen.getByTestId("email-card-in-flight").textContent).toMatch(/Starting the send/);
  });
});

describe("a test send that went out with something to fix", () => {
  it("shows the warning as an alert that stays through later reads until dismissed", async () => {
    serve(card());
    const warning = 'Zavi could not delete its Mailchimp test draft "[Test] Subject 1". Delete it in Mailchimp.';
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "Mailchimp", warning } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    const alert = await screen.findByTestId("email-card-test-warning");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(warning);
    const before = reads();
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true } };
    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send test of B/ }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.getByTestId("email-card-test-warning").textContent).toContain(warning);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("email-card-test-warning")).toBeNull();
  });

  it("a test with no warning shows no alert", async () => {
    serve(card());
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "SendGrid" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.queryByTestId("email-card-test-warning")).toBeNull();
  });
});

describe("the sent-test notice names the next step the viewer can actually take", () => {
  const BODY = "Only you got it. Check how it looks in your inbox";
  const sendTestFor = async (c: EmailCardView, name: RegExp) => {
    serve(c);
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "SendGrid" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name }));
    const status = await screen.findByText(/^Test of [A-Z] sent to/);
    return status.closest("[role=status]")!.textContent ?? "";
  };

  it("an approver is told to approve", async () => {
    expect(await sendTestFor(card(), /Send test of A/)).toContain(`${BODY}, then approve.`);
  });

  it("a member who cannot approve is not told to approve", async () => {
    const text = await sendTestFor(card({ viewer_can_approve: false }), /Send test of A/);
    expect(text).toContain(`${BODY}. An owner or admin approves it.`);
    expect(text).not.toMatch(/then approve/);
  });

  it("a failed card's test says try again, not approve", async () => {
    const failed = card({ open: false, status: "failed", chosen_variant: 2, editable: false, retryable: true, failure_reason: "SendGrid is not connected.", can_approve: [false, false] });
    const text = await sendTestFor(failed, /Send test of B/);
    expect(text).toContain(`${BODY}, then try again.`);
    expect(text).not.toMatch(/then approve/);
  });
});

describe("a Klaviyo test send, which Zavi sends itself", () => {
  const LINE = "Klaviyo has no test send, so Zavi sent this copy outside Klaviyo. The real email goes out from your Klaviyo sender.";

  it("says the copy went out outside Klaviyo, not from the Klaviyo sender", async () => {
    expect(KLAVIYO_TEST_LINE).toBe(LINE);
    serve(card({ route: "klaviyo" }));
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "Zavi (Klaviyo has no test API)" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    const status = await screen.findByText(/^Test of A sent to/);
    const banner = status.closest("[role=status]")!;
    await waitFor(() => expect(banner.textContent).toContain(LINE));
    expect(banner.textContent).toContain("Only you got it.");
    expect(screen.getAllByText(LINE)).toHaveLength(1);
  });

  it("says the same when the copy went through the founder's own SendGrid", async () => {
    serve(card({ route: "klaviyo" }));
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "your SendGrid (Klaviyo has no test API)" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    await screen.findByText(/^Test of A sent to/);
    await waitFor(() => expect(screen.getByTestId("email-card-test-via").textContent).toBe(LINE));
  });

  it("still says so when the test answer is lost but the card shows the test went out", async () => {
    serve(card({ route: "klaviyo" }));
    answers[`POST ${base("decisions")}/test`] = { status: 504, body: null };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    await screen.findByText(/^Test of A sent to/);
    expect(screen.getByTestId("email-card-test-via").textContent).toBe(LINE);
  });

  it("a SendGrid test says nothing about Zavi sending it", async () => {
    serve(card({ route: "sendgrid" }));
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "SendGrid" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    await screen.findByText(/^Test of A sent to/);
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.queryByTestId("email-card-test-via")).toBeNull();
    expect(document.body.textContent).not.toContain("Klaviyo has no test send");
  });

  it("a Mailchimp test says nothing about Zavi sending it", async () => {
    serve(card({ route: "mailchimp" }));
    answers[`POST ${base("decisions")}/test`] = { status: 200, body: { ok: true, sent_with: "Mailchimp" } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A/ }));
    await screen.findByText(/^Test of A sent to/);
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.queryByTestId("email-card-test-via")).toBeNull();
  });
});

describe("how often a queued card checks while email is paused", () => {
  const run = async (over: Partial<EmailCardView>) => {
    cardPoll.ms = 5_000;
    cardPoll.pausedMs = 60_000;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    serve(approved(over));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(reads()).toBe(1));
    await waitFor(() => expect(screen.getByTestId("email-card-status")).toBeDefined());
    const start = reads();
    for (let t = 0; t < 6; t++) await vi.advanceTimersByTimeAsync(5_000);
    return reads() - start;
  };

  it("paused: 30 seconds pass with at most one extra read, and a resume is still picked up within a minute", async () => {
    expect(await run({ pause_hold: "paused" })).toBeLessThanOrEqual(1);
    serve(approved({ pause_hold: "resumed" }));
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toContain(RESUMED_LINE));
    const after = reads();
    for (let t = 0; t < 3; t++) await vi.advanceTimersByTimeAsync(5_000);
    expect(reads() - after).toBeGreaterThanOrEqual(2);
  });

  it("not paused: the same card checks every 5 seconds", async () => {
    expect(await run({})).toBeGreaterThanOrEqual(5);
  });
});

describe("a Zavi-list send held for a reason nobody can resume", () => {
  const FINAL = "Zavi stopped this send: Zavi's sender stopped making progress and could not restart it. 120 people got it; the rest will not.";
  const ticks = async () => {
    const start = reads();
    for (let t = 0; t < 6; t++) await vi.advanceTimersByTimeAsync(5_000);
    return reads() - start;
  };

  it("stops polling, offers no Stop, and says Zavi stopped it and how many got it", async () => {
    cardPoll.ms = 5_000;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    serve(approved({ status: "held", sent_count: 120, failure_reason: "Too many of these addresses bounced." }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toMatch(/On hold/));
    expect(screen.getByRole("button", { name: "Stop the rest" })).toBeDefined();
    expect(await ticks()).toBeGreaterThanOrEqual(5);

    serve(approved({ status: "partially_sent", sent_count: 120, failure_reason: FINAL }));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(screen.getByTestId("email-card-outcome").textContent).toContain(FINAL));
    expect(screen.getByTestId("email-card-status").textContent).not.toMatch(/On hold/);
    expect(screen.queryByTestId("email-card-in-flight")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop the rest" })).toBeNull();
    expect(screen.queryByText(/sent so far/)).toBeNull();
    expect(await ticks()).toBe(0);
  });

  it("with nobody emailed, reads as not sent and never polls", async () => {
    cardPoll.ms = 5_000;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const why = "Zavi stopped this send: bulk email is paused for everyone right now. Nobody was emailed.";
    serve(approved({ status: "not_sent", sent_count: 0, failure_reason: why }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-outcome").textContent).toContain(why));
    expect(screen.getByTestId("email-card-status").textContent).toBe("Not sent");
    expect(screen.queryByRole("button", { name: "Stop the rest" })).toBeNull();
    expect(await ticks()).toBe(0);
  });
});

describe("editing a version with a line break in the subject or preview", () => {
  const RAIL: EmailCardRail = "channel_actions";
  const open = async (preview = "Preview") => {
    const versions = card().versions.map((v) => ({
      ...v,
      content: { subject: v.subject, preview_text: preview, title: "Shared workspaces", paragraphs: ["One."], button: { label: "See it", url: "https://brightloop.test" } },
    }));
    serve(card({ rail: RAIL, versions, editable: true }));
    answers[`PATCH ${base(RAIL)}/variants/1`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail={RAIL} id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
    return screen.getByRole("form", { name: "Edit version A" });
  };
  const save = () => screen.getByRole("button", { name: "Save version A" }) as HTMLButtonElement;
  const patches = () => calls.filter((c) => c.method === "PATCH").length;

  it("a hidden character in the subject shows an inline error, disables Save and sends nothing", async () => {
    const form = await open();
    for (const bad of ["Hello\tthere", "Hello\u2028there", "Hello\u0085there"]) {
      fireEvent.change(screen.getByLabelText("Subject"), { target: { value: bad } });
      expect(screen.getByText("Keep the subject on one line.")).toBeDefined();
      expect(screen.getByLabelText("Subject").getAttribute("aria-invalid")).toBe("true");
      expect(save().disabled).toBe(true);
      fireEvent.submit(form);
    }
    await sleep(30);
    expect(patches()).toBe(0);
    expect(screen.queryByText("Not saved")).toBeNull();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello there" } });
    expect(screen.queryByText("Keep the subject on one line.")).toBeNull();
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(patches()).toBe(1));
  });

  it("a preview that arrives with a line break is flagged as soon as the form opens", async () => {
    const form = await open("Line one\nline two");
    expect(screen.getByText("Keep the preview text on one line.")).toBeDefined();
    expect(screen.queryByText("Keep the subject on one line.")).toBeNull();
    expect(save().disabled).toBe(true);
    fireEvent.submit(form);
    await sleep(30);
    expect(patches()).toBe(0);
    fireEvent.change(screen.getByLabelText("Preview text"), { target: { value: "Line one, line two" } });
    expect(screen.queryByText("Keep the preview text on one line.")).toBeNull();
    expect(save().disabled).toBe(false);
  });
});

describe("an email that cannot be loaded", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const calm = () => waitFor(() => screen.getByText("This email isn't loading right now."), { timeout: 4000 });
  it("shows Try again as a button sized to its label, not stretched across the grid", async () => {
    answers[`GET ${base("decisions")}`] = { status: 500, body: { error: { code: "internal_error", message: "Something went wrong. Try again." } } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await calm();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.parentElement!.className).toMatch(/\bflex\b/);
    expect(retry.className).not.toMatch(/\bw-full\b/);
  });

  it("offers no Try again when the email does not exist, and keeps the reason on screen", async () => {
    answers[`GET ${base("decisions")}`] = { status: 404, body: { error: { code: "not_found", message: "That email was not found." } } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => screen.getByText("This email could not be loaded"));
    expect(screen.getByText("That email was not found.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(reads()).toBe(1);
  });

  it("keeps Try again for a server failure, re-reads on click, and drops it once the read says the email is gone", async () => {
    answers[`GET ${base("decisions")}`] = { status: 500, body: { error: { code: "internal_error", message: "Something went wrong. Try again." } } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await calm();
    expect(reads()).toBe(3);
    const retry = screen.getByRole("button", { name: "Try again" });
    answers[`GET ${base("decisions")}`] = { status: 404, body: { error: { code: "not_found", message: "That email was not found." } } };
    fireEvent.click(retry);
    await waitFor(() => screen.getByText("That email was not found."));
    expect(reads()).toBe(4);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["no body", null],
    ["a non-JSON body", new SyntaxError("Unexpected token <")],
    ["another 404 code", { error: { code: "route_missing", message: "No such route." } }],
  ])("keeps Try again for a 404 with %s, which is not the email being gone, and re-reads on click", async (_label, body) => {
    answers[`GET ${base("decisions")}`] = { status: 404, body };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await calm();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(reads()).toBe(3);
    answers[`GET ${base("decisions")}`] = { status: 404, body: { error: { code: "not_found", message: "That email was not found." } } };
    fireEvent.click(retry);
    await waitFor(() => screen.getByText("That email was not found."));
    expect(reads()).toBe(4);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps Try again when the read never answers", async () => {
    answers[`GET ${base("decisions")}`] = { status: 502, body: null };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await calm();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(reads()).toBe(3);
  });
});
