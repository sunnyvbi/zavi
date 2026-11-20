// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const m = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: m.apiFetch }));

import { SendingDomainBlock } from "../SendingDomainBlock";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const READY = { suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
const ROW = {
  domain: "acme.com",
  status: "pending",
  from_address: "hello@acme.com",
  dns_records: [{ type: "CNAME", host: "em1.acme.com", data: "u1.wl.sendgrid.net" }],
  last_error: null,
  verified_at: null,
};
const VERIFIED = { ...ROW, status: "verified" };
const EMPTY = { ...ROW, dns_records: [] };

const writes = () => m.apiFetch.mock.calls.filter((c) => c[1]?.method && c[1].method !== "GET").map((c) => `${c[1].method} ${c[0]}`);

beforeEach(() => {
  forgetEmailTestLists();
  m.apiFetch.mockReset();
});
afterEach(cleanup);

function mount() {
  render(
    <>
      <ConfirmDialogHost />
      <SendingDomainBlock />
    </>,
  );
}

describe("empty records state", () => {
  it("offers Add domain again, which re-adds the same domain and shows the new records", async () => {
    let added = false;
    m.apiFetch.mockImplementation(async (_p: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        added = true;
        return json({ domain: ROW });
      }
      return json({ ...READY, domain: added ? ROW : EMPTY });
    });
    mount();
    expect(await screen.findByText(/yet\. Add the domain again to get them\./)).toBeTruthy();
    expect(screen.queryByText(/Press Check now/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add domain again" }));
    expect(await screen.findByText("em1.acme.com")).toBeTruthy();
    const post = m.apiFetch.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(post[0]).toBe("/api/workspace/sending-domain");
    expect(JSON.parse(post[1].body)).toEqual({ domain: "acme.com" });
    expect(screen.queryByRole("button", { name: "Add domain again" })).toBeNull();
  });

  it("without bulk email set up, does not offer an Add that would 503", async () => {
    m.apiFetch.mockImplementation(async () => json({ ...READY, bulk_email_ready: false, domain: EMPTY }));
    mount();
    await screen.findByText(/Remove it and save it again once bulk email is set up/);
    expect(screen.queryByRole("button", { name: "Add domain again" })).toBeNull();
    expect(screen.queryByText(/Add the domain again/)).toBeNull();
  });
});

describe("Change while bulk email is not set up", () => {
  it("never saves through the settings route that answers 409; removes the row first, then saves", async () => {
    let removed = false;
    m.apiFetch.mockImplementation(async (p: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") {
        removed = true;
        return json({ released: true });
      }
      if (init?.method === "PUT") {
        return removed ? json({ fields: {} }) : json({ error: { code: "field_writes_elsewhere", message: "set under Settings > Sending domain" } }, 409);
      }
      return json({ ...READY, bulk_email_ready: false, domain: removed ? null : ROW });
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove and change" }));
    const input = (await screen.findByLabelText("Your domain")) as HTMLInputElement;
    expect(input.value).toBe("acme.com");
    expect(writes()).toEqual(["DELETE /api/workspace/sending-domain"]);
    fireEvent.change(input, { target: { value: "mail.other.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save domain" }));
    expect(await screen.findByText(/Saved\. Zavi checks/)).toBeTruthy();
    expect(writes()).toEqual(["DELETE /api/workspace/sending-domain", "PUT /api/channels/email_marketing/settings/sending_domain"]);
  });

  it("Cancel in the dialog changes nothing", async () => {
    m.apiFetch.mockImplementation(async () => json({ ...READY, bulk_email_ready: false, domain: ROW }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes()).toEqual([]);
    expect(screen.queryByLabelText("Your domain")).toBeNull();
  });
});

describe("Add after Change on the same domain", () => {
  async function openChange(row: unknown) {
    m.apiFetch.mockImplementation(async () => json({ ...READY, domain: row }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    if (row === VERIFIED) fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Use a different domain" }));
    return (await screen.findByLabelText("Your domain")) as HTMLInputElement;
  }

  it.each([["pending with records", ROW], ["verified", VERIFIED]])("is disabled until the input changes on a healthy row (%s)", async (_n, row) => {
    const input = await openChange(row);
    const add = screen.getByRole("button", { name: "Add domain" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  https://ACME.com/ " } });
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "other.com" } });
    expect(add.disabled).toBe(false);
  });

  it("stays enabled on a pending row with no records, and re-adds the same domain", async () => {
    m.apiFetch.mockImplementation(async (_p: string, init?: { method?: string }) =>
      init?.method === "POST" ? json({ domain: ROW }) : json({ ...READY, domain: EMPTY }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const add = (await screen.findByRole("button", { name: "Add domain" })) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("em1.acme.com")).toBeTruthy();
    expect(writes()).toEqual(["POST /api/workspace/sending-domain"]);
  });
});

describe("Use a different domain warning", () => {
  it("keeps the truthful bulk-going-out line and says a running send is held and may need Zavi staff", async () => {
    m.apiFetch.mockImplementation(async () => json({ ...READY, domain: VERIFIED }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("alertdialog");
    const text = dialog.textContent ?? "";
    expect(text).toContain("Bulk email keeps going out from hello@acme.com until you add the new domain.");
    expect(text).toContain("a send running at that moment is held");
    expect(text).toContain("Some held sends can only be resumed by Zavi staff.");
    expect(text).not.toMatch(/resume[sd]? (by itself|automatically)/i);
  });
});
