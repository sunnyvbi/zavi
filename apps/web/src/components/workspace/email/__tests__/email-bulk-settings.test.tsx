// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const m = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: m.apiFetch }));

import { SAVED_SHOWN_MS, SendingDomainBlock } from "../SendingDomainBlock";
import { toast } from "@/components/ui/toast";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { importSummary } from "@/lib/workspace/emailBulkApi";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

const looksLikeButton = (el: HTMLElement, hover = "hover:bg-creamDeep") => {
  for (const c of ["border", "border-rule", "bg-white", "cursor-pointer", "hover:border-inkLight", hover]) expect(el.classList.contains(c), `${el.textContent} missing ${c}`).toBe(true);
};

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

type Route = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Route) {
  m.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => handler(path, init));
}

const READY = { suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
const PENDING = {
  domain: "acme.com",
  status: "pending",
  from_address: "hello@acme.com",
  dns_records: [{ type: "CNAME", host: "em1.acme.com", data: "u1.wl.sendgrid.net" }],
  last_error: null,
  verified_at: null,
};

beforeEach(() => {
  forgetEmailTestLists();
  m.apiFetch.mockReset();
});
afterEach(cleanup);

describe("SendingDomainBlock", () => {
  it("with no domain: says bulk email is locked, and offers the domain the founder typed earlier", async () => {
    routes(() => json({ ...READY, domain: null, suggested_domain: "mail.acme.com" }));
    render(<SendingDomainBlock />);
    expect(await screen.findByText("Not set up")).toBeTruthy();
    expect(screen.getByText("Verify your domain once so inboxes trust your emails. Zavi can't send until it's verified.")).toBeTruthy();
    expect((screen.getByLabelText("Your domain") as HTMLInputElement).value).toBe("mail.acme.com");
  });

  it("adds the domain, shows the records to copy, then Check now marks it verified", async () => {
    const calls: string[] = [];
    routes((path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/verify")) return json({ domain: { ...PENDING, status: "verified", verified_at: "2026-10-07T00:00:00Z" } });
      if (init?.method === "POST") return json({ domain: PENDING });
      return json({ ...READY, domain: null });
    });
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));

    expect(await screen.findByText("Waiting for DNS")).toBeTruthy();
    expect(screen.getByText("em1.acme.com")).toBeTruthy();
    expect(screen.getByText("u1.wl.sendgrid.net")).toBeTruthy();
    expect(JSON.parse(String(m.apiFetch.mock.calls[1][1].body))).toEqual({ domain: "acme.com" });

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("hello@acme.com")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByText("Bulk email is sent from")).toBeNull();
    expect(screen.queryByText("Waiting for DNS")).toBeNull();
    expect(screen.queryByText(/Zavi can't send until it's verified/)).toBeNull();
    expect(screen.queryByText(/never from Zavi/)).toBeNull();
    expect(screen.queryByText("em1.acme.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(calls).toEqual([
      "GET /api/workspace/sending-domain",
      "POST /api/workspace/sending-domain",
      "POST /api/workspace/sending-domain/verify",
    ]);
  });

  it("a pending domain lists each record, copies the exact host and value, and shows why the last check failed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const two = {
      ...PENDING,
      dns_records: [
        { type: "CNAME", host: "em1.acme.com", data: "u1.wl.sendgrid.net" },
        { type: "CNAME", host: "s1._domainkey.acme.com", data: "s1.domainkey.u1.wl.sendgrid.net" },
      ],
      last_error: "We could not find all the records yet.",
    };
    routes(() => json({ ...READY, domain: two }));
    render(<SendingDomainBlock />);

    expect(await screen.findByText(/Add these 2 records where you\s+manage DNS for/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("We could not find all the records yet.")).toBeTruthy();

    const copyValues = screen.getAllByRole("button", { name: "Copy the CNAME value" });
    fireEvent.click(copyValues[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("s1.domainkey.u1.wl.sendgrid.net"));
    expect(await screen.findByRole("button", { name: "Copied the CNAME value" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Copy the CNAME name" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("em1.acme.com"));
  });

  it("Remove asks in Zavi's own dialog, sends nothing on Cancel, then removes on confirm", async () => {
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);
    let removed = false;
    routes((_path, init) => {
      if (init?.method === "DELETE") {
        removed = true;
        return json({ released: true });
      }
      if (init?.method === "PUT") return json({ error: { code: "write_failed", message: "Those settings did not save." } }, 500);
      return json({ ...READY, domain: removed ? null : PENDING });
    });
    render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    const deletes = () => m.apiFetch.mock.calls.filter((c) => c[0] === "/api/workspace/sending-domain" && c[1]?.method === "DELETE");
    const writes = () => m.apiFetch.mock.calls.filter((c) => c[1]?.method && c[1].method !== "GET").map((c) => [c[1].method, c[0], c[1].body ?? null]);

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove acme.com?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes()).toHaveLength(0);
    expect(writes()).toEqual([]);
    expect(screen.getByText("Waiting for DNS")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove domain" }));
    expect(await screen.findByText("Not set up")).toBeTruthy();
    expect(deletes()).toHaveLength(1);
    expect(writes()).toEqual([["DELETE", "/api/workspace/sending-domain", null]]);
    expect(screen.queryByText(/could not confirm the removal/)).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  it("shows the server's sentence when the domain belongs to another workspace", async () => {
    routes((_path, init) =>
      init?.method === "POST"
        ? json({ error: { code: "domain_taken", message: "This domain is already connected to another workspace." } }, 409)
        : json({ ...READY, domain: null }),
    );
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This domain is already connected to another workspace.");
    expect(m.apiFetch.mock.calls.filter((call) => call[0] === "/api/workspace/sending-domain")).toHaveLength(2);
    expect((screen.getByLabelText("Your domain") as HTMLInputElement).value).toBe("acme.com");
  });

  it("a member who is not an owner or admin cannot add the domain, and is told who can", async () => {
    routes(() => json({ ...READY, can_manage: false, domain: null }));
    render(<SendingDomainBlock />);
    expect(await screen.findByText(/Only a workspace owner or admin can set the sending domain\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add domain" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("when bulk email is not set up on the server yet: says so, and still saves the domain for Zavi's record check", async () => {
    routes((path, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...READY, bulk_email_ready: false, domain: null })));
    render(<SendingDomainBlock />);
    expect(await screen.findByText(/Zavi can't send from your domain yet\. Save it now and Zavi checks it later\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Your domain"), { target: { value: " mail.acme.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Saved\. Zavi checks this domain's records on its next run\./)).toBeTruthy();
    const put = m.apiFetch.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(put[0]).toBe("/api/channels/email_marketing/settings/sending_domain");
    expect(JSON.parse(String(put[1].body))).toEqual({ items: ["mail.acme.com"] });
    expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/sending-domain" && c[1]?.method === "POST")).toBe(false);
  });

  it("when bulk email is not set up yet: saves a pasted web address as the bare domain, and refuses something that is not a domain without saving", async () => {
    routes((path, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...READY, bulk_email_ready: false, domain: null })));
    render(<SendingDomainBlock />);
    const input = (await screen.findByLabelText("Your domain")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://Mail.Acme.com/news?x=1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Saved\. Zavi checks this domain's records on its next run\./)).toBeTruthy();
    const puts = () => m.apiFetch.mock.calls.filter((c) => c[1]?.method === "PUT");
    expect(puts().map((c) => JSON.parse(String(c[1].body)))).toEqual([{ items: ["mail.acme.com"] }]);
    expect(input.value).toBe("mail.acme.com");
    fireEvent.change(input, { target: { value: "not a domain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a domain like example.com.");
    expect(puts()).toHaveLength(1);
    expect(screen.queryByText(/Saved\. Zavi checks/)).toBeNull();
  });
});

describe("SendingDomainBlock review fixes", () => {
  const NOT_READY = { ...READY, bulk_email_ready: false };

  it("with nothing saved and nothing typed, Save domain is disabled and writes nothing", async () => {
    routes(() => json({ ...NOT_READY, domain: null }));
    render(<SendingDomainBlock />);
    const save = (await screen.findByRole("button", { name: "Save domain" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(m.apiFetch.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  it("a saved domain gets the footer's toast, a green box and a Saved badge that survives a reload; a refused one gets none", async () => {
    const shown = vi.spyOn(toast, "add");
    let stored: string | null = null;
    routes((_p, init) => {
      if (init?.method === "PUT") {
        stored = (JSON.parse(String(init.body)) as { items: string[] }).items[0] ?? null;
        return json({ fields: {} });
      }
      return json({ ...NOT_READY, domain: null, suggested_domain: stored });
    });
    const first = render(<SendingDomainBlock />);
    const input = await screen.findByLabelText("Your domain");
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText("Enter a domain like example.com.")).toBeTruthy();
    expect(shown).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sending-domain-saved")).toBeNull();
    expect(screen.getByText("Not set up")).toBeTruthy();

    fireEvent.change(input, { target: { value: "mail.acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    const box = await screen.findByTestId("sending-domain-saved");
    expect(box.className).toContain("bg-mintDeep/15");
    expect(box.querySelector("svg")).toBeTruthy();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Your sending domain is saved", position: "top-center", timeout: SAVED_SHOWN_MS }));
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText("Not set up")).toBeNull();

    first.unmount();
    render(<SendingDomainBlock />);
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByText("Not set up")).toBeNull();
    expect(screen.queryByTestId("sending-domain-saved")).toBeNull();
  });

  it("the green box goes by itself after three seconds, and the badge stays", async () => {
    routes((_p, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...NOT_READY, domain: null })));
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: "mail.acme.com" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
      await screen.findByTestId("sending-domain-saved");
      act(() => void vi.advanceTimersByTime(SAVED_SHOWN_MS - 1_000));
      expect(screen.queryByTestId("sending-domain-saved")).toBeTruthy();
      act(() => void vi.advanceTimersByTime(1_000));
      expect(screen.queryByTestId("sending-domain-saved")).toBeNull();
      expect(screen.getByText("Saved")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Save domain wakes only for a real change: the same domain typed another way stays asleep, and it sleeps again after a save", async () => {
    routes((_p, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...NOT_READY, domain: null, suggested_domain: "mail.acme.com" })));
    render(<SendingDomainBlock />);
    const input = await screen.findByLabelText("Your domain");
    const save = () => screen.getByRole("button", { name: "Save domain" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://MAIL.acme.com/" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "not a domain" } });
    expect(save().disabled).toBe(false);
    fireEvent.change(input, { target: { value: "" } });
    expect(save().disabled).toBe(false);
    fireEvent.change(input, { target: { value: "news.acme.com" } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await screen.findByTestId("sending-domain-saved");
    expect(save().disabled).toBe(true);
    expect(m.apiFetch.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1);
  });

  it("with nothing saved and nothing typed, Save domain stays asleep", async () => {
    routes(() => json({ ...NOT_READY, domain: null }));
    render(<SendingDomainBlock />);
    await screen.findByLabelText("Your domain");
    expect((screen.getByRole("button", { name: "Save domain" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clearing a saved suggested domain says Cleared, never Saved", async () => {
    routes((_p, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...NOT_READY, domain: null, suggested_domain: "mail.acme.com" })));
    render(<SendingDomainBlock />);
    const input = (await screen.findByLabelText("Your domain")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Cleared\./)).toBeTruthy();
    expect(screen.queryByText(/Saved\. Zavi checks/)).toBeNull();
    const put = m.apiFetch.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body))).toEqual({ items: [] });
  });

  it("a Remove that worked but whose reload failed never says the removal could not be confirmed", async () => {
    let removed = false;
    routes((_p, init) => {
      if (init?.method === "DELETE") {
        removed = true;
        return json({ released: true });
      }
      if (removed) return json({ error: { message: "down" } }, 500);
      return json({ ...READY, domain: PENDING });
    });
    render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove domain" }));
    expect(await screen.findByText(/The domain was removed, but Zavi could not reload this page/)).toBeTruthy();
    expect(screen.queryByText(/could not confirm the removal/)).toBeNull();
    expect(screen.queryByText("Waiting for DNS")).toBeNull();
  });

  it("a member viewing a pending domain is told why Check now is greyed out", async () => {
    routes(() => json({ ...READY, can_manage: false, domain: PENDING }));
    render(<SendingDomainBlock />);
    const check = (await screen.findByRole("button", { name: "Check now" })) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(screen.getByText(/Only a workspace owner or admin can check the sending domain/)).toBeTruthy();
  });
});

describe("SendingDomainBlock as one row", () => {
  const VERIFIED = { ...PENDING, status: "verified", dns_records: [], verified_at: "2026-10-07T00:00:00Z" };

  it("verified: the label is a row heading, the address and pill share a line, and Change / Remove sit on that same line, after the pill", async () => {
    routes(() => json({ ...READY, domain: VERIFIED }));
    render(<SendingDomainBlock />);
    const address = await screen.findByText("hello@acme.com");
    const heading = screen.getByRole("heading", { name: "Sending domain" });
    expect(heading.tagName).toBe("H3");
    const line = address.parentElement!;
    expect(within(line).getByText("Verified")).toBeTruthy();
    const change = within(line).getByRole("button", { name: "Change" });
    expect(within(line).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(within(line).getByText("Verified").compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a different domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove domain" })).toBeNull();
    expect(heading.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("not verified: Change and Remove follow Check now on the same line", async () => {
    routes(() => json({ ...READY, domain: PENDING }));
    render(<SendingDomainBlock />);
    const check = await screen.findByRole("button", { name: "Check now" });
    const bar = check.parentElement!;
    expect(within(bar).getByRole("button", { name: "Change" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("a member sees the verified address with no Change or Remove", async () => {
    routes(() => json({ ...READY, can_manage: false, domain: VERIFIED }));
    render(<SendingDomainBlock />);
    expect(await screen.findByText("hello@acme.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

describe("importSummary", () => {
  it("says what was added and what was left out, in plain words", () => {
    expect(importSummary({ list_id: "L", version_id: "V", added: 1200, invalid: 2, duplicates: 1, over_limit: 0, already_unsubscribed: 3 })).toBe(
      "Added 1,200 contacts. 1 repeated address was left out. 2 rows were not an email address. 3 already unsubscribed or bounced, so they will be skipped.",
    );
  });

describe("sending domain: controls look like buttons", () => {
  it("Check now, Change, Remove and every Copy button carry border, white fill, pointer and hover", async () => {
    routes(() => json({ ...READY, domain: PENDING }));
    render(<SendingDomainBlock />);
    const check = await screen.findByRole("button", { name: "Check now" });
    for (const c of ["border-ink", "bg-ink", "cursor-pointer", "hover:opacity-90"]) expect(check.classList.contains(c), c).toBe(true);
    looksLikeButton(screen.getByRole("button", { name: "Change" }));
    looksLikeButton(screen.getByRole("button", { name: "Remove" }));
    for (const b of screen.getAllByRole("button", { name: /^Copy the/ })) looksLikeButton(b);
  });
});
});

describe("sending domain: Zavi's own domains and the send-tool note", () => {
  const NOT_READY = { ...READY, bulk_email_ready: false, domain: null };
  const TAIL = "To send today, connect Mailchimp, Klaviyo or SendGrid.";
  const puts = () => m.apiFetch.mock.calls.filter((c) => c[1]?.method === "PUT");

  it.each(["zaviagent.com", "www.zaviagent.com", "mail.zaviagent.com", "https://WWW.ZaviAgent.com/x", "thepraxis.ai", "app.thepraxis.ai"])("refuses %s without any PUT", async (typed) => {
    routes((path, init) => (init?.method === "PUT" ? json({ fields: {} }) : json(NOT_READY)));
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use your own domain, not Zavi's.");
    expect(puts()).toHaveLength(0);
    expect(screen.queryByText(/Saved\. Zavi checks/)).toBeNull();
  });

  it.each(["notzaviagent.com", "zaviagent.com.evil.io", "mythepraxis.ai"])("still saves the lookalike %s", async (typed) => {
    routes((path, init) => (init?.method === "PUT" ? json({ fields: {} }) : json(NOT_READY)));
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Saved\. Zavi checks/)).toBeTruthy();
    expect(puts().map((c) => JSON.parse(String(c[1].body)))).toEqual([{ items: [typed] }]);
  });

  it("clearing a saved domain still works", async () => {
    routes((path, init) => (init?.method === "PUT" ? json({ fields: {} }) : json({ ...NOT_READY, suggested_domain: "acme.com" })));
    render(<SendingDomainBlock />);
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Cleared\./)).toBeTruthy();
    expect(puts().map((c) => JSON.parse(String(c[1].body)))).toEqual([{ items: [] }]);
  });

  const withLists = (lists: () => unknown) =>
    routes((path, init) => (path === "/api/workspace/email-test-lists" ? (lists() as never) : init?.method === "PUT" ? json({ fields: {} }) : json(NOT_READY)));
  const route = (r: string, status: string) => ({ route: r, status });

  it.each(["mailchimp", "klaviyo", "sendgrid"])("drops the connect sentence when %s is connected", async (tool) => {
    withLists(() => json({ routes: [route(tool, "complete")], gmail: { status: "off" } }));
    render(<SendingDomainBlock />);
    await screen.findByText(/Zavi can't send from your domain yet\. Save it now and Zavi checks it later\./);
    await waitFor(() => expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/email-test-lists")).toBe(true));
    await waitFor(() => expect(screen.getByText(/Zavi can't send from your domain yet/).textContent).not.toContain(TAIL));
    expect(screen.getByText(/Zavi can't send from your domain yet/).textContent).toContain("Save it now and Zavi checks it later.");
  });

  it("keeps the full note when only Gmail is connected", async () => {
    withLists(() => json({ routes: [route("mailchimp", "off")], gmail: { status: "connected" } }));
    render(<SendingDomainBlock />);
    await screen.findByText(/Zavi can't send from your domain yet/);
    await waitFor(() => expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/email-test-lists")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/Zavi can't send from your domain yet/).textContent).toContain(TAIL);
  });

  it("keeps the full note when nothing is connected", async () => {
    withLists(() => json({ routes: [route("mailchimp", "off"), route("klaviyo", "off"), route("sendgrid", "off")], gmail: { status: "off" } }));
    render(<SendingDomainBlock />);
    await screen.findByText(/Zavi can't send from your domain yet/);
    await waitFor(() => expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/email-test-lists")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/Zavi can't send from your domain yet/).textContent).toContain(TAIL);
  });

  it("keeps the full note when the read fails", async () => {
    withLists(() => json({ error: "boom" }, 500));
    render(<SendingDomainBlock />);
    await screen.findByText(/Zavi can't send from your domain yet/);
    await waitFor(() => expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/email-test-lists")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/Zavi can't send from your domain yet/).textContent).toContain(TAIL);
  });

  it("does not read the connections when bulk email is ready", async () => {
    routes(() => json({ ...READY, domain: null }));
    render(<SendingDomainBlock />);
    await screen.findByText("Not set up");
    await new Promise((r) => setTimeout(r, 30));
    expect(m.apiFetch.mock.calls.some((c) => c[0] === "/api/workspace/email-test-lists")).toBe(false);
  });
});

describe("sending domain: real path unhappy paths", () => {
  it("Add domain sends the bare lowercase host for a pasted address, and refuses a non-domain without calling the server", async () => {
    routes((_path, init) => (init?.method === "POST" ? json({ domain: PENDING }) : json({ ...READY, domain: null })));
    render(<SendingDomainBlock />);
    const input = await screen.findByLabelText("Your domain");
    fireEvent.change(input, { target: { value: "not a domain" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a domain like example.com.");
    expect(m.apiFetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);

    fireEvent.change(input, { target: { value: "  HTTPS://Acme.COM/pricing?x=1 " } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    await screen.findByText("Waiting for DNS");
    const posts = m.apiFetch.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toEqual({ domain: "acme.com" });
  });

  it("a refused clipboard says the copy failed instead of a silent nothing or an unhandled rejection", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    routes(() => json({ ...READY, domain: PENDING }));
    render(<SendingDomainBlock />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Copy the CNAME value" }))[0]);
    expect(await screen.findByRole("button", { name: "Could not copy the CNAME value" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied the CNAME value" })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a pending domain with no records never says 'Add these 0 records'", async () => {
    routes(() => json({ ...READY, domain: { ...PENDING, dns_records: [] } }));
    render(<SendingDomainBlock />);
    expect(await screen.findByText(/Zavi has no DNS records to show for/)).toBeTruthy();
    expect(screen.queryByText(/0 records/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });
});
