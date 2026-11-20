// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
const gates: Partial<Record<string, Promise<void>>> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (gates[key]) await gates[key];
    const r = routes[key] ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog, ZAVI_SENDER_STOPPED } from "../NewCampaignDialog";
import { EMAIL_SENDING_COPY, forgetPaused, loadEmailPause } from "../EmailSendingSwitch";

const START = "POST /api/channels/email_marketing/top-actions/new_email";
const PASTE = "POST /api/email-cards/paste";
const PAUSE = "GET /api/workspace/email-pause";
const paidCalls = () => calls.filter((c) => c.method !== "GET" || `${c.method} ${c.url}` === START || `${c.method} ${c.url}` === PASTE);
const pauseReads = () => calls.filter((c) => `${c.method} ${c.url}` === PAUSE);
const primary = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const BRIEF = "Spring sale: 20% off every plan until Sunday";

function senderRow() {
  const checks = within(screen.getByTestId("new-campaign-checks"));
  return checks.queryByText("Zavi can send to this list")?.closest("li") ?? checks.queryByText(EMAIL_SENDING_COPY.stoppedByZavi)?.closest("li") ?? null;
}

async function openOnZaviList() {
  render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /Members/ }));
  fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: BRIEF } });
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  forgetPaused();
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  for (const k of Object.keys(gates)) delete gates[k];
  routes["GET /api/workspace/email-test-lists"] = {
    status: 200,
    body: {
      routes: [
        { route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [{ id: "L1", name: "Paying customers", people: 300, marked: false, looks_like_test: false }] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
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
  routes[PAUSE] = { status: 200, body: { paused: false, held: "global" } };
  routes[START] = { status: 200, body: { run_id: "run-1" } };
  routes[PASTE] = { status: 200, body: { ok: true, card: { rail: "decisions", id: "card-7" }, link: "/w/acme/channels/email_marketing?card=card-7", route: "zavi_list", versions: 1 } };
});
afterEach(() => cleanup());

describe("Zavi's own sender is stopped for every workspace", () => {
  it("shows the stopped line instead of the green check and never starts a paid run, even though the sending domain is ready", async () => {
    await openOnZaviList();
    const stopped = await screen.findByTestId("new-campaign-zavi-sender-stopped");
    expect(stopped.textContent).toBe(`${EMAIL_SENDING_COPY.held.global} ${ZAVI_SENDER_STOPPED}`);
    expect(screen.queryByText("Zavi can send to this list")).toBeNull();
    const row = senderRow()!;
    expect(row.querySelector(".text-success")).toBeNull();
    expect(row.querySelector(".text-warn")).not.toBeNull();
    expect(row.textContent).toContain("needs attention");
    expect(screen.getByTestId("new-campaign-checks").querySelectorAll(".text-warn")).toHaveLength(1);

    const write = primary(/Write it/);
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("new-campaign-missing").textContent).toMatch(/Zavi's sender/);

    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Hi there,\n\nOur spring sale starts Friday. Every plan is 20% off.\n\nSee you." } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(primary(/Add it for approval/));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(paidCalls()).toEqual([]);
    expect(pauseReads()).toHaveLength(1);
  });

  it("blocks Write it while the stop is still being read, so a fast domain check cannot open a window to start the run", async () => {
    let release!: () => void;
    gates[PAUSE] = new Promise<void>((r) => (release = r));
    await openOnZaviList();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/workspace/sending-domain")).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText("Zavi can send to this list")?.closest("li")?.querySelector(".text-success") ?? null).toBeNull();
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    await screen.findByTestId("new-campaign-zavi-sender-stopped");
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(paidCalls()).toEqual([]);
  });

  it("staff stopping the sender after the page loaded still blocks Write it, because the dialog reads the stop fresh when it opens", async () => {
    routes[PAUSE] = { status: 200, body: { paused: false, held: null } };
    await loadEmailPause();
    expect(pauseReads()).toHaveLength(1);
    routes[PAUSE] = { status: 200, body: { paused: false, held: "global" } };
    await openOnZaviList();
    expect(primary(/Write it/).disabled).toBe(true);
    const stopped = await screen.findByTestId("new-campaign-zavi-sender-stopped");
    expect(stopped.textContent).toBe(`${EMAIL_SENDING_COPY.held.global} ${ZAVI_SENDER_STOPPED}`);
    expect(screen.queryByText("Zavi can send to this list")).toBeNull();
    expect(pauseReads()).toHaveLength(2);
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(paidCalls()).toEqual([]);
  });

  it("a list in the founder's own email tool still writes, because the stop is only Zavi's own sender", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Paying customers/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: BRIEF } });
    await waitFor(() => expect(pauseReads()).toHaveLength(1));
    expect(screen.queryByTestId("new-campaign-zavi-sender-stopped")).toBeNull();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect(paidCalls().map((c) => `${c.method} ${c.url}`)).toEqual([START]);
    expect((paidCalls()[0].body as { inputs: { list_id: string } }).inputs.list_id).toBe("L1");
  });
});

describe("Zavi's own sender is running", () => {
  it("shows the green check and Write it starts exactly one run to the Zavi list", async () => {
    routes[PAUSE] = { status: 200, body: { paused: false, held: null } };
    await openOnZaviList();
    await waitFor(() => expect(screen.queryByText("Zavi can send to this list")).toBeNull());
    expect(screen.queryByTestId("new-campaign-zavi-sender-stopped")).toBeNull();
    expect(screen.queryByText(EMAIL_SENDING_COPY.stoppedByZavi)).toBeNull();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect(paidCalls().map((c) => `${c.method} ${c.url}`)).toEqual([START]);
    expect((paidCalls()[0].body as { inputs: { list_id: string } }).inputs.list_id).toBe("Z1");
  });

  it("a workspace pause alone does not block writing, as before", async () => {
    routes[PAUSE] = { status: 200, body: { paused: true, held: null } };
    await openOnZaviList();
    await waitFor(() => expect(pauseReads()).toHaveLength(1));
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(screen.queryByTestId("new-campaign-zavi-sender-stopped")).toBeNull();
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect(paidCalls().map((c) => `${c.method} ${c.url}`)).toEqual([START]);
  });
});
