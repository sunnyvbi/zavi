// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { SendingDomainBlock } from "../SendingDomainBlock";

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
});
afterEach(cleanup);

const READY = { suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
const DOMAIN = { domain: "acme.com", status: "verified", from_address: "hello@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" };

describe("fix 7: Sending domain", () => {
  it("a verified domain asks before Change; Cancel keeps it", async () => {
    set("GET /api/workspace/sending-domain", { ...READY, domain: DOMAIN });
    render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/acme\.com/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByLabelText("Your domain")).toBeNull();
    expect(screen.getByText("hello@acme.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Use a different domain" }));
    expect(await screen.findByLabelText("Your domain")).toBeTruthy();
  });

  it("a failed check has its own pill, not the waiting one", async () => {
    set("GET /api/workspace/sending-domain", { ...READY, domain: { ...DOMAIN, status: "failed", verified_at: null, dns_records: [{ type: "CNAME", host: "em.acme.com", data: "u1.wl.sendgrid.net" }], last_error: "Records not found." } });
    render(<SendingDomainBlock />);
    expect(await screen.findByText("Check failed")).toBeTruthy();
    expect(screen.queryByText("Waiting for DNS")).toBeNull();
  });

  it("when Zavi cannot send bulk email yet, says so plainly and names the other way", async () => {
    set("GET /api/workspace/sending-domain", { ...READY, bulk_email_ready: false, domain: null });
    const { container } = render(<SendingDomainBlock />);
    expect(await screen.findByText(/Zavi can't send from your domain yet/)).toBeTruthy();
    expect(container.textContent).toMatch(/connect Mailchimp, Klaviyo or SendGrid/);
    expect(container.textContent).not.toMatch(/Bulk email is not set up yet/);
  });

  it("a failed read has Retry", async () => {
    set("GET /api/workspace/sending-domain", { error: { message: "Zavi could not read the domain." } }, 500);
    render(<SendingDomainBlock />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(count("GET /api/workspace/sending-domain")).toBe(2));
    set("GET /api/workspace/sending-domain", { ...READY, domain: null });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not set up")).toBeTruthy();
  });
});
