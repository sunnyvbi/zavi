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
import { longDay } from "../../ugc/DatePicker";

const START = "POST /api/channels/email_marketing/top-actions/new_email";
const PASTE = "POST /api/email-cards/paste";
const PLAN = "POST /api/workspace/email-plan";
const started = () => calls.filter((c) => `${c.method} ${c.url}` === START || `${c.method} ${c.url}` === PASTE);
const primary = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
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
            { id: "Z2", name: "Patients", people: 38, marked: false, looks_like_test: false, needs_consent: true, consented_version: true },
            { id: "Z3", name: "Never confirmed", people: null, marked: false, looks_like_test: false, needs_consent: true },
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
  routes[PLAN] = { status: 200, body: { ok: true, id: "p1", label: "Wed, Oct 21, 09:00", timezone: "UTC", list_name: "Patients", replayed: false } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const planCalls = () => calls.filter((c) => `${c.method} ${c.url}` === PLAN);
const pickDay = (iso: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Day" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a day" })).getByRole("button", { name: longDay(iso)! }));
};
const open = async (list: RegExp) => {
  render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: list }));
  fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Flu shots are here" } });
};

describe("a list with a newer import waiting for consent", () => {
  it("must catch: picking a time plans it to the confirmed people, and the form says only those people get it", async () => {
    await open(/Patients/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    pickDay("2026-10-21");
    await waitFor(() => expect(primary(/Plan it/).disabled).toBe(false));
    expect(screen.queryByTestId("new-campaign-list-consent")).toBeNull();
    expect(within(screen.getByTestId("new-campaign-checks")).getByTestId("new-campaign-list-newer-import").textContent).toMatch(/already confirmed/);
    fireEvent.click(primary(/Plan it/));
    await waitFor(() => expect(planCalls()).toHaveLength(1));
    expect(planCalls()[0].body).toMatchObject({ route: "zavi_list", list_id: "Z2" });
    expect(started()).toHaveLength(0);
  });

  it("control: writing it now is still blocked until the new import is confirmed, with no paid run", async () => {
    await open(/Patients/);
    expect(await within(screen.getByTestId("new-campaign-checks")).findByTestId("new-campaign-list-consent")).toBeTruthy();
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(started()).toHaveLength(0);
  });

  it("control: a list with no confirmed version cannot be planned", async () => {
    await open(/Never confirmed/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    pickDay("2026-10-21");
    expect(await within(screen.getByTestId("new-campaign-checks")).findByTestId("new-campaign-list-consent")).toBeTruthy();
    expect(primary(/Plan it/).disabled).toBe(true);
    fireEvent.click(primary(/Plan it/));
    expect(planCalls()).toHaveLength(0);
  });
});
