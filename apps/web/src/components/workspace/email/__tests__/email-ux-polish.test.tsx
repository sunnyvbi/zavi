// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: vi.fn(() => Promise.resolve()) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { EmailConnectTiles, forgetConnected } from "../EmailConnectTiles";
import { SendingDomainBlock } from "../SendingDomainBlock";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

const TOOLS = "GET /api/workspace/email-test-lists";
const DOMAIN_URL = "GET /api/workspace/sending-domain";
const tools = (connected: string[]) => ({
  routes: ["sendgrid", "mailchimp", "klaviyo"].map((r) => ({ route: r, label: r, status: connected.includes(r) ? "complete" : "not_connected", error: null, lists: [] })),
  orphans: [],
});
const READY = { suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
const record = (n: number) => ({ type: "CNAME", host: `em${n}.acme.com`, data: `u${n}.wl.sendgrid.net` });
const PENDING = { domain: "acme.com", status: "pending", from_address: "hello@acme.com", dns_records: [record(1), record(2)], last_error: null, verified_at: null };
const VERIFIED = { ...PENDING, status: "verified", dns_records: [], verified_at: "2026-10-07T00:00:00Z" };

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  forgetConnected();
  forgetEmailTestLists();
});
afterEach(cleanup);

describe("email connect tiles copy", () => {
  it("Gmail says it is one-to-one only and the others do not", async () => {
    routes[TOOLS] = { status: 200, body: tools([]) };
    render(<EmailConnectTiles />);
    const gmail = await screen.findByTestId("email-connect-gmail");
    expect(within(gmail).getByText("One-to-one emails only")).toBeTruthy();
    expect(screen.getAllByText("One-to-one emails only")).toHaveLength(1);
  });

  it("the title follows whether any tool is connected", async () => {
    routes[TOOLS] = { status: 200, body: tools([]) };
    const first = render(<EmailConnectTiles />);
    await screen.findByTestId("email-connect-gmail-state");
    expect(screen.getByRole("heading").textContent).toBe("Connect your email tool");
    first.unmount();
    forgetConnected();
    forgetEmailTestLists();
    routes[TOOLS] = { status: 200, body: tools(["mailchimp"]) };
    render(<EmailConnectTiles />);
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Your email tools"));
  });

  it("a failed read offers Try again, which reads again", async () => {
    routes[TOOLS] = { status: 500, body: {} };
    render(<EmailConnectTiles />);
    const btn = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    routes[TOOLS] = { status: 200, body: tools(["mailchimp"]) };
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("email-connect-mailchimp-state").textContent).toBe("Connected"));
  });
});

describe("sending domain block", () => {
  it("Cancel on the change form clears a failed add's error", async () => {
    routes[DOMAIN_URL] = { status: 200, body: { ...READY, domain: VERIFIED } };
    routes["POST /api/workspace/sending-domain"] = { status: 400, body: { error: { message: "That domain is taken." } } };
    render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Use a different domain" }));
    fireEvent.change(await screen.findByLabelText("Your domain"), { target: { value: "other.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That domain is taken.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("hello@acme.com")).toBeTruthy();
  });

  it("Cancel shares a row with Add domain", async () => {
    routes[DOMAIN_URL] = { status: 200, body: { ...READY, domain: PENDING } };
    render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    const add = await screen.findByRole("button", { name: "Add domain" });
    expect(screen.getByRole("button", { name: "Cancel" }).parentElement).toBe(add.parentElement);
  });

  it("pending view is one sentence group: no standalone verify line, ends with the cannot-send warning, no Record N labels", async () => {
    routes[DOMAIN_URL] = { status: 200, body: { ...READY, domain: PENDING } };
    const { container } = render(<SendingDomainBlock />);
    await screen.findByRole("button", { name: "Check now" });
    expect(screen.queryByText(/Verify your domain once/)).toBeNull();
    const para = screen.getByText(/these 2 records/);
    expect(para.textContent?.endsWith("then check. Zavi can't send until it's verified.")).toBe(true);
    expect(container.textContent).not.toMatch(/Record \d/);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("Change, Remove and Cancel use the 12px text scale and 8px corners on the input and notes", async () => {
    routes[DOMAIN_URL] = { status: 200, body: { ...READY, domain: PENDING } };
    const { container } = render(
      <>
        <ConfirmDialogHost />
        <SendingDomainBlock />
      </>,
    );
    const change = await screen.findByRole("button", { name: "Change" });
    expect(change.className).toContain("text-[12px]");
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain("text-[12px]");
    expect(container.innerHTML).not.toContain("12.5px");
    expect(container.innerHTML).not.toContain("rounded-[10px]");
    fireEvent.click(change);
    const input = await screen.findByLabelText("Your domain");
    expect(input.className).toContain("rounded-lg");
    expect(input.className).not.toContain("rounded-[10px]");
  });
});
