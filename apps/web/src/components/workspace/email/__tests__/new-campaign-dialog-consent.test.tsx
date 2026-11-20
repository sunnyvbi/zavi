// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog } from "../NewCampaignDialog";
import { EMAIL_SETTINGS_GOTO_EVENT } from "../emailSettingsNav";

const START = "POST /api/channels/email_marketing/top-actions/new_email";
const PASTE = "POST /api/email-cards/paste";
const started = () => calls.filter((c) => `${c.method} ${c.url}` === START || `${c.method} ${c.url}` === PASTE);
const primary = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-test-lists"] = {
    status: 200,
    body: {
      routes: [
        {
          route: "zavi_list",
          label: "Zavi lists",
          status: "complete",
          error: null,
          lists: [
            { id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false },
            { id: "Z2", name: "Imported leads", people: 900, marked: false, looks_like_test: false, needs_consent: true },
          ],
        },
      ],
      orphans: [],
    },
  };
  routes["GET /api/workspace/email-template"] = { status: 200, body: { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true } };
  routes["GET /api/channels/email_marketing/settings"] = { status: 200, body: { fields: {} } };
  routes["GET /api/workspace/sending-domain"] = {
    status: 200,
    body: { domain: { domain: "acme.com", status: "verified", from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true },
  };
  routes[START] = { status: 200, body: { run_id: "run-1" } };
});
afterEach(() => cleanup());

describe("a Zavi list nobody confirmed consent for", () => {
  it("never starts a paid run, says why in plain words, and the way forward opens the contacts settings", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const onClose = vi.fn();
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={onClose} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Imported leads/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off every plan until Sunday" } });
    const checks = within(screen.getByTestId("new-campaign-checks"));
    const reason = await checks.findByTestId("new-campaign-list-consent");
    expect(reason.textContent).toMatch(/agreed to hear from you/);
    expect(reason.textContent).not.toMatch(/consent|needs_consent|GDPR/i);
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(started()).toHaveLength(0);
    expect(screen.getByTestId("new-campaign-missing").textContent).toMatch(/agreed to hear from you/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zavi writes it" }));
    fireEvent.click(checks.getByRole("button", { name: "Confirm it in Settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(1);
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "contacts" });
    expect(started()).toHaveLength(0);
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("switching to a confirmed list clears the block and the run starts once, to that list only", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Imported leads/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off every plan until Sunday" } });
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Members/ }));
    expect(screen.queryByTestId("new-campaign-list-consent")).toBeNull();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect(started()).toHaveLength(1);
    expect((started()[0].body as { inputs: { list_id: string } }).inputs.list_id).toBe("Z1");
  });
});
