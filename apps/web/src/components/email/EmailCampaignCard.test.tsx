// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
type Answer = { status: number; body: unknown; error?: Error; gate?: Promise<unknown> };
const answers: Record<string, Answer> = {};
const queued: Record<string, Answer[]> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = queued[`${method} ${url}`]?.shift() ?? answers[`${method} ${url}`] ?? { status: 200, body: {} };
    const answer = () => ("error" in a && a.error ? Promise.reject(a.error) : Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) }));
    return a.gate ? a.gate.then(answer) : answer();
  },
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_o: { title: string; description?: string; confirmLabel?: string }) => true) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: confirm.fn }));
const viewer = vi.hoisted(() => ({ email: null as string | null }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => (viewer.email ? { email: viewer.email } : null) }));

import { requestTimeout } from "@/lib/workspace/emailPlanApi";
import { CANNOT_UNDO, cardPoll, DONT_SEND_LINE, EDIT_VOIDS_TEST_LINE, EDIT_VOIDS_TEST_MEMBER_LINE, EmailCampaignCard, LEARNINGS_UNREAD_LINE, LOCKED_FIELDS_LINE, REDRAFT_LINE, TEST_LIST_LINE, type EmailCardView } from "./EmailCampaignCard";

const ID = "22222222-2222-4222-8222-222222222222";
const BASE = `/api/email-cards/channel_actions/${ID}`;

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "pending",
    open: true,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2, 3].map((n) => ({
      variant: n,
      subject: `Subject ${n}`,
      preview_text: `Preview ${n}`,
      html: `<p>Version ${n}</p><a href="javascript:alert(1)">bad</a><script>parent.x=1</script>`,
      tested_by_me: false,
      tested_by_approver: false,
    })),
    can_approve: [false, false, false],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(queued)) delete queued[k];
  confirm.fn.mockClear();
  confirm.fn.mockResolvedValue(true);
  viewer.email = null;
});
afterEach(cleanup);

const APPROVE_NAME = /Approve and send|Send a test first/;
const approveButton = () => screen.getByRole("button", { name: APPROVE_NAME }) as HTMLButtonElement;

describe("EmailCampaignCard", () => {
  it("Approve stays locked until an approver has a test of the SELECTED version", async () => {
    serve(card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    expect(approveButton().textContent).toContain("Approve and send A");
    expect(approveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    expect(approveButton().textContent).toContain("Send a test first");
    expect(approveButton().textContent).not.toContain("Approve and send");
    expect(approveButton().disabled).toBe(true);
    expect(screen.queryByText(/Send yourself a test of B first/)).toBeNull();
    expect(screen.queryByTestId("email-card-tests")).toBeNull();
  });

  it("shows the gate as two steps that follow the selected version, and the locked button says to send a test first", async () => {
    serve(card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-steps")).toBeDefined());
    const step = (id: string) => screen.getByTestId(id);
    expect(step("email-card-step-test").textContent).toContain("Send a test to you");
    expect(step("email-card-step-test").textContent).toContain("Done");
    expect(step("email-card-step-test").textContent).not.toContain("Not done");
    expect(step("email-card-step-approve").textContent).toContain("Approve and send");
    expect(step("email-card-step-approve").getAttribute("data-ready")).toBe("true");
    expect(screen.getByRole("list", { name: "Before this email goes out" }).querySelectorAll("li")).toHaveLength(2);
    expect(approveButton().disabled).toBe(false);
    expect(approveButton().textContent).toContain("Approve and send A");

    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    expect(step("email-card-step-test").textContent).toContain("Not done");
    expect(step("email-card-step-approve").getAttribute("data-ready")).toBe("false");
    expect(screen.getByLabelText("Locked")).toBeDefined();
    const locked = screen.getByRole("button", { name: "Send a test first" }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    fireEvent.click(locked);
    expect(confirm.fn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/count"))).toBe(false);
  });

  it("an approver's test from someone else counts as step 1 done; the step stays not done when only the server says no", async () => {
    serve(card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: false, tested_by_approver: i === 0 })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-step-test")).toBeDefined());
    expect(screen.getByTestId("email-card-step-test").textContent).toContain("Done by an owner or admin");
    expect(screen.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("true");
    cleanup();
    serve(card({ can_approve: [false, false, false], versions: card().versions.map((v) => ({ ...v, tested_by_me: true, tested_by_approver: true })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-step-test")).toBeDefined());
    expect(screen.getByTestId("email-card-step-test").getAttribute("data-done")).toBe("true");
    expect(screen.getByTestId("email-card-step-approve").getAttribute("data-ready")).toBe("false");
    expect(approveButton().disabled).toBe(true);
    expect(approveButton().textContent).toContain("Approve and send A");
    expect(screen.queryByRole("button", { name: "Send a test first" })).toBeNull();
  });

  it("a test list or unreadable test lists never claim a test is missing", async () => {
    for (const over of [{ test_list: true }, { test_list_unknown: true }]) {
      cleanup();
      serve(card({ ...over, can_approve: [false, false, false] }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByTestId("email-card-test-list")).toBeDefined());
      expect(screen.queryByTestId("email-card-steps")).toBeNull();
      expect(screen.queryByRole("button", { name: "Send a test first" })).toBeNull();
      expect(approveButton().disabled).toBe(true);
    }
  });

  it("titles the card with the selected version's subject, and falls back to Email to send when it is blank", async () => {
    serve(card());
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-title").textContent).toBe("Subject 1"));
    expect(screen.getByRole("region", { name: "Email to send" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: /C · Subject 3/ }));
    expect(screen.getByTestId("email-card-title").textContent).toBe("Subject 3");
    cleanup();
    serve(card({ versions: card().versions.map((v) => ({ ...v, subject: "   " })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-title").textContent).toBe("Email to send"));
  });

  it("Send test posts only the version (no address), then Approve confirms with the live count and the can't-undo line", async () => {
    serve(card({ can_approve: [true, true, true] }));
    answers[`POST ${BASE}/test`] = { status: 200, body: { ok: true } };
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 241 } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: /C · Subject 3/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send test of C to me/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/test"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/test"))!.body).toEqual({ variant: 3 });

    fireEvent.click(approveButton());
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    const opts = confirm.fn.mock.calls[0][0];
    expect(opts.title).toBe("Send to 241 people?");
    expect(opts.description).toContain(CANNOT_UNDO);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/approve"))!.body).toMatchObject({ variant: 3 });
  });

  it("Approve shows the sender warning from the count read, and the founder can still send", async () => {
    const warning = "Mailchimp shows zaviagent.com is not authenticated, so this email can land in spam or never arrive, even if it shows as sent.";
    serve(card({ can_approve: [true, true, true] }));
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 1, sender_warning: warning } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    fireEvent.click(approveButton());
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    expect(confirm.fn.mock.calls[0][0].description).toContain(warning);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
  });

  it("a count with no warning leaves the dialog words alone", async () => {
    serve(card({ can_approve: [true, true, true] }));
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 1 } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    fireEvent.click(approveButton());
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    expect(confirm.fn.mock.calls[0][0].description).not.toMatch(/authenticated|undefined/);
  });

  it("a card whose list is a test list says why and keeps Approve off", async () => {
    serve(card({ test_list: true, can_approve: [false, false, false] }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-test-list")).toBeDefined());
    expect(screen.getByTestId("email-card-test-list").textContent).toBe(TEST_LIST_LINE);
    expect(approveButton().disabled).toBe(true);
  });

  it("shows the win line read-only, and nothing when there is none", async () => {
    serve(card({ win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, frozen: false } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("2.0% of delivered visit your site")).toBeDefined());
    expect(screen.getByText("Set when sent, from your past emails to this list")).toBeDefined();
    expect(screen.getByTestId("email-card-win-line").querySelector("input, button")).toBeNull();
    cleanup();
    serve(card({ win_line: null }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    expect(screen.queryByTestId("email-card-win-line")).toBeNull();
  });

  it("folds the learnings the draft was written with; nothing when there were none; says so when they could not be read", async () => {
    serve(card({ learnings_read: { status: "ok", items: [{ id: "l1", text: "Emails with a number in the subject got more clicks." }, { id: "l2", text: "Never email trial users more than once a week." }] } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-learnings")).toBeDefined());
    expect(screen.getByText("Zavi read 2 learnings for this draft")).toBeDefined();
    expect(screen.getByText("Never email trial users more than once a week.")).toBeDefined();
    expect(screen.queryByTestId("email-card-learnings-failed")).toBeNull();
    cleanup();
    serve(card({ learnings_read: { status: "empty", items: [] } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    expect(screen.queryByTestId("email-card-learnings")).toBeNull();
    expect(screen.queryByTestId("email-card-learnings-failed")).toBeNull();
    for (const status of ["read_failed", "snapshot_failed"] as const) {
      cleanup();
      serve(card({ learnings_read: { status, items: [] } }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByTestId("email-card-learnings-failed")).toBeDefined());
      expect(screen.getByTestId("email-card-learnings-failed").textContent).toBe(LEARNINGS_UNREAD_LINE);
      expect(screen.queryByTestId("email-card-learnings")).toBeNull();
    }
  });

  it("shows the unsubscribe group's name, or its id when the name could not be read", async () => {
    serve(card({ unsubscribe_group_name: "Product news" }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("Product news")).toBeDefined());
    cleanup();
    serve(card({ unsubscribe_group_name: null }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("Group 7")).toBeDefined());
  });

  it("a member sees 'Ask an admin to approve' and no Approve button, but can still test", async () => {
    serve(card({ viewer_can_approve: false, can_approve: [false, false, false] }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("Ask an admin to approve")).toBeDefined());
    expect(screen.queryByRole("button", { name: APPROVE_NAME })).toBeNull();
    expect(screen.queryByTestId("email-card-steps")).toBeNull();
    expect(screen.getByRole("button", { name: /Send test of A to me/ })).toBeDefined();
  });

  it("Flow 34 phone: the test-send button shows the founder's full address with nothing truncating or capping it", async () => {
    const addr = "mohit2703+oct16@yopmail.com";
    serve(card({ viewer_email: addr }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const button = await screen.findByRole("button", { name: `Send test of A to ${addr}` });
    expect(button.textContent).toContain(`Send test of A to ${addr}`);
    const holders = Array.from(button.querySelectorAll<HTMLElement>("*")).filter((el) => el.textContent?.includes(addr));
    const addrEl = holders[holders.length - 1];
    expect(addrEl).toBeDefined();
    expect(addrEl.className).toContain("break-all");
    const capping = /(^|\s)(truncate|text-ellipsis|whitespace-nowrap|overflow-hidden|max-w-\[[^\]]+\])(\s|$)/;
    for (let el: HTMLElement | null = addrEl; el && el !== button.parentElement; el = el.parentElement) {
      expect(el.className, el.outerHTML.slice(0, 120)).not.toMatch(capping);
    }
  });

  it("Flow 34 phone: the Try again panel's test-send button shows the full address, wraps it, and has no fixed height", async () => {
    const addr = "mohit2703+oct16@yopmail.com";
    serve(card({ viewer_email: addr, open: false, status: "failed", chosen_variant: 2, editable: false, retryable: true, failure_reason: "SendGrid is not connected.", can_approve: [false, false, false] }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByRole("button", { name: "Try again" });
    const button = screen.getByRole("button", { name: `Send test of B to ${addr}` });
    expect(button.textContent).toContain(`Send test of B to ${addr}`);
    const holders = Array.from(button.querySelectorAll<HTMLElement>("*")).filter((el) => el.textContent?.includes(addr));
    const addrEl = holders[holders.length - 1];
    expect(addrEl).toBeDefined();
    expect(addrEl.className).toContain("break-all");
    const capping = /(^|\s)(truncate|text-ellipsis|whitespace-nowrap|overflow-hidden|max-w-\[[^\]]+\]|h-\d+|h-\[[^\]]+\])(\s|$)/;
    for (let el: HTMLElement | null = addrEl; el && el !== button.parentElement; el = el.parentElement) {
      expect(el.className, el.outerHTML.slice(0, 120)).not.toMatch(capping);
    }
  });

  it("the preview is fully sandboxed: no scripts, forms, popups or top navigation", async () => {
    serve(card());
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const frame = (await screen.findByTitle("Email preview, version A")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("javascript:alert(1)");
    expect(document.body.querySelector("script")).toBeNull();
    expect(document.body.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("a card written before versions asks for a redraft and offers no approve", async () => {
    serve(card({ versions: [], can_approve: [] }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(REDRAFT_LINE)).toBeDefined());
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send test/ })).toBeNull();
  });

  it("a card someone already sent re-reads itself: no Approve left, it shows the version that went out", async () => {
    serve(card({ can_approve: [false, true, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 1, tested_by_approver: i === 1 })) }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    serve(card({ status: "acted", open: false, chosen_variant: 2, editable: false, reasons: ["This email has already been decided."] }));
    answers[`GET ${BASE}/count`] = { status: 409, body: { error: { code: "not_open", message: "This email has already been decided." } } };
    fireEvent.click(approveButton());
    await waitFor(() => expect(screen.queryByRole("button", { name: APPROVE_NAME })).toBeNull());
    expect(await screen.findByText("Approved: B")).toBeDefined();
  });

  it("the server's refusal reads as a sentence", async () => {
    serve(card({ can_approve: [true, true, true] }));
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
    answers[`POST ${BASE}/approve`] = { status: 409, body: { error: { code: "test_required", message: "Send yourself a test of this version first." } } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton()).toBeDefined());
    fireEvent.click(approveButton());
    await waitFor(() => expect(screen.getByText("Send yourself a test of this version first.")).toBeDefined());
  });

  it("Edit this version: the form starts from the version, saves {content} only, then says a new test is needed", async () => {
    const versions = card().versions.map((v) => ({
      ...v,
      content: { subject: v.subject, preview_text: v.preview_text, title: "Shared workspaces", paragraphs: ["One.", "Two."], button: { label: "See it", url: "https://brightloop.test" } },
    }));
    serve(card({ versions, editable: true }));
    answers[`PATCH ${BASE}/variants/2`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Edit this version/ })).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Edit this version/ }));
    expect(screen.getByText(LOCKED_FIELDS_LINE)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "A sharper subject" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version B" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`${BASE}/variants/2`);
    expect(patch.body).toEqual({
      content: { subject: "A sharper subject", preview_text: "Preview 2", title: "Shared workspaces", paragraphs: ["One.", "Two."], button: { label: "See it", url: "https://brightloop.test" } },
    });
    await waitFor(() => expect(screen.getByText(EDIT_VOIDS_TEST_LINE)).toBeDefined());
  });

  it("a member who saves an edit is told to test and ask an owner or admin, never to approve", async () => {
    const versions = card().versions.map((v) => ({
      ...v,
      content: { subject: v.subject, preview_text: v.preview_text, title: "Shared workspaces", paragraphs: ["One.", "Two."], button: { label: "See it", url: "https://brightloop.test" } },
    }));
    serve(card({ versions, editable: true, viewer_can_approve: false, can_approve: [false, false, false] }));
    answers[`PATCH ${BASE}/variants/1`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("Ask an admin to approve")).toBeDefined());
    const editButton = screen.getByRole("button", { name: /Edit this version/ });
    const editHelp = (editButton.getAttribute("aria-describedby") ?? "").split(" ").map((d) => document.getElementById(d)?.textContent ?? "").join(" ");
    expect(editHelp).toContain("send yourself a new test and ask an owner or admin to approve");
    expect(editHelp).not.toContain("before approving");
    fireEvent.click(editButton);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "A member's subject" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version A" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === `${BASE}/variants/1`)).toBe(true));
    await waitFor(() => expect(screen.getByText(EDIT_VOIDS_TEST_MEMBER_LINE)).toBeDefined());
    expect(screen.queryByText(EDIT_VOIDS_TEST_LINE)).toBeNull();
    expect(screen.getAllByRole("status").some((n) => /before approving/.test(n.textContent ?? ""))).toBe(false);
  });

  it("a decided card offers no edit; a replaced card points to the newer draft", async () => {
    serve(card({ editable: false }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Send test/ })).toBeDefined());
    expect(screen.queryByRole("button", { name: /Edit this version/ })).toBeNull();
    cleanup();
    serve(card({ open: false, replaced_by: { rail: "decisions", id: "33333333-3333-4333-8333-333333333333" } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const link = (await screen.findByRole("link", { name: "Open the newer draft" })) as HTMLAnchorElement;
    expect(screen.getByText("Replaced by a newer draft")).toBeDefined();
    expect(link.getAttribute("href")).toBe("/workspace/email-cards/decisions/33333333-3333-4333-8333-333333333333");
  });

  it("Try again: only when the server says retryable, with the fresh count in the same confirm, for the SAME version", async () => {
    serve(card({ open: false, status: "failed", chosen_variant: 2, editable: false, retryable: true, failure_reason: "SendGrid is not connected.", can_approve: [false, false, false] }));
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText(/SendGrid is not connected\./)).toBeDefined();
    expect(screen.getByRole("button", { name: /Send test of B to me/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Edit this version/ })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    expect(confirm.fn.mock.calls[0][0].title).toBe("Send to 251 people?");
    expect(confirm.fn.mock.calls[0][0].description).toContain(CANNOT_UNDO);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/approve"))!.body).toMatchObject({ variant: 2 });
  });

  it("Try again: testing the approved version ignores the currently selected preview tab", async () => {
    serve(card({ open: false, status: "failed", chosen_variant: 2, editable: false, retryable: true, failure_reason: "SendGrid is not connected.", can_approve: [false, false, false] }));
    answers[`POST ${BASE}/test`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByRole("button", { name: /Send test of B to me/ });
    expect(screen.getByRole("tab", { name: /A · Subject 1/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Send test of B to me/ }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/test"))?.body).toEqual({ variant: 2 }));
  });

  describe("fd7: no answer is not a no", () => {
    const tested = () => card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) });
    const failedCard = () => card({ open: false, status: "failed", chosen_variant: 2, editable: false, retryable: true, failure_reason: "x", can_approve: [false, false, false] });

    it("Try again with no answer: status unknown + Refresh, and the next try is the SAME request; a refusal says Not sent", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 502, body: null };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Retry status unknown"));
      expect(screen.queryByText("Not sent")).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
      answers[`POST ${BASE}/approve`] = { status: 409, body: { error: { code: "not_open", message: "This email has already been decided." } } };
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Not sent"));
      const ids = calls.filter((c) => c.url.endsWith("/approve")).map((c) => (c.body as { request_id: string }).request_id);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
    });

    it("C1: an accepted Try again is said only once a read shows it taken; a read still failed is unknown, the request kept", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Retry status unknown"));
      expect(screen.queryByText("Trying again")).toBeNull();
      serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: false, can_approve: [false, false, false] }));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Trying again"));
      const ids = calls.filter((c) => c.url.endsWith("/approve")).map((c) => (c.body as { request_id: string }).request_id);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
    });

    it("fd9 #5: the host hears of an accepted Try again only once a read shows it taken (it may close the card)", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
      const onApproved = vi.fn();
      render(<EmailCampaignCard rail="channel_actions" id={ID} onApproved={onApproved} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Retry status unknown"));
      expect(onApproved).not.toHaveBeenCalled();
      serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: false, can_approve: [false, false, false] }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => screen.getByText("Trying again"));
      expect(onApproved).toHaveBeenCalledTimes(1);
    });

    it("fd10 #6 + F48: a read showing the card open again releases Send now of the retry's version, which reuses its id; another version waits", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const retry = await screen.findByRole("button", { name: "Try again" });
      serve(card({ can_approve: [true, true, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i < 2, tested_by_approver: i < 2 })) }));
      fireEvent.click(retry);
      await waitFor(() => screen.getByRole("button", { name: /Approve and send A/ }));
      expect(screen.queryByText("Retry status unknown")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Approve and send A/ }));
      await waitFor(() => screen.getByText(/was for version B/));
      expect(calls.filter((c) => c.url.endsWith("/approve"))).toHaveLength(1);
      fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
      answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
      fireEvent.click(screen.getByRole("button", { name: /Approve and send B/ }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/approve"))).toHaveLength(2));
      const sent = calls.filter((c) => c.url.endsWith("/approve")).map((c) => c.body as { request_id: string; variant: number });
      expect(sent[1].request_id).toBe(sent[0].request_id);
      expect(sent[1].variant).toBe(2);
    });

    it("a held retry for another version is never reused: Try again of the card's failed version is a new request", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const retry = await screen.findByRole("button", { name: "Try again" });
      serve(card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) }));
      fireEvent.click(retry);
      await waitFor(() => screen.getByRole("button", { name: /Send test of A to me/ }));
      answers[`POST ${BASE}/test`] = { status: 200, body: { ok: true } };
      serve(card({ open: false, status: "failed", chosen_variant: 1, editable: false, retryable: true, failure_reason: "x", can_approve: [false, false, false] }));
      fireEvent.click(screen.getByRole("button", { name: /Send test of A to me/ }));
      const again = await screen.findByRole("button", { name: "Try again" });
      fireEvent.click(again);
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/approve"))).toHaveLength(2));
      const sent = calls.filter((c) => c.url.endsWith("/approve")).map((c) => c.body as { request_id: string; variant: number });
      expect(sent[0].variant).toBe(2);
      expect(sent[1].variant).toBe(1);
      expect(sent[1].request_id).not.toBe(sent[0].request_id);
    });

    it("fd10 #2: a wait notice goes as soon as a read settles what it waited for", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Retry status unknown"));
      serve(card({ open: false, status: "acted", chosen_variant: 2, retryable: false, can_approve: [false, false, false] }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => screen.getByText("Trying again"));
      expect(screen.queryByText(/Waiting to confirm/)).toBeNull();
    });

    it("C3: any later read settles a pending Try again: Refresh showing it sent (acted) replaces the unknown", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getByText("Retry status unknown"));
      serve(card({ open: false, status: "acted", chosen_variant: 2, retryable: false, can_approve: [false, false, false] }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => screen.getByText("Trying again"));
      expect(screen.queryByText("Retry status unknown")).toBeNull();
    });

    it("G3: a first read that never answers is retried, then says so calmly with Try again", async () => {
      requestTimeout.ms = 60;
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        answers[`GET ${BASE}`] = { status: 200, body: { card: card() }, gate: new Promise<void>(() => undefined) };
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await waitFor(() => screen.getByText("This email isn't loading right now."), { timeout: 4000 });
        expect(screen.queryByText("This email could not be loaded")).toBeNull();
        expect(screen.queryByText(/Zavi did not answer/)).toBeNull();
        expect(screen.queryByText("timeout")).toBeNull();
        serve(card());
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => screen.getByRole("button", { name: /Send test of A to me/ }));
      } finally {
        random.mockRestore();
        requestTimeout.ms = 30_000;
      }
    });

    it("Try again with no answer whose re-read shows the attempt taken says it is trying again", async () => {
      serve(failedCard());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 251 } };
      answers[`POST ${BASE}/approve`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const retry = await screen.findByRole("button", { name: "Try again" });
      serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: false, can_approve: [false, false, false] }));
      fireEvent.click(retry);
      await waitFor(() => screen.getByText("Trying again"));
    });

    it("a test with no answer: the card's record decides; otherwise unknown + Refresh, never 'not sent'", async () => {
      serve(tested());
      answers[`POST ${BASE}/test`] = { status: 504, body: null };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: /Send test of A to me/ }));
      await waitFor(() => screen.getByText("Test of A sent to your login email"));
      serve(card());
      fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
      fireEvent.click(screen.getByRole("button", { name: /Send test of B to me/ }));
      await waitFor(() => screen.getByText("Test status unknown"));
      expect(screen.queryByText("The test was not sent")).toBeNull();
    });

    it("an edit with no answer keeps the editor and the text, and says it may not have saved; a refusal says Not saved", async () => {
      const versions = card().versions.map((v) => ({
        ...v,
        content: { subject: v.subject, preview_text: v.preview_text, title: "T", paragraphs: ["One."], button: { label: "Go", url: "https://brightloop.test" } },
      }));
      serve(card({ versions, editable: true }));
      answers[`PATCH ${BASE}/variants/1`] = { status: 0, body: null, error: new Error("socket hang up") };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
      fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "A sharper subject" } });
      fireEvent.click(screen.getByRole("button", { name: "Save version A" }));
      await waitFor(() => screen.getByText("This version may not have saved"));
      expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("A sharper subject");
      answers[`PATCH ${BASE}/variants/1`] = { status: 422, body: { error: { code: "bad_request", message: "The subject is too long." } } };
      fireEvent.click(screen.getByRole("button", { name: "Save version A" }));
      await waitFor(() => screen.getByText("Not saved"));
      expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("A sharper subject");
    });

    it("one action at a time, by a lock the handlers hold: a second handler started meanwhile does nothing", async () => {
      serve(tested());
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      queued[`POST ${BASE}/test`] = [{ status: 200, body: { ok: true }, gate: held }];
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const test = await screen.findByRole("button", { name: /Send test of A to me/ });
      fireEvent.click(test);
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/test"))).toBe(true));
      for (const b of screen.getAllByRole("button")) (b as HTMLButtonElement).disabled = false;
      fireEvent.click(screen.getByRole("button", { name: /Approve and send A/ }));
      fireEvent.click(test);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.filter((c) => c.url.endsWith("/count") || c.url.endsWith("/approve"))).toHaveLength(0);
      expect(calls.filter((c) => c.url.endsWith("/test"))).toHaveLength(1);
      release();
      await waitFor(() => screen.getByText("Test of A sent to your login email"));
    });
  });

  it("no Try again for a member, or when the server says it may not be retried; the reason still shows", async () => {
    serve(card({ open: false, status: "failed", chosen_variant: 2, retryable: true, viewer_can_approve: false }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("Failed: B")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();
    serve(card({ open: false, status: "failed", chosen_variant: 2, retryable: false, failure_reason: "Part of it may have gone out." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(/Part of it may have gone out\./)).toBeDefined());
    expect(screen.getByText(/cannot be tried again/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a failed card that cannot be tried again asks for a new draft once, whatever the reason already says", async () => {
    const count = (re: RegExp) => (document.body.textContent ?? "").match(re)?.length ?? 0;
    serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, failure_reason: "Zavi could not finish this send. Ask Zavi for a new draft." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(/Zavi could not finish this send\./)).toBeDefined());
    expect(count(/Ask Zavi (for a new draft|to draft it again)/g)).toBe(1);
    expect(count(/cannot be tried again/g)).toBe(1);
    cleanup();
    serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, failure_reason: "Zavi could not read this email's draft, so nothing was sent. Ask Zavi to draft it again." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(/could not read this email's draft/)).toBeDefined());
    expect(count(/Ask Zavi (for a new draft|to draft it again)/g)).toBe(1);
    expect(count(/cannot be tried again/g)).toBe(1);
    cleanup();
    serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, failure_reason: "This send cannot be tried again: part of it may already have gone out, or the email tool refused it for good. Ask Zavi to draft it again." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(/refused it for good/)).toBeDefined());
    expect(count(/Ask Zavi (for a new draft|to draft it again)/g)).toBe(1);
    expect(count(/cannot be tried again/g)).toBe(1);
    cleanup();
    serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, failure_reason: "Mailchimp did not accept this email. Nothing was sent." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText(/Mailchimp did not accept this email\./)).toBeDefined());
    expect(document.body.textContent).toContain("This one cannot be tried again. Ask Zavi to draft it again.");
  });

  it("an outcome Zavi could not confirm never reads as not sent", async () => {
    serve(card({ open: false, status: "failed", chosen_variant: 2, retryable: false, may_have_sent: true, reconciliation_pending: true, failure_reason: "SendGrid did not confirm whether this email was sent." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("May have gone out. Zavi is checking.")).toBeDefined());
    expect(screen.queryByText(/approved but not sent/)).toBeNull();
    expect(screen.queryByText(/This email was not sent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  describe("exec_partial: a send that ended partway is final, not in flight", () => {
    const reads = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("with a count: may have gone out, who the tool says got it so far, no Stop, no retry, and it never reads itself again", async () => {
      const why = "Zavi could not confirm whether this email went out. It is in an unknown state in Mailchimp. Zavi will not send this card again. Check it in Mailchimp, or ask Zavi for a new one. The email tool reports 1,204 people got it so far.";
      serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: true, reconciliation_pending: false, sent_count: 1204, sent_at: "2026-10-15T09:01:00Z", failure_reason: why }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/The email tool reports 1,204 people got it so far\./)).toBeDefined());
      expect(screen.getByTestId("email-card-status").textContent).toBe("Delivery unknown: A");
      expect(screen.getByText("May have gone out.")).toBeDefined();
      expect(document.body.textContent).not.toMatch(/the rest will not|Partly sent/);
      const n = reads();
      await vi.advanceTimersByTimeAsync(cardPoll.dispatchingMs + cardPoll.pausedMs * 5);
      expect(reads()).toBe(n);
      expect(document.body.textContent).not.toMatch(/Zavi is checking|checks every few seconds/);
      expect(screen.queryByTestId("email-card-in-flight")).toBeNull();
      expect(screen.queryByRole("button", { name: /Stop the rest|Try again|Resume|Approve/ })).toBeNull();
    });

    it("with no count: says it may have gone out and why, never that Zavi is checking, and never reads itself again", async () => {
      const why = "Zavi could not confirm whether this email went out. It is no longer in Mailchimp. Zavi will not send this card again. Check it in Mailchimp, or ask Zavi for a new one.";
      serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: true, reconciliation_pending: false, failure_reason: why }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/It is no longer in Mailchimp\./)).toBeDefined());
      const n = reads();
      await vi.advanceTimersByTimeAsync(cardPoll.dispatchingMs + cardPoll.pausedMs * 5);
      expect(reads()).toBe(n);
      expect(document.body.textContent).not.toMatch(/Zavi is checking|updates once Zavi knows/);
      expect(screen.getByText("May have gone out.")).toBeDefined();
      expect(screen.queryByRole("button", { name: /Stop the rest|Try again|Resume/ })).toBeNull();
    });

    it("on a test list, a send that may have gone out never also tells the founder to unmark the list", async () => {
      serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: true, reconciliation_pending: true, test_list: true, failure_reason: null }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText("May have gone out. Zavi is checking.")).toBeDefined());
      expect(document.body.textContent).not.toMatch(/marked as a test list|Unmark it/);
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    });

    it("on a test list, a send that may have gone out and was settled never tells the founder to unmark the list either", async () => {
      serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: true, reconciliation_pending: false, test_list_unknown: true, failure_reason: "Zavi could not confirm whether this email went out." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/could not confirm whether this email went out/)).toBeDefined());
      expect(document.body.textContent).not.toMatch(/marked as a test list|could not check your test lists/);
    });

    it("on a test list, a failed send that could be tried again still says why it will not be", async () => {
      serve(card({ open: false, status: "failed", chosen_variant: 1, retryable: true, may_have_sent: false, test_list: true, failure_reason: "The email tool refused the send." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/The email tool refused the send\./)).toBeDefined());
      expect(document.body.textContent).toMatch(/marked as a test list, so Zavi does not send a real email to it/);
    });

    it("on a test list, a failed Mailchimp send that cannot be tried again never tells the founder to unmark the list", async () => {
      serve(card({ route: "mailchimp", open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, test_list: true, reasons: [], failure_reason: "Mailchimp did not accept this email. Nothing was sent." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/Mailchimp did not accept this email\. Nothing was sent\./)).toBeDefined());
      expect(document.body.textContent).not.toContain(TEST_LIST_LINE);
      expect(document.body.textContent).not.toMatch(/marked as a test list|Unmark it/);
      expect(document.body.textContent).toContain("This one cannot be tried again. Ask Zavi to draft it again.");
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    });

    it("on a test list, a failed Mailchimp send the server would let be tried again says the list is why it will not be", async () => {
      serve(card({ route: "mailchimp", open: false, status: "failed", chosen_variant: 1, retryable: false, may_have_sent: false, test_list: true, reasons: [TEST_LIST_LINE], failure_reason: "Mailchimp did not accept this email. Nothing was sent." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByText(/Mailchimp did not accept this email\. Nothing was sent\./)).toBeDefined());
      expect(document.body.textContent).toContain(TEST_LIST_LINE);
      expect(document.body.textContent).not.toContain("This one cannot be tried again.");
    });

    it("on a test list, an open Mailchimp card that offers a send says the list is why it will not go", async () => {
      serve(card({ route: "mailchimp", open: true, status: "pending", test_list: true, reasons: [TEST_LIST_LINE], can_approve: [false, false, false] }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByTestId("email-card-test-list")).toBeDefined());
      expect(screen.getByTestId("email-card-test-list").textContent).toBe(TEST_LIST_LINE);
    });
  });

});

it("reconciles a refused approval with the authoritative approved version", async () => {
  serve(card({ can_approve: [true, true, true] }));
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
  answers[`POST ${BASE}/approve`] = { status: 409, body: { error: { message: "Already approved by another teammate." } } };
  const onApproved = vi.fn();
  render(<EmailCampaignCard rail="channel_actions" id={ID} onApproved={onApproved} />);
  await waitFor(() => expect(approveButton().disabled).toBe(false));
  serve(card({ open: false, status: "acted", chosen_variant: 2, can_approve: [false, false, false] }));
  fireEvent.click(approveButton());
  await screen.findByText("Approved: B");
  expect(screen.queryByText("Not approved")).toBeNull();
  expect(onApproved).toHaveBeenCalledTimes(1);
  expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
});
it("recognizes approval after the POST reply was lost without retrying", async () => {
  serve(card({ can_approve: [true, true, true] }));
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
  answers[`POST ${BASE}/approve`] = { status: 0, body: {}, error: new Error("Connection lost") };
  render(<EmailCampaignCard rail="channel_actions" id={ID} />);
  await waitFor(() => expect(approveButton().disabled).toBe(false));
  serve(card({ open: false, status: "acted", chosen_variant: 1 }));
  fireEvent.click(approveButton());
  await screen.findByText("Approved: A");
  expect(screen.queryByText("Not approved")).toBeNull();
  expect(screen.queryByText("Approval status unknown")).toBeNull();
  expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
});
it("keeps a lost approval reply uncertain when the refresh is still open", async () => {
  serve(card({ can_approve: [true, true, true] }));
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
  answers[`POST ${BASE}/approve`] = { status: 0, body: {}, error: new Error("Connection lost") };
  render(<EmailCampaignCard rail="channel_actions" id={ID} />);
  await waitFor(() => expect(approveButton().disabled).toBe(false));
  fireEvent.click(approveButton());
  await screen.findByText("Approval status unknown");
  expect(screen.queryByText("Not approved")).toBeNull();
  expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
});

it("keeps a committed approval visible until manual delivery recovery succeeds", async () => {
  serve(card({ can_approve: [true, true, true] }));
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
  answers[`POST ${BASE}/approve`] = { status: 500, body: { error: { message: "Enqueue unavailable" } } };
  const onApproved = vi.fn();
  render(<EmailCampaignCard rail="channel_actions" id={ID} onApproved={onApproved} />);
  await waitFor(() => expect(approveButton().disabled).toBe(false));
  serve(card({ open: false, status: "queued", chosen_variant: 1 }));
  fireEvent.click(approveButton());
  await screen.findByText("Approval saved; delivery unconfirmed");
  expect(onApproved).not.toHaveBeenCalled();
  const original = calls.find((call) => call.url.endsWith("/approve"))!.body;
  expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
  answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
  fireEvent.click(screen.getByRole("button", { name: "Resume approved send A" }));
  await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
  const posts = calls.filter((call) => call.url.endsWith("/approve"));
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual(original);
});
it("keeps approval uncertainty visible and actions disabled when refresh also fails", async () => {
  serve(card({ can_approve: [true, true, true] }));
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
  answers[`POST ${BASE}/approve`] = { status: 0, body: {}, error: new Error("Connection lost") };
  render(<EmailCampaignCard rail="channel_actions" id={ID} />);
  await waitFor(() => expect(approveButton().disabled).toBe(false));
  answers[`GET ${BASE}`] = { status: 0, body: {}, error: new Error("Refresh unavailable") };
  fireEvent.click(approveButton());
  await screen.findByText("Approval status unknown");
  expect(approveButton().disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
  serve(card({ open: false, status: "queued", chosen_variant: 1, can_approve: [false, false, false] }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await screen.findByRole("button", { name: "Resume approved send A" });
  fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
  expect(screen.getByRole("button", { name: "Resume approved send A" })).toBeTruthy();
  answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
  fireEvent.click(screen.getByRole("button", { name: "Resume approved send A" }));
  await screen.findByText("Approved send queued");
  const approvals = calls.filter((call) => call.url.endsWith("/approve"));
  expect(approvals).toHaveLength(2);
  expect(approvals[1].body).toEqual(approvals[0].body);
});

it("can recover a queued approved send after remount without creating a new approval", async () => {
  serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: true, can_approve: [false, false, false] }));
  answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
  render(<EmailCampaignCard rail="channel_actions" id={ID} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume approved send B" }));
  await screen.findByText("Approved send queued");
  const approvals = calls.filter((call) => call.url.endsWith("/approve"));
  expect(approvals).toHaveLength(1);
  expect(approvals[0].body).toMatchObject({ variant: 2 });
});

describe("a resume the server refuses says Not resumed with its reason", () => {
  const PAUSED = "Email is paused for this workspace. Resume email in Email campaigns settings, then approve again.";
  const IN_FLIGHT = "Another email to this list is still going out, or Zavi is still checking whether it went. Wait for it to finish before sending another one to the same list.";
  const cases: Array<[string, string | undefined, RegExp]> = [
    ["email_paused", PAUSED, /^Email is paused for this workspace/],
    ["list_send_in_flight", IN_FLIGHT, /^Another email to this list is still going out/],
    ["email_paused", undefined, /^Email is paused for this workspace/],
    ["list_send_in_flight", undefined, /^Another email to this list is still going out/],
  ];

  it.each(cases)("409 %s (message %s)", async (code, message, reason) => {
    serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: true, can_approve: [false, false, false] }));
    answers[`POST ${BASE}/approve`] = { status: 409, body: { error: message ? { code, message } : { code } } };
    const onApproved = vi.fn();
    const { container } = render(<EmailCampaignCard rail="channel_actions" id={ID} onApproved={onApproved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume approved send B" }));
    await screen.findByText("Not resumed");
    expect(screen.getByText(reason)).toBeDefined();
    if (message) expect(screen.getByText(message)).toBeDefined();
    expect(screen.queryByText("Delivery still unconfirmed")).toBeNull();
    expect(screen.queryByText("Approved send queued")).toBeNull();
    expect(container.textContent).not.toContain(code);
    expect(onApproved).not.toHaveBeenCalled();
    const resume = (await screen.findByRole("button", { name: "Resume approved send B" })) as HTMLButtonElement;
    await waitFor(() => expect(resume.disabled).toBe(false));
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    fireEvent.click(resume);
    await screen.findByText("Approved send queued");
    const approvals = calls.filter((call) => call.url.endsWith("/approve"));
    expect(approvals).toHaveLength(2);
    expect(approvals[1].body).toEqual(approvals[0].body);
  });

  it("a dropped connection or a 5xx on resume stays Delivery still unconfirmed", async () => {
    for (const a of [{ status: 0, body: {}, error: new Error("Connection lost") }, { status: 503, body: { error: { code: "provider_unavailable", message: "Zavi could not reach the sender." } } }]) {
      cleanup();
      serve(card({ open: false, status: "queued", chosen_variant: 2, retryable: true, can_approve: [false, false, false] }));
      answers[`POST ${BASE}/approve`] = a;
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Resume approved send B" }));
      await screen.findByText("Delivery still unconfirmed");
      expect(screen.queryByText("Not resumed")).toBeNull();
    }
  });
});

describe("EmailCampaignCard: a planned email's draft (Coming up)", () => {
  const PID = "11111111-1111-4111-8111-111111111111";
  const planned = (over: Record<string, unknown> = {}) => ({
    id: PID,
    planned_at: "2099-10-21T16:00:00Z",
    planned_label: "Wed, Oct 21, 09:00",
    timezone: "America/Los_Angeles",
    status: "ready",
    status_reason: null,
    reason: null,
    schedule_gen: 2,
    content_version: 1,
    vetoed: false,
    scheduled: null,
    ...over,
  });
  const SCHED = `POST /api/workspace/email-plan/${PID}/schedule`;
  const approvedCard = () => ({ ...tested(), planned: planned({ status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) });
  const tested = () => card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) });
  const withContent = () =>
    tested().versions.map((v) => ({
      ...v,
      content: { subject: v.subject, preview_text: v.preview_text, title: `Title ${v.variant}`, paragraphs: ["One."], button: { label: "Go", url: "https://brightloop.test" } },
    }));

  it("before its time the default is Approve for the planned time; Send now stays the second choice", async () => {
    serve({ ...tested(), planned: planned() });
    answers[SCHED] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-planned"));
    expect(screen.getByTestId("email-card-planned").textContent).toContain("Planned for Wed, Oct 21, 09:00 PDT");
    expect(screen.getByRole("button", { name: "Send A now" })).toBeDefined();
    serve(approvedCard());
    fireEvent.click(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    await waitFor(() => expect(screen.getByTestId("email-card-plan-notice").textContent).toContain("Approved A for Wed, Oct 21, 09:00 PDT"));
    expect(confirm.fn.mock.calls[0][0].title).toBe("Approve A for Wed, Oct 21, 09:00 PDT?");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ url: `/api/workspace/email-plan/${PID}/schedule`, method: "POST", body: { variant: 1, schedule_gen: 2, content_version: 1, request_id: expect.any(String) } }]);
  });

  it("must catch N2: a lost answer is never called Not approved: the card is read again and says what is true", async () => {
    serve({ ...tested(), planned: planned() });
    answers[SCHED] = { status: 0, body: null, error: new Error("socket hang up") };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    serve(approvedCard());
    fireEvent.click(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    expect(screen.queryByText("Not approved")).toBeNull();
  });

  it("must catch N2 + N1: when the re-read fails too it says the status is unknown, with Refresh; approving again reuses the request", async () => {
    serve({ ...tested(), planned: planned() });
    answers[SCHED] = { status: 0, body: null, error: new Error("socket hang up") };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    answers[`GET ${BASE}`] = { status: 500, body: { error: { code: "internal_error", message: "That did not work." } } };
    fireEvent.click(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    await waitFor(() => screen.getByText("Approval status unknown"));
    expect(screen.queryByText("Not approved")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
    serve({ ...tested(), planned: planned() });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("Approval status unknown")).toBeDefined();
    answers[SCHED] = { status: 200, body: { ok: true, replayed: true } };
    serve(approvedCard());
    fireEvent.click(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.method === "POST").map((c) => (c.body as { request_id: string }).request_id);
    expect(b).toBe(a);
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
  });

  describe("O1/O2: a notice states only what the server or a fresh read positively shows", () => {
    const WITHDRAW = `POST /api/workspace/email-plan/${PID}/withdraw`;
    const lost = { status: 0, body: null, error: new Error("socket hang up") };
    const approveFor = () => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" });
    const start = async (c: EmailCardView) => {
      serve(c);
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => screen.getByTestId("email-card-status"));
    };

    it("O2: a lost approval whose re-read has no plan is unknown, with Refresh, never Not approved", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      serve({ ...tested(), planned: null, planned_expected: true });
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      expect(screen.queryByText("Not approved")).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
    });

    it("fd7: a lost approval whose re-read shows the draft still unapproved stays unknown (it may land later); the next try replays the same request", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      expect(screen.queryByText("Not approved")).toBeNull();
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByTestId("email-card-scheduled"));
      const [a, b] = calls.filter((c) => c.method === "POST").map((c) => (c.body as { request_id: string }).request_id);
      expect(b).toBe(a);
    });

    it("O2: a lost approval whose re-read shows it sending says it started", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      serve({ ...tested(), planned: planned({ status: "sending" }) });
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("It has already started sending"));
    });

    it("O2: a 200 replay whose item is no longer scheduled, with a failed re-read, is unknown, not Approved", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = { status: 200, body: { ok: true, replayed: true, status: "ready" } };
      answers[`GET ${BASE}`] = { status: 500, body: { error: { code: "internal_error", message: "x" } } };
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      expect(screen.queryByText("Zavi accepted the approval. Checking…")).toBeNull();
    });

    it("O2 + P2b: a fresh 200 with a failed re-read says Zavi accepted it and is checking (never the outcome), with Refresh", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      answers[`GET ${BASE}`] = { status: 500, body: { error: { code: "internal_error", message: "x" } } };
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Zavi accepted the approval. Checking…"));
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
    });

    it("O2: Retry on a plan that did not load recomputes the notice: no stale banner next to Send now", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      serve({ ...tested(), planned: null, planned_expected: true });
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      serve({ ...tested(), planned: planned() });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => screen.getByRole("button", { name: "Send A now" }));
      expect(screen.queryByTestId("email-card-plan-missing")).toBeNull();
      expect(screen.getByTestId("email-card-plan-notice").textContent).toContain("Approval status unknown");
    });

    const lostStop = async (after: EmailCardView) => {
      await start(approvedCard());
      answers[WITHDRAW] = lost;
      serve(after);
      fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    };
    it("O1: a lost Don't send confirmed by the re-read (ready, vetoed) says Not sending", async () => {
      await lostStop({ ...tested(), planned: planned({ vetoed: true }) });
      await waitFor(() => screen.getByText(DONT_SEND_LINE));
    });
    it("O1: a lost Don't send whose re-read shows it sending says it had already started", async () => {
      await lostStop({ ...tested(), planned: planned({ status: "sent" }) });
      await waitFor(() => screen.getByText("It had already started"));
      expect(screen.queryByText(DONT_SEND_LINE)).toBeNull();
    });
    it("O1: a lost Don't send whose re-read has no plan, or a ready draft never stopped, is unknown with Refresh", async () => {
      await lostStop({ ...tested(), planned: null, planned_expected: true });
      await waitFor(() => screen.getByText("Not sure it was stopped"));
      cleanup();
      calls.length = 0;
      await lostStop({ ...tested(), planned: planned({ vetoed: false }) });
      await waitFor(() => screen.getByText("Not sure it was stopped"));
      expect(screen.queryByText(DONT_SEND_LINE)).toBeNull();
    });
    it("fd7: a lost Don't send whose re-read still shows it approved stays unknown (the stop may land later), with Refresh", async () => {
      await lostStop(approvedCard());
      await waitFor(() => screen.getByText("Not sure it was stopped"));
      expect(screen.queryByText("Still approved for its time")).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
    });

    it("P1a: Send now supersedes a pending approval only once its send was taken; cancel or a failed count keeps the request", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
      confirm.fn.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole("button", { name: "Send A now" }));
      await waitFor(() => expect(confirm.fn).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("email-card-plan-notice").textContent).toContain("Approval status unknown");
      answers[`GET ${BASE}/count`] = { status: 503, body: { error: { code: "count_required", message: "Could not count." } } };
      fireEvent.click(screen.getByRole("button", { name: "Send A now" }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/count"))).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("email-card-plan-notice").textContent).toContain("Approval status unknown"));
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(2));
      const ids = calls.filter((c) => c.url.endsWith("/schedule")).map((c) => (c.body as { request_id: string }).request_id);
      expect(ids[1]).toBe(ids[0]);
    });

    it("P1a: a Send now that was taken supersedes the pending approval (its notice goes)", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
      answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
      fireEvent.click(screen.getByRole("button", { name: "Send A now" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
      await waitFor(() => expect(screen.queryByTestId("email-card-plan-notice")).toBeNull());
    });

    it("Q1: while Send now is in flight, Refresh cannot start a read its failure handling could consume", async () => {
      await lostStop(approvedCard());
      await waitFor(() => screen.getByText("Not sure it was stopped"));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      queued[`GET ${BASE}/count`] = [{ status: 200, body: { people: 238 }, gate: held }];
      confirm.fn.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole("button", { name: "Send A now" }));
      await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true));
      release();
      await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false));
    });

    it("fd6 P2: a request that never answers releases the card after the timeout: unknown, with Refresh, and the request is kept", async () => {
      requestTimeout.ms = 60;
      try {
        await start({ ...tested(), planned: planned() });
        const never = new Promise<void>(() => undefined);
        answers[SCHED] = { status: 200, body: { ok: true }, gate: never };
        answers[`GET ${BASE}`] = { status: 200, body: { card: { ...tested(), planned: planned() } }, gate: never };
        fireEvent.click(approveFor());
        await waitFor(() => screen.getByText("Approval status unknown"));
        expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
        serve({ ...tested(), planned: planned() });
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect((approveFor() as HTMLButtonElement).disabled).toBe(false));
        answers[SCHED] = { status: 200, body: { ok: true, replayed: true, status: "scheduled" } };
        serve(approvedCard());
        fireEvent.click(approveFor());
        await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(2));
        const ids = calls.filter((c) => c.url.endsWith("/schedule")).map((c) => (c.body as { request_id: string }).request_id);
        expect(ids[1]).toBe(ids[0]);
      } finally {
        requestTimeout.ms = 30_000;
      }
    });

    it("fd6 P2: a Send now that never answers releases the card as unknown (not 'Not approved')", async () => {
      requestTimeout.ms = 60;
      try {
        await start({ ...tested(), planned: planned() });
        answers[`GET ${BASE}/count`] = { status: 200, body: { people: 238 } };
        answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true }, gate: new Promise<void>(() => undefined) };
        fireEvent.click(screen.getByRole("button", { name: "Send A now" }));
        await waitFor(() => screen.getByText("Approval status unknown"));
        expect(screen.queryByText("Not approved")).toBeNull();
        expect((screen.getByRole("button", { name: "Send A now" }) as HTMLButtonElement).disabled).toBe(false);
      } finally {
        requestTimeout.ms = 30_000;
      }
    });

    it("fd9 #1: a pending approval's id belongs to its version: approving another version waits, never reusing the id", async () => {
      const both = { ...tested(), can_approve: [true, true, false], versions: tested().versions.map((v, i) => ({ ...v, tested_by_me: i < 2, tested_by_approver: i < 2 })), planned: planned() };
      await start(both);
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
      fireEvent.click(screen.getByRole("button", { name: "Approve B for Wed, Oct 21, 09:00 PDT" }));
      await waitFor(() => screen.getByText("Waiting to confirm the earlier approval"));
      expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(1);
      fireEvent.click(screen.getByRole("tab", { name: /A · Subject 1/ }));
      answers[SCHED] = { status: 200, body: { ok: true, replayed: true, status: "scheduled" } };
      serve({ ...both, planned: planned({ status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) });
      fireEvent.click(approveFor());
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(2));
      const ids = calls.filter((c) => c.url.endsWith("/schedule")).map((c) => (c.body as { request_id: string; variant: number }));
      expect(ids[1].request_id).toBe(ids[0].request_id);
      expect(ids[1].variant).toBe(1);
    });

    it("fd10 #2: the wait for an earlier approval goes when a read settles that approval", async () => {
      const both = { ...tested(), can_approve: [true, true, false], versions: tested().versions.map((v, i) => ({ ...v, tested_by_me: i < 2, tested_by_approver: i < 2 })), planned: planned() };
      await start(both);
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      fireEvent.click(screen.getByRole("tab", { name: /B · Subject 2/ }));
      fireEvent.click(screen.getByRole("button", { name: "Approve B for Wed, Oct 21, 09:00 PDT" }));
      await waitFor(() => screen.getByText("Waiting to confirm the earlier approval"));
      serve({ ...both, planned: planned({ status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) });
      fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]);
      await waitFor(() => expect(screen.queryByText("Waiting to confirm the earlier approval")).toBeNull());
    });

    it("fd9 #2: approving after a Don't send starts from ready + stopped: an unchanged read with no answer stays unknown and keeps the id", async () => {
      await start({ ...tested(), planned: planned({ vetoed: true, schedule_gen: 3 }) });
      answers[SCHED] = lost;
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Approval status unknown"));
      expect(screen.queryByText("Stopped with Don't send")).toBeNull();
      answers[SCHED] = { status: 200, body: { ok: true, replayed: true, status: "scheduled" } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(2));
      const ids = calls.filter((c) => c.url.endsWith("/schedule")).map((c) => (c.body as { request_id: string }).request_id);
      expect(ids[1]).toBe(ids[0]);
    });

    it("P1b: an older read that finishes after a newer one never overwrites it", async () => {
      serve({ ...tested(), planned: null, planned_expected: true });
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => screen.getByTestId("email-card-plan-missing"));
      let release!: () => void;
      const slow = new Promise<void>((r) => (release = r));
      queued[`GET ${BASE}`] = [
        { status: 200, body: { card: { ...tested(), planned: null, planned_expected: true } }, gate: slow },
        { status: 200, body: { card: { ...tested(), planned: planned() } } },
      ];
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
      release();
      await slow;
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("email-card-plan-missing")).toBeNull();
      expect(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" })).toBeDefined();
    });

    it("fd5: an older read that finishes FIRST, while a newer one is in flight, is not committed; the newer one is", async () => {
      serve({ ...tested(), planned: null, planned_expected: true });
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => screen.getByTestId("email-card-plan-missing"));
      let releaseOld!: () => void;
      let releaseNew!: () => void;
      const oldGate = new Promise<void>((r) => (releaseOld = r));
      const newGate = new Promise<void>((r) => (releaseNew = r));
      queued[`GET ${BASE}`] = [
        { status: 200, body: { card: { ...tested(), planned: planned() } }, gate: oldGate },
        { status: 200, body: { card: approvedCard() }, gate: newGate },
      ];
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      releaseOld();
      await oldGate;
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByTestId("email-card-plan-missing")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" })).toBeNull();
      releaseNew();
      await waitFor(() => screen.getByTestId("email-card-scheduled"));
    });

    it("fd5: while an edit is being saved, no send, approval or stop can start (and Save waits for them)", async () => {
      const versions = tested().versions.map((v) => ({
        ...v,
        content: { subject: v.subject, preview_text: v.preview_text, title: "T", paragraphs: ["One."], button: { label: "Go", url: "https://brightloop.test" } },
      }));
      serve({ ...tested(), versions, editable: true, planned: planned() });
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => screen.getByRole("button", { name: /Edit this version/ }));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      queued[`PATCH ${BASE}/variants/1`] = [{ status: 200, body: { ok: true }, gate: held }];
      fireEvent.click(screen.getByRole("button", { name: /Edit this version/ }));
      fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "A sharper subject" } });
      fireEvent.click(screen.getByRole("button", { name: "Save version A" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      for (const name of ["Approve A for Wed, Oct 21, 09:00 PDT", "Send A now"]) {
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      }
      release();
      await waitFor(() => expect((screen.getByRole("button", { name: "Send A now" }) as HTMLButtonElement).disabled).toBe(false));
    });

    it("P2a: once a read resolves an approval, a later read showing it stopped never makes its request reusable", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByTestId("email-card-scheduled"));
      serve({ ...tested(), planned: planned({ vetoed: true }) });
      answers[`POST ${BASE}/test`] = { status: 200, body: { ok: true } };
      fireEvent.click(screen.getByRole("button", { name: "Send test of A to me" }));
      await waitFor(() => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(2));
      const ids = calls.filter((c) => c.url.endsWith("/schedule")).map((c) => (c.body as { request_id: string }).request_id);
      expect(ids[1]).not.toBe(ids[0]);
    });

    it("the wiring: a pending approval keeps its request until a read shows it; every refresh path re-derives the one notice", async () => {
      await start({ ...tested(), planned: planned() });
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      answers[`GET ${BASE}`] = { status: 500, body: { error: { code: "internal_error", message: "x" } } };
      fireEvent.click(approveFor());
      await waitFor(() => screen.getByText("Zavi accepted the approval. Checking…"));
      serve({ ...tested(), planned: planned() });
      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
      await waitFor(() => screen.getByText("Not approved"));
      expect(screen.queryByText("Zavi accepted the approval. Checking…")).toBeNull();
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => expect(screen.getByTestId("email-card-plan-notice").textContent).toContain("Approved A for"));
      const ids = calls.filter((c) => c.method === "POST").map((c) => (c.body as { request_id: string }).request_id);
      expect(ids).toHaveLength(2);
      expect(ids[1]).not.toBe(ids[0]);
      answers[`POST /api/workspace/email-plan/${PID}/withdraw`] = { status: 200, body: { ok: true } };
      serve({ ...tested(), planned: planned({ vetoed: true }) });
      fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
      await waitFor(() => screen.getByText(DONT_SEND_LINE));
      answers[SCHED] = { status: 200, body: { ok: true, replayed: false } };
      serve(approvedCard());
      fireEvent.click(approveFor());
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/schedule"))).toHaveLength(3));
      const third = (calls.filter((c) => c.url.endsWith("/schedule"))[2].body as { request_id: string }).request_id;
      expect(third).not.toBe(ids[0]);
    });
  });

  it("must catch N3: approved for its time stays approved (with Don't send) after the clock passes it, until a re-read says otherwise", async () => {
    serve({ ...tested(), planned: planned({ planned_at: "2020-01-01T00:00:00Z", status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) });
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    expect(screen.getByRole("button", { name: "Don't send" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Approve and send/ })).toBeNull();
  });

  it("must catch N4: a planned draft whose plan could not be read offers no send until it loads", async () => {
    serve({ ...tested(), planned: null, planned_expected: true });
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-plan-missing"));
    expect(screen.getByText("Could not load the plan")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Approve and send|Send A now|Approve A for/ })).toBeNull();
    serve({ ...tested(), planned: planned() });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
  });

  it("approved for its time: says so and can be stopped with Don't send", async () => {
    serve({ ...tested(), planned: planned({ status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) });
    answers[`POST /api/workspace/email-plan/${PID}/withdraw`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    expect(screen.getByText("Approved A for Wed, Oct 21, 09:00 PDT")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Approve A for/ })).toBeNull();
    serve({ ...tested(), planned: planned({ vetoed: true }) });
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/withdraw"))).toBe(true));
    await waitFor(() => screen.getByText(DONT_SEND_LINE));
  });

  it("Flow 83: a scheduled draft cannot be typed into; the line says to use Move or Don't send first", async () => {
    const line = "This email is scheduled to go out. Use Move or Don't send in Coming up first, then edit it.";
    serve({ ...approvedCard(), editable: true, versions: withContent() });
    answers[`PATCH ${BASE}/variants/1`] = { status: 409, body: { error: { code: "scheduled_send_pending", message: line } } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    const edit = screen.getByRole("button", { name: /Edit this version/ }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(screen.getByText(line)).toBeDefined();
    edit.disabled = false;
    fireEvent.click(edit);
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save version/ })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("Flow 83: the editor open when the draft gets approved for its time closes to the line, and comes back with the typed text after Don't send", async () => {
    const line = "This email is scheduled to go out. Use Move or Don't send in Coming up first, then edit it.";
    const ready = () => ({ ...tested(), editable: true, versions: withContent(), planned: planned() });
    serve(ready());
    answers[SCHED] = { status: 200, body: { ok: true } };
    answers[`POST /api/workspace/email-plan/${PID}/withdraw`] = { status: 200, body: { ok: true } };
    answers[`PATCH ${BASE}/variants/1`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Typed before the approval" } });
    serve({ ...approvedCard(), editable: true, versions: withContent() });
    fireEvent.click(screen.getByRole("button", { name: "Approve A for Wed, Oct 21, 09:00 PDT" }));
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save version/ })).toBeNull();
    expect(screen.getByText(line)).toBeDefined();
    serve({ ...ready(), planned: planned({ vetoed: true }) });
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    await waitFor(() => expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Typed before the approval"));
    expect(screen.queryByText(line)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save version A" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect((calls.find((c) => c.method === "PATCH")!.body as { content: { subject: string } }).content.subject).toBe("Typed before the approval");
  });

  it("after its time the usual Approve and send is back, with why it did not go; a Zavi list says which import it uses", async () => {
    serve({
      ...tested(),
      route: "zavi_list",
      planned: planned({ planned_at: "2020-01-01T00:00:00Z", status: "skipped", reason: "Not approved by the planned time. The draft is still there." }),
    });
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-planned-reason"));
    expect(approveButton().textContent).toContain("Approve and send A");
    expect(screen.getByText(/as it was imported when this was drafted/)).toBeDefined();
  });
});

describe("EmailCampaignCard: review fixes 2026-10-16", () => {
  const withContent = () =>
    card().versions.map((v) => ({
      ...v,
      content: { subject: v.subject, preview_text: v.preview_text, title: `Title ${v.variant}`, paragraphs: ["One."], button: { label: "Go", url: "https://brightloop.test" } },
    }));
  const tested = () => card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })) });
  const gets = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const closed = (over: Partial<EmailCardView>) => card({ open: false, chosen_variant: 1, editable: false, can_approve: [false, false, false], ...over });

  it("ZQ-1: switching to B while A is open in the editor never writes A's text into B", async () => {
    serve(card({ versions: withContent(), editable: true }));
    answers[`PATCH ${BASE}/variants/1`] = { status: 200, body: { ok: true } };
    answers[`PATCH ${BASE}/variants/2`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Fresh from the oven" } });
    const tabB = screen.getByRole("tab", { name: /B · Subject 2/ }) as HTMLButtonElement;
    tabB.disabled = false;
    fireEvent.click(tabB);
    fireEvent.keyDown(screen.getByRole("tab", { name: /A · Subject 1/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /A · Subject 1/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Save version/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toEqual([`${BASE}/variants/1`]);
    expect((patches[0].body as { content: { subject: string; title: string } }).content).toMatchObject({ subject: "Fresh from the oven", title: "Title 1" });
  });

  it("ZQ-2: right after a successful approve the card says it is sending, with no Resume button", async () => {
    serve(tested());
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 2 } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    serve(closed({ status: "queued" }));
    fireEvent.click(approveButton());
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    await waitFor(() => expect(screen.getByText("Sending A to 2 people")).toBeDefined());
    expect(screen.queryByRole("button", { name: /Resume approved send/ })).toBeNull();
    expect(screen.queryByText("Approved send pending")).toBeNull();
  });

  it("Flow 22: after approving, a Zavi list says it goes out in daily warm-up batches, never that it sends now; a tool still sends now", async () => {
    for (const route of ["zavi_list", "mailchimp", "klaviyo", "sendgrid"]) {
      serve({ ...tested(), route, sender: { email: "hello@brightloop.test", name: null } });
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 2 } };
      answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true } };
      const { container } = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(approveButton().disabled).toBe(false));
      const confirmText = () => confirm.fn.mock.calls.at(-1)![0].description as string;
      serve(closed({ status: "queued", route, sender: { email: "hello@brightloop.test", name: null } }));
      fireEvent.click(approveButton());
      await waitFor(() => expect(screen.getByText("Sending A to 2 people")).toBeDefined());
      const text = container.textContent ?? "";
      if (route === "zavi_list") {
        expect(text).not.toMatch(/sends it now/);
        expect(text).toMatch(/in batches that grow each day while your sending address warms up, so it can take a few days/);
        expect(confirmText()).toMatch(/in batches that grow each day while your sending address warms up, so it can take a few days/);
      } else {
        expect(text).toMatch(/Zavi sends it now/);
        expect(text).not.toMatch(/batches/);
      }
      cleanup();
    }
  });

  it("ZQ-2: a queued or approved card on open offers Resume only when the server marks it stuck (retryable)", async () => {
    for (const status of ["approved", "queued"]) {
      serve(closed({ status }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBeTruthy());
      await sleep(10);
      expect(screen.queryByRole("button", { name: /Resume approved send/ })).toBeNull();
      cleanup();
    }
    serve(closed({ status: "queued", retryable: true }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByRole("button", { name: "Resume approved send A" });
  });

  describe("ZQ-3: the card follows a send in flight", () => {
    beforeEach(() => {
      cardPoll.ms = 40;
    });
    afterEach(() => {
      cardPoll.ms = 5_000;
    });

    for (const status of ["approved", "queued", "dispatching", "sending"]) {
      it(`reads itself again while ${status}`, async () => {
        serve(closed({ status, route: "zavi_list" }));
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await waitFor(() => expect(gets()).toBeGreaterThanOrEqual(3), { timeout: 2000 });
      });
    }

    it("stops polling once the send ends, and shows the outcome without a reload", async () => {
      serve(closed({ status: "sending", route: "zavi_list" }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(gets()).toBeGreaterThanOrEqual(2), { timeout: 2000 });
      serve(closed({ status: "sent", route: "zavi_list", sent_at: "2026-10-16T17:05:00Z", sent_count: 2 }));
      await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBe("Sent: A"), { timeout: 2000 });
      const n = gets();
      await sleep(200);
      expect(gets()).toBe(n);
    });

    it("keeps polling an unresolved outcome until reconciliation settles it", async () => {
      serve(closed({ status: "failed", may_have_sent: true, reconciliation_pending: true, failure_reason: "SendGrid did not confirm whether this email was sent." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(gets()).toBeGreaterThanOrEqual(2), { timeout: 2000 });
      serve(closed({ status: "sent", sent_at: "2026-10-16T17:05:00Z", sent_count: 2 }));
      await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBe("Sent: A"), { timeout: 2000 });
    });

    it("a terminal outcome_unknown (decisions rail, past the bound) says it may have gone out, does not poll, and offers no resend", async () => {
      const DBASE = `/api/email-cards/decisions/${ID}`;
      const card = closed({ rail: "decisions", status: "outcome_unknown", may_have_sent: true, reconciliation_pending: false, retryable: false, dispatching_since: "2026-10-16T16:00:00Z", failure_reason: "Zavi did not hear back from the email tool about this send, so it may have gone out." });
      answers[`GET ${DBASE}`] = { status: 200, body: { card } };
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("May have gone out.");
      expect(out.textContent).not.toMatch(/Zavi is checking/);
      expect(out.textContent).not.toMatch(/was not sent/);
      const reads = () => calls.filter((c) => c.method === "GET" && c.url === DBASE).length;
      const n = reads();
      await sleep(250);
      expect(reads()).toBe(n);
      expect(screen.queryByRole("button", { name: /Try again|Approve|Resume/ })).toBeNull();
    });

    it("stops polling on unmount", async () => {
      serve(closed({ status: "sending" }));
      const view = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(gets()).toBeGreaterThanOrEqual(2), { timeout: 2000 });
      view.unmount();
      const n = gets();
      await sleep(200);
      expect(gets()).toBe(n);
    });

    it("never starts a read while the last one is still on the wire", async () => {
      serve(closed({ status: "sending" }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBeTruthy());
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      queued[`GET ${BASE}`] = [{ status: 200, body: { card: closed({ status: "sending" }) }, gate: held }];
      await waitFor(() => expect(gets()).toBe(2), { timeout: 2000 });
      await sleep(250);
      expect(gets()).toBe(2);
      release();
      await waitFor(() => expect(gets()).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    });
  });

  describe("ZQ-4: what happened to a send", () => {
    it("sent: the time with its zone, the count and every results snapshot", async () => {
      serve(closed({
        status: "sent",
        sent_at: "2026-10-16T17:05:00Z",
        sent_count: 2,
        results: { delivered: 2, opens: 1, clicks: 0, bounces: 0 },
        hour_1: { delivered: 2, opens: 1, clicks: 0, bounces: 0 },
        day_7: { delivered: 2, opens: 2, clicks: 1, bounces: 0 },
      }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(screen.getByTestId("email-card-status").textContent).toBe("Sent: A");
      expect(out.textContent).toContain("Sent to 2 people");
      expect(out.textContent).toMatch(/Oct 16, \d{1,2}:\d{2}\s?[AP]M [A-Z]{2,5}|Oct 16, \d{1,2}:\d{2}\s?[AP]M GMT[+-]\d+/);
      expect(out.textContent).toContain("Delivered 2");
      expect(out.textContent).toContain("Opens 1");
      expect(out.textContent).toContain("Clicks 0");
      expect(out.textContent).toContain("After 1 hour:");
      expect(out.textContent).toContain("At day 7:");
      expect(out.textContent).not.toContain("Results so far:");
      expect(out.textContent?.match(/Opens 2/g)).toHaveLength(1);
    });

    describe.each(["mailchimp", "klaviyo", "sendgrid", "zavi_list"] as const)("unsubscribes on a %s card", (route) => {
      const lines = async (hour_1: Record<string, unknown>, day_7: Record<string, unknown>) => {
        serve(closed({ status: "sent", route, sent_at: "2026-10-16T17:05:00Z", sent_count: 2, results: day_7, hour_1, day_7 }));
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await screen.findByTestId("email-card-outcome");
        return screen.getAllByTestId("email-card-results").map((el) => el.textContent ?? "");
      };
      const base = { delivered: 1, opens: 0, clicks: 0, bounces: null };

      it("1 at day 7 only: follows Clicks on the day 7 line, not on the hour 1 line", async () => {
        const [h1, d7] = await lines({ ...base, unsubscribes: 0 }, { ...base, unsubscribes: 1 });
        expect(h1).toBe("After 1 hour: Delivered 1 · Opens 0 · Clicks 0");
        expect(d7).toBe("At day 7: Delivered 1 · Opens 0 · Clicks 0 · Unsubscribes 1");
      });

      it("1 at hour 1 only: unknown at day 7 stays off that line", async () => {
        const [h1, d7] = await lines({ ...base, unsubscribes: 1 }, { ...base, unsubscribes: null });
        expect(h1).toBe("After 1 hour: Delivered 1 · Opens 0 · Clicks 0 · Unsubscribes 1");
        expect(d7).toBe("At day 7: Delivered 1 · Opens 0 · Clicks 0");
      });

      it("0, null or missing shows nothing on either line", async () => {
        const out = await lines({ ...base, unsubscribes: 0 }, { ...base });
        expect(out.join(" ")).not.toContain("Unsubscribes");
      });
    });

    it("a large count is formatted, and comes before Bounces", async () => {
      serve(closed({ status: "sent", route: "zavi_list", sent_count: 2, results: null, hour_1: { delivered: null, opens: null, clicks: null, unsubscribes: 1200, bounces: 2 }, day_7: null }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      expect((await screen.findByTestId("email-card-results")).textContent).toBe("After 1 hour: Unsubscribes 1,200 · Bounces 2");
    });

    it("the Zavi double-count note shows with a count and not without one", async () => {
      const note = "Someone on two of your sends that week counts on both";
      serve(closed({ status: "sent", route: "zavi_list", sent_count: 2, results: null, hour_1: { delivered: 1, unsubscribes: 0, unsubscribes_note: note }, day_7: { delivered: 1, unsubscribes: 2, unsubscribes_note: note } }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await screen.findByTestId("email-card-outcome");
      expect(screen.getAllByTestId("email-card-results-unsub-note").map((el) => el.textContent)).toEqual([`Unsubscribes: ${note}`]);
    });

    it("sent with only the first hour in: shows that row once, not again as results so far", async () => {
      serve(closed({
        status: "sent",
        sent_count: 2,
        results: { delivered: 2, opens: 1, clicks: 0, bounces: 0 },
        hour_1: { delivered: 2, opens: 1, clicks: 0, bounces: 0 },
      }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("After 1 hour:");
      expect(out.textContent).not.toContain("Results so far:");
      expect(out.textContent?.match(/Delivered 2/g)).toHaveLength(1);
    });

    it("sent with only bounces known: still shows them as results so far", async () => {
      serve(closed({ status: "sent", sent_count: 2, results: { delivered: null, opens: null, clicks: null, bounces: 1 } }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("Results so far:");
      expect(out.textContent).toContain("Bounces 1");
    });

    it("a sent Zavi-list card with no provider numbers says why Delivered, Opens and Clicks are missing, not only Bounces 0", async () => {
      const gone = "No delivery report from the sender yet";
      const off = "Click tracking is off for Zavi's sender: see Visitors";
      answers[`GET /api/email-cards/decisions/${ID}`] = { status: 200, body: { card: closed({
        rail: "decisions",
        route: "zavi_list",
        status: "sent",
        sent_count: 6,
        results: { delivered: null, opens: null, clicks: null, bounces: 0, why: { delivered: gone, opens: gone, clicks: off } },
      }) } };
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("Bounces 0");
      expect(out.textContent).toContain(`Delivered, Opens: ${gone}`);
      expect(out.textContent).toContain(`Clicks: ${off}`);
      expect(screen.getAllByTestId("email-card-results-why")).toHaveLength(2);
    });

    it("a sent Mailchimp send with no results at all says so, naming Mailchimp", async () => {
      serve(closed({ status: "sent", route: "mailchimp", sent_at: "2026-10-27T10:00:00Z", sent_count: 2, results: null, hour_1: null, day_7: null }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("Sent to 2 people");
      expect(screen.getByTestId("email-card-results-pending").textContent).toBe("Results not read from Mailchimp yet. Zavi reads them at 1 hour and day 7.");
    });

    it("the pending-results line is gone once the first hour is in", async () => {
      serve(closed({ status: "sent", route: "mailchimp", sent_count: 2, results: null, hour_1: { delivered: 2, opens: 1, clicks: 0, bounces: 0 }, day_7: null }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await screen.findByTestId("email-card-outcome");
      expect(screen.queryByTestId("email-card-results-pending")).toBeNull();
    });

    it("a sent Zavi-list card with its own reasons gets no second pending line", async () => {
      const gone = "No delivery report from the sender yet";
      answers[`GET /api/email-cards/decisions/${ID}`] = { status: 200, body: { card: closed({
        rail: "decisions",
        route: "zavi_list",
        status: "sent",
        sent_count: 6,
        results: { delivered: null, opens: null, clicks: null, bounces: 0, why: { delivered: gone, opens: gone, clicks: null } },
      }) } };
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      await screen.findByTestId("email-card-outcome");
      expect(screen.queryByTestId("email-card-results-pending")).toBeNull();
    });

    it("a sent Zavi-list send with no results at all says so, naming Zavi", async () => {
      answers[`GET /api/email-cards/decisions/${ID}`] = { status: 200, body: { card: closed({
        rail: "decisions",
        route: "zavi_list",
        status: "sent",
        sent_count: 6,
        results: null,
        hour_1: null,
        day_7: null,
      }) } };
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      await screen.findByTestId("email-card-outcome");
      expect(screen.getByTestId("email-card-results-pending").textContent).toBe("Results not read from Zavi yet. Zavi reads them at 1 hour and day 7.");
    });

    it("a failed send shows no pending-results line", async () => {
      serve(closed({ status: "not_sent", route: "mailchimp", chosen_variant: null, failure_reason: "Mailchimp refused it.", results: null, hour_1: null, day_7: null }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await screen.findByTestId("email-card-outcome");
      expect(screen.queryByTestId("email-card-results-pending")).toBeNull();
    });

    it("a sent card with real counts shows the numbers and no reasons", async () => {
      serve(closed({
        status: "sent",
        sent_count: 6,
        results: { delivered: 6, opens: 3, clicks: 1, bounces: 0, why: { delivered: null, opens: null, clicks: null } },
      }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("Delivered 6 · Opens 3 · Clicks 1 · Bounces 0");
      expect(screen.queryByTestId("email-card-results-why")).toBeNull();
    });

    it("a missing count with no reason from the server stays quiet instead of inventing one", async () => {
      serve(closed({ status: "sent", sent_count: 2, results: { delivered: 2, opens: null, clicks: 0, bounces: 0 } }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const out = await screen.findByTestId("email-card-outcome");
      expect(out.textContent).toContain("Delivered 2 · Clicks 0 · Bounces 0");
      expect(screen.queryByTestId("email-card-results-why")).toBeNull();
    });

    it("partially sent, unknown, stopped, and not sent each say so honestly", async () => {
      const cases: Array<[Partial<EmailCardView>, string, string]> = [
        [{ status: "partially_sent", sent_count: 120, failure_reason: "SendGrid stopped accepting mail." }, "Partly sent: A", "Sent to 120 people"],
        [{ status: "outcome_unknown", sent_count: 0, failure_reason: "Some deliveries could not be confirmed." }, "Delivery unknown: A", "May have gone out."],
        [{ status: "stopped", sent_count: 30 }, "Stopped: A", "Stopped after 30 people"],
        [{ status: "not_sent", chosen_variant: null, failure_reason: "Sending is paused for this workspace." }, "Not sent", "Sending is paused for this workspace."],
      ];
      for (const [over, pill, line] of cases) {
        serve(closed(over));
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        const out = await screen.findByTestId("email-card-outcome");
        expect(screen.getByTestId("email-card-status").textContent).toBe(pill);
        expect(out.textContent).toContain(line);
        if (over.failure_reason) expect(out.textContent).toContain(over.failure_reason);
        cleanup();
      }
    });

    it("failed (and a decisions-rail dispatch_failed) reads as failed with its reason, never Approved", async () => {
      serve(closed({ status: "failed", chosen_variant: 2, failure_reason: "SendGrid is not connected." }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await screen.findByText(/SendGrid is not connected\./);
      expect(screen.getByTestId("email-card-status").textContent).toBe("Failed: B");
      cleanup();
      const DBASE = `/api/email-cards/decisions/${ID}`;
      answers[`GET ${DBASE}`] = { status: 200, body: { card: closed({ rail: "decisions", status: "dispatch_failed", failure_reason: "The email tool refused the send." }) } };
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      await screen.findByText(/The email tool refused the send\./);
      expect(screen.getByTestId("email-card-status").textContent).toBe("Failed: A");
      expect(screen.queryByText(/^Approved/)).toBeNull();
    });
  });

  describe("Stop the rest (zavi_list in flight)", () => {
    const sending = (over: Partial<EmailCardView> = {}) => closed({ status: "sending", route: "zavi_list", sender: { email: "hello@brightloop.test", name: null }, ...over });

    it("asks first, saying who is not sent yet, then POSTs /stop and says how many were spared", async () => {
      serve(sending());
      answers[`POST ${BASE}/stop`] = { status: 200, body: { stopped: 208, already_sent: 30 } };
      const onChanged = vi.fn();
      render(<EmailCampaignCard rail="channel_actions" id={ID} onChanged={onChanged} />);
      serve(sending({ status: "stopped", sent_count: 30 }));
      fireEvent.click(await screen.findByRole("button", { name: "Stop the rest" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/stop"))).toBe(true));
      const opts = confirm.fn.mock.calls[0][0];
      expect(opts.title).toMatch(/Stop/);
      expect(opts.description).toMatch(/not been sent yet/);
      expect(opts.description).toMatch(/already/);
      expect(calls.find((c) => c.url.endsWith("/stop"))!.method).toBe("POST");
      await screen.findByText("Stopped. 30 people already got it; 208 will not.");
      await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBe("Stopped: A"));
      expect(onChanged).toHaveBeenCalled();
    });

    it("cancel at the confirm stops nothing; a refusal shows its reason, not an unknown", async () => {
      serve(sending());
      confirm.fn.mockResolvedValueOnce(false);
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop the rest" }));
      await waitFor(() => expect(confirm.fn).toHaveBeenCalledTimes(1));
      await sleep(10);
      expect(calls.some((c) => c.url.endsWith("/stop"))).toBe(false);
      answers[`POST ${BASE}/stop`] = { status: 409, body: { error: { code: "not_stoppable", message: "This send already finished." } } };
      fireEvent.click(screen.getByRole("button", { name: "Stop the rest" }));
      await screen.findByText("This send already finished.");
      expect(screen.queryByText(/unknown/i)).toBeNull();
    });

    it("not offered for a tool route, a member, or a finished send", async () => {
      for (const c of [sending({ route: "sendgrid" }), sending({ viewer_can_approve: false }), sending({ status: "sent" })]) {
        serve(c);
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBeTruthy());
        expect(screen.queryByRole("button", { name: "Stop the rest" })).toBeNull();
        cleanup();
      }
    });

    it("the approve confirm names the sending tool; a Zavi list can be stopped and paces for warm-up, a tool cannot be undone", async () => {
      const routes: Array<[string, RegExp, boolean]> = [
        ["zavi_list", /from hello@brightloop\.test\. Sent by Zavi in batches/, false],
        ["sendgrid", /via SendGrid/, true],
        ["mailchimp", /via Mailchimp/, true],
      ];
      for (const [route, names, final] of routes) {
        confirm.fn.mockClear();
        confirm.fn.mockResolvedValue(false);
        serve({ ...tested(), route, sender: { email: "hello@brightloop.test", name: route === "zavi_list" ? null : "Brightloop" } });
        answers[`GET ${BASE}/count`] = { status: 200, body: { people: 2 } };
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await waitFor(() => expect(approveButton().disabled).toBe(false));
        fireEvent.click(approveButton());
        await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
        const d = confirm.fn.mock.calls[0][0].description!;
        expect(d).toMatch(names);
        if (final) expect(d).toContain(CANNOT_UNDO);
        else {
          expect(d).not.toContain(CANNOT_UNDO);
          expect(d).toMatch(/not been sent yet can still be stopped/);
          expect(d).toMatch(/warm/);
        }
        cleanup();
      }
    });
  });

  it("Flow 22: the Send now confirm for a Zavi list names the from address once; a tool route still names its tool", async () => {
    const once = (text: string, needle: string) => text.split(needle).length - 1;
    for (const [route, name] of [["zavi_list", null], ["zavi_list", "Private Rents"], ["mailchimp", "Private Rents"], ["klaviyo", null], ["sendgrid", "Private Rents"]] as Array<[string, string | null]>) {
      confirm.fn.mockClear();
      confirm.fn.mockResolvedValue(false);
      serve({ ...tested(), route, sender: { email: "hello@private-rents.com", name } });
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 2 } };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(approveButton().disabled).toBe(false));
      fireEvent.click(approveButton());
      await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
      const { title, description } = confirm.fn.mock.calls[0][0];
      const dialog = `${title} ${description}`;
      expect(title).toBe("Send to 2 people?");
      expect(once(dialog, "hello@private-rents.com")).toBe(1);
      if (route === "zavi_list") {
        expect(dialog).not.toMatch(/Sent by Zavi from/);
        expect(dialog).toMatch(/\. Sent by Zavi in batches that grow each day while your sending address warms up, so it can take a few days\. /);
      } else {
        expect(dialog).toMatch(new RegExp(`from ${name ? `${name} <hello@private-rents\\.com>` : "hello@private-rents\\.com"} via ${{ mailchimp: "Mailchimp", klaviyo: "Klaviyo", sendgrid: "SendGrid" }[route]}\\. ${CANNOT_UNDO.replace(/[.']/g, "\\$&")}`));
      }
      cleanup();
    }
  });

  it("Flow 23: while email is paused the approve confirm says so and the button says send when resumed; approving is still allowed", async () => {
    serve(tested());
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 6 } };
    answers["GET /api/workspace/email-pause"] = { status: 200, body: { paused: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    const { description, confirmLabel } = confirm.fn.mock.calls[0][0];
    expect(description).toMatch(/Email is paused for this workspace/);
    expect(description).toMatch(/starts when an owner or admin resumes email/);
    expect(confirmLabel).toBe("Approve, send when resumed");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/approve`)).toBe(true));
  });

  it("Flow 23: when email is running, or the pause read fails, the confirm is the plain Send now", async () => {
    for (const a of [{ status: 200, body: { paused: false } }, { status: 500, body: {} }, { status: 200, body: {}, error: new Error("offline") }] as Answer[]) {
      confirm.fn.mockClear();
      confirm.fn.mockResolvedValue(false);
      serve(tested());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: 6 } };
      answers["GET /api/workspace/email-pause"] = a;
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(approveButton().disabled).toBe(false));
      fireEvent.click(approveButton());
      await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
      const { description, confirmLabel } = confirm.fn.mock.calls[0][0];
      expect(description).not.toMatch(/paused/);
      expect(confirmLabel).toBe("Send now");
      cleanup();
    }
  });

  describe("ZQ-5: the preview", () => {
    it("grows to the email's full height, so the footer is never cut off", async () => {
      serve(card());
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const frame = (await screen.findByTitle("Email preview, version A")) as HTMLIFrameElement;
      expect(frame.getAttribute("sandbox") ?? "").not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-top-navigation/);
      Object.defineProperty(frame, "contentDocument", { configurable: true, value: { documentElement: { scrollHeight: 911 }, body: { scrollHeight: 640 } } });
      fireEvent.load(frame);
      await waitFor(() => expect(frame.style.height).toBe("911px"));
    });

    it("stays on screen while a version is being edited", async () => {
      serve(card({ versions: withContent(), editable: true }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
      expect(screen.getByRole("form", { name: "Edit version A" })).toBeDefined();
      expect(screen.getByTitle("Email preview, version A")).toBeDefined();
    });

    it("has a phone-width toggle", async () => {
      serve(card());
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const frame = (await screen.findByTitle("Email preview, version A")) as HTMLIFrameElement;
      const phone = screen.getByRole("button", { name: "Phone width" });
      expect(phone.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(phone);
      expect(phone.getAttribute("aria-pressed")).toBe("true");
      expect(frame.style.maxWidth).toBe("375px");
    });
  });

  it("ZQ-8: Send test names the address it goes to, on the button and in the banner", async () => {
    viewer.email = "owner@brightloop.test";
    serve(card());
    answers[`POST ${BASE}/test`] = { status: 200, body: { ok: true } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const btn = await screen.findByRole("button", { name: "Send test of A to owner@brightloop.test" });
    fireEvent.click(btn);
    await screen.findByText("Test of A sent to owner@brightloop.test");
  });

  describe("refusals read as refusals", () => {
    it("approve refused with count_required (503 or 409) says Not approved with the reason, never status unknown", async () => {
      for (const status of [503, 409]) {
        serve(tested());
        answers[`GET ${BASE}/count`] = { status: 200, body: { people: 2 } };
        answers[`POST ${BASE}/approve`] = { status, body: { error: { code: "count_required", message: "Zavi could not count the people on the list right now, so nothing was sent." } } };
        render(<EmailCampaignCard rail="channel_actions" id={ID} />);
        await waitFor(() => expect(approveButton().disabled).toBe(false));
        fireEvent.click(approveButton());
        await screen.findByText("Not approved");
        expect(screen.getByText(/so nothing was sent/)).toBeDefined();
        expect(screen.queryByText("Approval status unknown")).toBeNull();
        cleanup();
      }
    });

    it("a test the email tool refused (502 provider_refused) says it was not sent", async () => {
      serve(card());
      answers[`POST ${BASE}/test`] = { status: 502, body: { error: { code: "provider_refused", message: "SendGrid refused the test: sender not verified." } } };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: /Send test of A to me/ }));
      await screen.findByText("The test was not sent");
      expect(screen.queryByText("Test status unknown")).toBeNull();
    });

    it("a count with no number never asks 'Send to 0 people?'", async () => {
      serve(tested());
      answers[`GET ${BASE}/count`] = { status: 200, body: { people: null } };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(approveButton().disabled).toBe(false));
      fireEvent.click(approveButton());
      await screen.findByText("Not approved");
      expect(confirm.fn).not.toHaveBeenCalled();
      expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(false);
    });
  });

  describe("copy and accessibility", () => {
    it("names the route next to From and calls the win line the goal for day 7", async () => {
      serve(card({ win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, frozen: false } }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const from = await screen.findByTestId("email-card-from");
      expect(from.textContent).toContain("hello@brightloop.test");
      expect(from.textContent).toContain("via SendGrid");
      expect(screen.getByText("Goal for day 7")).toBeDefined();
      expect(screen.queryByText(/Win line/)).toBeNull();
    });

    it("a planned time carries its time-zone abbreviation", async () => {
      serve({ ...tested(), planned: { id: "p1", planned_at: "2099-10-21T16:00:00Z", planned_label: "Wed, Oct 21, 09:00", timezone: "America/Los_Angeles", status: "ready", status_reason: null, reason: null, schedule_gen: 1, content_version: 1, vetoed: false, scheduled: null } });
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const chip = await screen.findByTestId("email-card-planned");
      expect(chip.textContent).toContain("Wed, Oct 21, 09:00 PDT");
    });

    it("version tabs follow the tab pattern: panel wiring, roving focus, arrow keys", async () => {
      serve(card());
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      const a = await screen.findByRole("tab", { name: /A · Subject 1/ });
      const b = screen.getByRole("tab", { name: /B · Subject 2/ });
      const panel = screen.getByRole("tabpanel");
      expect(a.getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(a.id);
      expect(a.getAttribute("tabindex")).toBe("0");
      expect(b.getAttribute("tabindex")).toBe("-1");
      fireEvent.keyDown(a, { key: "ArrowRight" });
      expect(b.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(b);
      fireEvent.keyDown(b, { key: "End" });
      expect(screen.getByRole("tab", { name: /C · Subject 3/ }).getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(screen.getByRole("tab", { name: /C · Subject 3/ }), { key: "ArrowRight" });
      expect(a.getAttribute("aria-selected")).toBe("true");
    });

    it("the loading skeleton is announced as a status", async () => {
      answers[`GET ${BASE}`] = { status: 200, body: { card: card() }, gate: new Promise<void>(() => undefined) };
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      expect(screen.getByRole("status", { name: "Loading email" })).toBeDefined();
    });

    it("edit fields are 16px so phones do not zoom in", async () => {
      serve(card({ versions: withContent(), editable: true }));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      fireEvent.click(await screen.findByRole("button", { name: /Edit this version/ }));
      for (const label of ["Subject", "Preview text", "Title", "Button label"]) {
        expect((screen.getByLabelText(label) as HTMLElement).className).toContain("text-[16px]");
      }
    });
  });
});

describe("EmailCampaignCard: an approved-for-time card follows itself to the send", () => {
  const PID = "11111111-1111-4111-8111-111111111111";
  const NOW = Date.parse("2026-10-26T12:00:00Z");
  const MIN = 60_000;
  const reads = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
  const plan = (at: number, status = "scheduled") => ({
    id: PID,
    planned_at: new Date(at).toISOString(),
    planned_label: "Mon, Oct 26, 05:10",
    timezone: "America/Los_Angeles",
    status,
    status_reason: null,
    reason: null,
    schedule_gen: 2,
    content_version: 1,
    vetoed: false,
    scheduled: status === "scheduled" ? { variant: 1, count: 238, by: "u" } : null,
  });
  const approved = (at: number) => card({ can_approve: [true, false, false], versions: card().versions.map((v, i) => ({ ...v, tested_by_me: i === 0, tested_by_approver: i === 0 })), planned: plan(at) });
  const taken = (status: string, over: Partial<EmailCardView> = {}) => card({ open: false, status, chosen_variant: 1, editable: false, can_approve: [false, false, false], route: "zavi_list", ...over });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("days out it reads itself rarely, never every few seconds", async () => {
    serve(approved(NOW + 3 * 24 * 60 * MIN));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByTestId("email-card-scheduled-tracker");
    const n = reads();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(reads()).toBe(n);
    await vi.advanceTimersByTimeAsync(6 * 60 * MIN);
    expect(reads() - n).toBeGreaterThanOrEqual(1);
    expect(reads() - n).toBeLessThanOrEqual(24);
    expect(screen.getByTestId("email-card-scheduled-tracker").textContent).toContain("Goes out");
  });

  it("once its time comes it reads itself, flips from Goes out to sending, then to sent, and then stops", async () => {
    serve(approved(NOW + 10 * MIN));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByTestId("email-card-scheduled-tracker");
    expect(screen.getByTestId("email-card-scheduled-tracker").textContent).toContain("Goes out");
    const n = reads();
    await vi.advanceTimersByTimeAsync(7 * MIN);
    expect(reads()).toBe(n);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(reads() - n).toBeGreaterThanOrEqual(2);
    serve(taken("sending", { sent_count: 40 }));
    await vi.advanceTimersByTimeAsync(cardPoll.ms + 100);
    await waitFor(() => expect(screen.queryByTestId("email-card-scheduled-tracker")).toBeNull());
    expect(screen.getByTestId("email-card-in-flight").textContent).toContain("Sending A to Brightloop members.");
    expect(document.body.textContent).not.toContain("Goes out");
    serve(taken("sent", { sent_count: 238, sent_at: new Date(NOW + 11 * MIN).toISOString() }));
    await vi.advanceTimersByTimeAsync(cardPoll.ms + 100);
    await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toBe("Sent: A"));
    const done = reads();
    await vi.advanceTimersByTimeAsync(cardPoll.dispatchingMs + cardPoll.scheduledFarMs * 4);
    expect(reads()).toBe(done);
  });

  it("unmounted mid-wait it reads nothing more", async () => {
    serve(approved(NOW + 10 * MIN));
    const view = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByTestId("email-card-scheduled-tracker");
    await vi.advanceTimersByTimeAsync(8 * MIN + cardPoll.ms);
    const n = reads();
    expect(n).toBeGreaterThanOrEqual(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(cardPoll.dispatchingMs + cardPoll.scheduledFarMs * 4);
    expect(reads()).toBe(n);
  });

  it("a Zavi list send waiting for the next day's allowance reads itself about once a minute, not every few seconds, and does not promise the rest tomorrow", async () => {
    serve(taken("waiting_for_tomorrow", { sent_count: 50 }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    const line = await screen.findByTestId("email-card-in-flight");
    expect(line.textContent).toContain("50 people sent so far. The rest go out over the coming days: Zavi sends a limited number of emails each day, fewer while a new sending address warms up.");
    expect(line.textContent).not.toMatch(/tomorrow|every few seconds/);
    expect(line.textContent).not.toMatch(/checks about once a minute|updates itself/);
    const n = reads();
    await vi.advanceTimersByTimeAsync(cardPoll.pausedMs - cardPoll.ms);
    expect(reads()).toBe(n);
    await vi.advanceTimersByTimeAsync(cardPoll.ms + 100);
    expect(reads() - n).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(reads() - n).toBeLessThanOrEqual(12);
  });

  it("withdrawn back to ready on a read, it stops reading itself", async () => {
    serve(approved(NOW + 10 * MIN));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findByTestId("email-card-scheduled-tracker");
    serve({ ...approved(NOW + 10 * MIN), planned: { ...plan(NOW + 10 * MIN, "ready"), vetoed: true } });
    await vi.advanceTimersByTimeAsync(8 * MIN + 100);
    await waitFor(() => expect(screen.queryByTestId("email-card-scheduled-tracker")).toBeNull());
    const n = reads();
    await vi.advanceTimersByTimeAsync(cardPoll.dispatchingMs + cardPoll.scheduledFarMs * 4);
    expect(reads()).toBe(n);
  });
});

describe("EmailCampaignCard: a planned email whose planned time has passed can be rejected", () => {
  const PID = "33333333-3333-4333-8333-333333333333";
  const NOW = Date.parse("2026-10-28T12:00:00Z");
  const REJECT = `POST /api/channel-actions/${ID}`;
  const planAt = (iso: string, over: Record<string, unknown> = {}) => ({
    id: PID,
    planned_at: iso,
    planned_label: "Thu, Oct 22, 09:00",
    timezone: "UTC",
    status: "ready",
    status_reason: null,
    reason: null,
    schedule_gen: 1,
    content_version: 1,
    vetoed: false,
    scheduled: null,
    ...over,
  });
  const plannedCard = (iso: string, over: Record<string, unknown> = {}, cardOver: Partial<EmailCardView> = {}) =>
    card({ viewer_can_approve: true, can_approve: [true, false, false], planned_expected: true, planned: planAt(iso, over), ...cardOver } as Partial<EmailCardView>);
  const rejectButton = () => screen.queryByRole("button", { name: "Reject" });
  const rejectWrites = () => calls.filter((c) => c.method === "POST" && c.url === `/api/channel-actions/${ID}`);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a past-plan card shows Reject, and confirming it posts one reject with the card id", async () => {
    answers[REJECT] = { status: 200, body: {} };
    serve(plannedCard("2026-10-22T16:00:00Z"));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(rejectButton()).not.toBeNull());
    fireEvent.click(rejectButton()!);
    const form = await screen.findByTestId("email-card-reject");
    fireEvent.click(form.querySelector("button[type=submit]") as HTMLButtonElement);
    fireEvent.click(form.querySelector("button[type=submit]") as HTMLButtonElement);
    await waitFor(() => expect(rejectWrites().length).toBe(1));
    expect(rejectWrites()[0].body).toMatchObject({ action: "rejected" });
    expect(calls.filter((c) => c.method !== "GET" && !c.url.endsWith(ID)).length).toBe(0);
  });

  it("a future-plan card shows no Reject", async () => {
    serve(plannedCard("2026-10-29T16:00:00Z"));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-planned")).toBeDefined());
    expect(rejectButton()).toBeNull();
  });

  it("a scheduled card whose time has passed keeps Don't send and shows no Reject", async () => {
    serve(plannedCard("2026-10-22T16:00:00Z", { status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Don.t send/ })).toBeDefined());
    expect(rejectButton()).toBeNull();
  });

  it("a scheduled future card keeps Don't send and shows no Reject", async () => {
    serve(plannedCard("2026-10-29T16:00:00Z", { status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Don.t send/ })).toBeDefined());
    expect(rejectButton()).toBeNull();
  });

  it("a plan exactly at now counts as passed and shows Reject; one millisecond ahead does not", async () => {
    serve(plannedCard(new Date(NOW).toISOString()));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-planned")).toBeDefined());
    expect(rejectButton()).not.toBeNull();
    cleanup();
    serve(plannedCard(new Date(NOW + 1).toISOString()));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-planned")).toBeDefined());
    expect(rejectButton()).toBeNull();
  });

  it("a planned card whose plan could not be read still shows no Reject", async () => {
    serve(card({ planned_expected: true, planned: null }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
    await waitFor(() => expect(screen.getByText(/could not load its plan/)).toBeDefined());
    expect(rejectButton()).toBeNull();
  });

  it("a card that becomes past while mounted gets Reject only on the next render, not from the clock alone", async () => {
    cleanup();
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    serve(plannedCard(new Date(NOW + 60_000).toISOString()));
    const view = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-planned")).toBeDefined());
    expect(rejectButton()).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rejectButton()).toBeNull();
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);
    view.rerender(<EmailCampaignCard rail="channel_actions" id={ID} />);
    expect(rejectButton()).not.toBeNull();
  });
});
