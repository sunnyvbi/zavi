// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const RUN = "7d3f2c10-0000-4000-8000-0000000000aa";
const srv = vi.hoisted(() => ({
  runStatus: "queued",
  channelRows: [] as unknown[],
  hold: null as null | Promise<void>,
  starts: 0,
  startRunId: "7d3f2c10-0000-4000-8000-0000000000aa" as string | null,
  workState: "needs_review",
}));

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));
vi.mock("../actions/channelPlanLock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../actions/channelPlanLock")>()),
  useChannelPlanLock: () => null,
  upgradeOnPlanRefusal: () => false,
}));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id }: { id: string }) => <div data-testid="email-card" data-id={id} />,
  EmailPreviewFrame: () => null,
}));

const oldRow = {
  id: "email-old",
  decision_class: "bulk_outbound.send",
  channel_slug: "email_marketing",
  handler: "bulk_outbound.send",
  emitted_at: "2026-10-27T10:00:00.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: null,
  body: { list_name: "Paying customers" },
};
const newRow = { ...oldRow, id: "email-new", emitted_at: "2026-10-28T10:01:00.000Z", body: { list_name: "Newsletter" } };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const apiFetch = vi.fn(async (path: string, init?: { method?: string }) => {
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/api/channels/email_marketing/top-actions/new_email") {
    srv.starts += 1;
    const gate = srv.hold;
    if (gate) await gate;
    return json(srv.startRunId ? { run_id: srv.startRunId } : { ok: true, run_id: null, stamped: false, duplicate: true });
  }
  if (path === `/api/channels/email_marketing/top-actions/runs/${RUN}`) return json({ status: srv.runStatus, actions: [], summary: null });
  if (path.startsWith("/api/channels/email_marketing/actions")) return json({ actions: [], more: 0, store: "channel_actions" });
  if (path.startsWith("/api/approvals?channel=email_marketing")) return json({ decisions: srv.channelRows });
  if (path.startsWith("/api/approvals")) return json({ decisions: [oldRow], channel_pending_counts: { email_marketing: 4 } });
  if (path === "/api/channels")
    return json({
      channels: [
        {
          channel_slug: "email_marketing",
          delivery_mode: "execute",
          work_state: srv.workState,
          priority: 1,
          last_run_at: "2026-10-27T09:00:00.000Z",
          connected: true,
          connectors: ["email"],
          linked_connectors: ["email"],
          runnable: true,
        },
      ],
    });
  if (path === "/api/workspace/email-test-lists")
    return json({
      routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Newsletter", people: 6, marked: false, looks_like_test: false }] }],
      orphans: [],
    });
  if (path === "/api/workspace/email-template")
    return json({ template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
  if (path === "/api/workspace/sending-domain")
    return json({ domain: { domain: "acme.com", status: "verified", from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true });
  return json({});
});
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: { method?: string }) => apiFetch(path, init) }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";
import { NewCampaignDialog, newCampaignSession } from "../email/NewCampaignDialog";
import { announceChannelRunStarted } from "../actions/topActions/api";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";

async function openEmailOverview() {
  render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  const tile = await vi.waitFor(() => {
    const t = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.textContent?.startsWith("Email") && /actions? waiting/.test(b.textContent ?? ""));
    if (!t) throw new Error("tile not ready");
    return t;
  });
  fireEvent.click(tile);
  await vi.waitFor(() => expect(screen.getAllByTestId("email-card").map((c) => c.getAttribute("data-id"))).toEqual(["email-old"]));
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  const overview = await vi.waitFor(() => screen.getByTestId("channel-overview"));
  await vi.waitFor(() => expect(within(overview).getAllByTestId("email-card").map((c) => c.getAttribute("data-id"))).toEqual(["email-old"]));
  return overview;
}

async function pressWriteIt() {
  const view = render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" session={newCampaignSession()} onClose={vi.fn()} />);
  const q = within(view.container);
  fireEvent.click(await q.findByRole("radio", { name: /Newsletter/ }));
  fireEvent.change(q.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off until Sunday" } });
  const button = q.getByRole("button", { name: /Write it/ }) as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  return { view, q };
}

const cards = () => screen.queryAllByTestId("email-card").map((c) => c.getAttribute("data-id"));
const working = () => document.body.textContent?.includes("Cooking up new suggestions for") ?? false;

async function finishRunWithBannerSignal() {
  srv.runStatus = "success";
  srv.channelRows = [newRow, oldRow];
  await act(async () => {
    window.dispatchEvent(new CustomEvent(ATTENTION_CHANGED_EVENT));
  });
}

let hour = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, 10) + hour++ * 3_600_000));
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  clearChannelBoardCache();
  window.sessionStorage.clear();
  apiFetch.mockClear();
  srv.runStatus = "queued";
  srv.channelRows = [oldRow];
  srv.hold = null;
  srv.starts = 0;
  srv.startRunId = RUN;
  srv.workState = "needs_review";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Write it from Overview on a busy email channel", () => {
  it("shows Zavi writing where the card will land, then the finished card appears in the same Overview without a reload and the working banner is gone", async () => {
    const overview = await openEmailOverview();
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    const { q } = await pressWriteIt();
    await q.findByText(/Zavi is writing it/);
    const writing = await within(overview).findByTestId("top-action-writing");
    expect(writing.textContent).toContain("Cooking up new suggestions for");
    expect(cards()).toEqual(["email-old"]);
    await finishRunWithBannerSignal();
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    expect(screen.getByTestId("channel-overview")).toBe(overview);
    expect(overview.isConnected).toBe(true);
    expect(within(overview).getAllByTestId("email-card").map((c) => c.getAttribute("data-id"))).toContain("email-new");
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(srv.starts).toBe(1);
  });

  it("the dialog closed while Write it is still starting: the run still shows on Overview and its card still lands", async () => {
    const overview = await openEmailOverview();
    let release: () => void = () => undefined;
    srv.hold = new Promise<void>((r) => (release = r));
    const { view } = await pressWriteIt();
    await vi.waitFor(() => expect(srv.starts).toBe(1));
    view.unmount();
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    await act(async () => release());
    await within(overview).findByTestId("top-action-writing");
    await finishRunWithBannerSignal();
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    expect(screen.getByTestId("channel-overview")).toBe(overview);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
  });

  it("Write it pressed from the Settings tab: Overview opened afterwards shows the writing state and then the card", async () => {
    announceChannelRunStarted("email_marketing", RUN);
    const overview = await openEmailOverview();
    await within(overview).findByTestId("top-action-writing");
    await finishRunWithBannerSignal();
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    expect(screen.getByTestId("channel-overview")).toBe(overview);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
  });

  it("Write it pressed in the drawer's own dialog on the Settings tab, run still going: Overview shows the banner and the writing state before the run ends, then the card", async () => {
    await openEmailOverview();
    const newButtons = screen.getAllByTestId("new-campaign-button");
    fireEvent.click(newButtons[newButtons.length - 1]);
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    await vi.waitFor(() => expect(screen.getByTestId("channel-tab-overview").hidden).toBe(true));
    fireEvent.click(await screen.findByRole("radio", { name: /Newsletter/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off until Sunday" } });
    const button = screen.getByRole("button", { name: /Write it/ }) as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Zavi is writing it/);
    expect(srv.starts).toBe(1);
    srv.runStatus = "running";
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    const overview = screen.getByTestId("channel-overview");
    const writing = await within(overview).findByTestId("top-action-writing");
    expect(writing.textContent).toContain("Cooking up new suggestions for");
    expect(within(overview).queryByTestId("top-action-run-end")).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(within(screen.getByTestId("channel-overview")).queryByTestId("top-action-writing")).not.toBeNull();
    expect(cards()).not.toContain("email-new");
    await finishRunWithBannerSignal();
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    expect(working()).toBe(false);
    expect(srv.starts).toBe(1);
  });

  it("Write it on the Settings tab whose start never confirms a run id, while the run really runs: Overview shows Zavi working above the email cards before the run ends, then the card lands and the banner clears", async () => {
    await openEmailOverview();
    srv.startRunId = null;
    const newButtons = screen.getAllByTestId("new-campaign-button");
    fireEvent.click(newButtons[newButtons.length - 1]);
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    await vi.waitFor(() => expect(screen.getByTestId("channel-tab-overview").hidden).toBe(true));
    fireEvent.click(await screen.findByRole("radio", { name: /Newsletter/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off until Sunday" } });
    const button = screen.getByRole("button", { name: /Write it/ }) as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await vi.waitFor(() => expect(srv.starts).toBe(4), { timeout: 8_000 });
    await screen.findByText(/Zavi is still starting this/);
    expect(screen.queryByText(/Zavi is writing it/)).toBeNull();
    srv.workState = "running";
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    fireEvent.click(within(dialog).getAllByRole("button", { name: /Close|Cancel/ })[0]);
    await vi.waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    const overview = await vi.waitFor(() => {
      const o = screen.getByTestId("channel-overview");
      expect(o.closest("[hidden]")).toBeNull();
      return o;
    });
    await vi.waitFor(() => expect(overview.textContent).toContain("Cooking up new suggestions for Email campaigns"));
    let hiddenAncestor = false;
    for (let n: HTMLElement | null = within(overview).getByText(/Cooking up new suggestions for Email campaigns/); n; n = n.parentElement) if (n.hidden) hiddenAncestor = true;
    expect(hiddenAncestor).toBe(false);
    expect(cards()).toEqual(["email-old"]);
    srv.workState = "needs_review";
    await finishRunWithBannerSignal();
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    await vi.waitFor(() => expect(working()).toBe(false));
    expect(srv.starts).toBe(4);
  }, 20_000);

  it("a card filed by a run this page did not start lands on the same signal the needs-you banner refreshes on", async () => {
    const overview = await openEmailOverview();
    srv.channelRows = [newRow, oldRow];
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ATTENTION_CHANGED_EVENT));
    });
    await vi.waitFor(() => expect(cards()).toEqual(["email-new", "email-old"]));
    expect(screen.getByTestId("channel-overview")).toBe(overview);
  });
});
