// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: { add: (o: unknown) => toastAdd(o) } }));
const toasted = (title: string) => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string; description?: string; confirmLabel?: string }[] }));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  confirmAction: (o: { title: string; description?: string; confirmLabel?: string }) => {
    confirm.asked.push(o);
    return Promise.resolve(confirm.answer);
  },
}));

import { EmailTestListsBlock, TEST_LIST_COPY, toolProblemLine } from "../EmailTestListsBlock";
import { ChannelSettingsPanels } from "../EmailSettingsPanels";

const view = (over: Record<string, unknown> = {}) => ({
  routes: [
    { route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [
      { id: "L1", name: "Customers", people: 20, marked: false, looks_like_test: false },
      { id: "L2", name: "Internal test", people: 3, marked: false, looks_like_test: true },
    ] },
    { route: "klaviyo", label: "Klaviyo", status: "partial", error: "Klaviyo has more lists than Zavi could read in time.", lists: [] },
    { route: "sendgrid", label: "SendGrid", status: "not_connected", error: null, lists: [] },
    { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: true, looks_like_test: false }] },
  ],
  orphans: [
    { route: "mailchimp", list_id: "gone1", reason: "not_found", can_unmark: true, note: "Not found in the account connected now. Reconnecting the account this list was in could let a real email reach it again." },
    { route: "klaviyo", list_id: "K9", reason: "not_checked", can_unmark: false, note: "Zavi could not read every list here, so it may still be there." },
  ],
  ...over,
});
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

beforeEach(() => {
  calls.length = 0;
  toastAdd.mockClear();
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  confirm.answer = true;
  confirm.asked.length = 0;
  set("GET /api/workspace/email-test-lists", view());
  set("POST /api/workspace/email-test-lists", { ok: true, changed: true, marked: true });
});
afterEach(cleanup);

describe("Test lists block", () => {
  it("marks ONE list per click, never a whole-field save", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Customers")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/workspace/email-test-lists", method: "POST", body: { route: "mailchimp", list_id: "L1", marked: true } });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a name that looks like a test gets a hint, not a mark; a marked Zavi list shows checked", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText(TEST_LIST_COPY.testGroup)).toBeDefined());
    expect(screen.queryByText(TEST_LIST_COPY.hint)).toBeNull();
    expect((screen.getByRole("checkbox", { name: /Internal test/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Members/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("a mark gone after a complete read can come off; one not checked cannot; a partial read says so", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("A list you marked is no longer in Mailchimp.")).toBeDefined());
    expect(screen.getAllByRole("button", { name: "Unmark" })).toHaveLength(1);
    expect(screen.getByText(/Reconnecting the account/)).toBeDefined();
    expect(screen.getByTestId("test-lists-partial").textContent).toBe("Not every Klaviyo list could be read. Marks stay on until a full read.");
    expect(screen.queryByText(/Klaviyo has more lists than Zavi could read in time/)).toBeNull();
    expect(within(screen.getByTestId("test-lists-klaviyo")).getByText("Zavi can't check your Klaviyo test list right now. It stays protected until it can.")).toBeDefined();
    expect(screen.queryByText(/so it may still be there/)).toBeNull();
    expect(screen.queryByText(/was not checked yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ route: "mailchimp", list_id: "gone1", marked: false });
  });

  it("Unmark on a list gone from the account asks first: cancel writes nothing, confirm writes once", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Unmark" })).toBeDefined());
    confirm.answer = false;
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    await waitFor(() => expect(confirm.asked).toHaveLength(1));
    expect(confirm.asked[0]).toEqual({
      title: "Remove this test mark?",
      description: "Today Zavi never sends a real email to this list. After this, an approved email or Autopilot can send to everyone on it.",
      confirmLabel: "Remove test mark",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Unmark" })).toBeDefined();
    confirm.answer = true;
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    await waitFor(() => toasted('"That list" is no longer a test list.'));
    expect(confirm.asked).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ route: "mailchimp", list_id: "gone1", marked: false }]);
  });

  it("a member sees the marks and cannot change them; a refused change shows the server's sentence", async () => {
    ws.role = "member";
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText(/Only a workspace owner or admin/)).toBeDefined());
    expect((screen.getByRole("checkbox", { name: /Customers/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Unmark" })).toBeNull();
    cleanup();
    ws.role = "owner";
    set("POST /api/workspace/email-test-lists", { error: { code: "could_not_check", message: "Zavi could not read every list in that account." } }, 409);
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Customers")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => expect(screen.getByText("Zavi could not read every list in that account.")).toBeDefined());
  });

  it("on a route not read in full, a marked list cannot be unmarked (marking still works)", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [{ route: "klaviyo", label: "Klaviyo", status: "partial", error: null, lists: [
        { id: "K1", name: "VIP", people: 20, marked: true, looks_like_test: false },
        { id: "K2", name: "Leads", people: 90, marked: false, looks_like_test: false },
      ] }],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("VIP")).toBeDefined());
    expect((screen.getByRole("checkbox", { name: /VIP/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Leads/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it("success is said only after the lists read back; a failed read-back says so instead", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Customers")).toBeDefined());
    set("GET /api/workspace/email-test-lists", { error: { message: "down" } }, 500);
    fireEvent.click(screen.getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => expect(screen.getByText(TEST_LIST_COPY.refreshFailed)).toBeDefined());
    expect(toastAdd).not.toHaveBeenCalled();
    cleanup();
    set("GET /api/workspace/email-test-lists", view());
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Customers")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => toasted('"Customers" is a test list now.'));
  });

  it("one list for every tool: each row names its tool, no per-tool box, and no group caption when only one group exists", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [
        { route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [{ id: "L1", name: "Customers", people: 20, marked: false, looks_like_test: false }] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 4000, marked: false, looks_like_test: false }] },
      ],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Customers")).toBeDefined());
    const lists = screen.getAllByTestId("test-lists-rows");
    expect(lists).toHaveLength(1);
    const rows = within(lists[0]).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Mailchimp")).toBeDefined();
    expect(within(rows[1]).getByText("Zavi lists")).toBeDefined();
    expect(screen.queryByText(TEST_LIST_COPY.realGroup)).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByText(/Real people/)).toBeNull();
    expect(within(rows[1]).queryByText(/large/)).toBeNull();
    expect(within(rows[1]).getByText("4,000 people")).toBeDefined();
    expect(within(rows[1]).getByText("4,000 people").className).toContain("bg-bone");
  });

  it("tools that cannot be read get one shared line, with no per-tool problem text", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [
        { route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Klaviyo could not be read right now.", lists: [] },
        { route: "sendgrid", label: "SendGrid", status: "unreadable", error: "SendGrid rejected the key Zavi has saved for it.", lists: [] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 4, marked: false, looks_like_test: false }] },
      ],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Members")).toBeDefined());
    expect(screen.getByTestId("test-lists-unreadable").textContent).toBe("Klaviyo and SendGrid lists can't be read right now, so they can't be marked.");
    expect(screen.queryByText(TEST_LIST_COPY.unreadable)).toBeNull();
    expect(screen.queryByText(TEST_LIST_COPY.keyRejected)).toBeNull();
    expect(screen.queryByText(/Reconnect/)).toBeNull();
  });

  it("the Sending tool lines say what is wrong in a few words", () => {
    expect(toolProblemLine("unreadable", "SendGrid rejected the key Zavi has saved for it.")).toBe("Its key stopped working");
    expect(toolProblemLine("unreadable", "Klaviyo could not be read right now.")).toBe("Can't reach it right now");
    expect(toolProblemLine("complete", null)).toBeNull();
  });

  it("unticking a marked list asks first: cancel keeps it marked and writes nothing, confirm writes once", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [{ route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [
        { id: "M1", name: "Brightloop QA", people: 3, marked: true, looks_like_test: true },
      ] }],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Brightloop QA")).toBeDefined());
    const box = () => screen.getByRole("checkbox", { name: /Brightloop QA/ }) as HTMLInputElement;
    confirm.answer = false;
    fireEvent.click(box());
    await waitFor(() => expect(confirm.asked).toHaveLength(1));
    expect(confirm.asked[0]).toEqual({
      title: 'Let Zavi send real emails to "Brightloop QA"?',
      description: "Today Zavi never sends a real email to this list. After this, an approved email or Autopilot can send to everyone on it.",
      confirmLabel: "Remove test mark",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    confirm.answer = true;
    fireEvent.click(box());
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(confirm.asked).toHaveLength(2);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ route: "mailchimp", list_id: "M1", marked: false });
    await waitFor(() => toasted('"Brightloop QA" is no longer a test list.'));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("ticking a small list under Real audiences asks first and writes nothing on cancel", async () => {
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByRole("group", { name: TEST_LIST_COPY.realGroup })).toBeDefined());
    const real = screen.getByRole("group", { name: TEST_LIST_COPY.realGroup });
    confirm.answer = false;
    fireEvent.click(within(real).getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => expect(confirm.asked).toHaveLength(1));
    expect(confirm.asked[0].title).toBe('Mark "Customers" as a test list?');
    expect(confirm.asked[0].description).toContain("Once it is a test list, Zavi never sends a real email to it");
    expect(confirm.asked[0].description).toContain("It has 20 people, in Mailchimp.");
    expect(confirm.asked[0].confirmLabel).toBe("Mark as a test list");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((within(real).getByRole("checkbox", { name: /Customers/ }) as HTMLInputElement).checked).toBe(false);
    confirm.answer = true;
    fireEvent.click(within(real).getByRole("checkbox", { name: /Customers/ }));
    await waitFor(() => toasted('"Customers" is a test list now.'));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ route: "mailchimp", list_id: "L1", marked: true }]);
  });

  it("ticking a list that looks like a test list marks it in one click, even when it is large", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [{ route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [
        { id: "L2", name: "Internal test", people: 300, marked: false, looks_like_test: true },
      ] }],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Internal test")).toBeDefined());
    fireEvent.click(screen.getByRole("checkbox", { name: /Internal test/ }));
    await waitFor(() => toasted('"Internal test" is a test list now.'));
    expect(confirm.asked).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ route: "mailchimp", list_id: "L2", marked: true }]);
  });

  it("a member cannot untick a marked list, so no confirm opens and nothing is written", async () => {
    ws.role = "member";
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByText("Members")).toBeDefined());
    const box = screen.getByRole("checkbox", { name: /Members/ }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    await new Promise((r) => setTimeout(r, 20));
    expect(confirm.asked).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a SendGrid key that can't run campaigns gets one line, not silence or 'No lists here yet'", async () => {
    set("GET /api/workspace/email-test-lists", view({
      routes: [
        { route: "sendgrid", label: "SendGrid", status: "needs_permissions", error: "The saved SendGrid key sends one-to-one email but is missing the permissions campaigns need.", lists: [] },
        { route: "mailchimp", label: "Mailchimp", status: "not_connected", error: null, lists: [] },
      ],
      orphans: [],
    }));
    render(<EmailTestListsBlock />);
    await waitFor(() => expect(screen.getByTestId("test-lists-needs-key")).toBeDefined());
    expect(screen.getAllByTestId("test-lists-needs-key").map((n) => n.textContent)).toEqual([
      "SendGrid is connected but its key can't run campaigns yet. Paste a key with campaign permissions in Overview → SendGrid.",
    ]);
    expect(screen.queryByText(TEST_LIST_COPY.empty)).toBeNull();
    expect(screen.queryByTestId("test-lists-unreadable")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("is mounted by id from the channel row", async () => {
    render(<ChannelSettingsPanels panels={["email_test_lists"]} />);
    await waitFor(() => expect(screen.getByTestId("email-test-lists")).toBeDefined());
  });
});

describe("Test lists at phone width", () => {
  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  it("a Zavi list name keeps a real width and wraps by words, with its meta labels in their own wrapping line", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Q1", name: "QA messy 1026", people: 1, marked: false, looks_like_test: true }] }],
      orphans: [],
    });
    render(<EmailTestListsBlock />);
    const name = await screen.findByText("QA messy 1026");
    const cls = tokens(name);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("break-words");
    expect(cls.some((c) => /^basis-/.test(c))).toBe(true);
    expect(cls).not.toContain("[overflow-wrap:anywhere]");
    expect(cls).not.toContain("whitespace-nowrap");
    expect(cls).not.toContain("truncate");

    const meta = screen.getByTestId("test-list-meta");
    expect(tokens(meta)).toContain("flex-wrap");
    expect(meta.contains(name)).toBe(false);
    for (const label of ["Zavi lists", "1 person", TEST_LIST_COPY.hint]) expect(meta.contains(screen.getByText(label))).toBe(true);

    const line = meta.parentElement!;
    expect(line.contains(name)).toBe(true);
    expect(tokens(line)).toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0", "flex-1"]));
    expect(line.querySelector("input[type=checkbox]")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /QA messy 1026/ })).toBeTruthy();
  });

  it("draws a themed checkbox aligned with the name line, with a cream check mark only when ticked", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [
        { id: "Q1", name: "QA messy 1026", people: 2, marked: false, looks_like_test: true },
        { id: "Q2", name: "Seeds", people: 1, marked: true, looks_like_test: false },
      ] }],
      orphans: [],
    });
    render(<EmailTestListsBlock />);
    const open = await screen.findByRole("checkbox", { name: /QA messy 1026/ });
    const ticked = screen.getByRole("checkbox", { name: /Seeds/ });
    for (const box of [open, ticked]) {
      const cls = tokens(box);
      expect(cls).toEqual(expect.arrayContaining(["appearance-none", "bg-transparent", "border-rule", "checked:bg-ink", "checked:border-ink", "peer"]));
      expect(cls).not.toContain("bg-cream");
      expect(cls).not.toContain("accent-ink");
      const mark = box.parentElement!.querySelector("svg")!;
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      expect(tokens(mark)).toEqual(expect.arrayContaining(["text-cream", "opacity-0", "peer-checked:opacity-100"]));
      const row = box.closest("label")!;
      expect(tokens(row)).toEqual(expect.arrayContaining(["items-start", "content-center", "min-h-[44px]"]));
      expect(tokens(row)).not.toContain("items-center");
      expect(tokens(box.parentElement!)).toContain("mt-0.5");
    }
    expect((open as HTMLInputElement).checked).toBe(false);
    expect((ticked as HTMLInputElement).checked).toBe(true);
  });
});
