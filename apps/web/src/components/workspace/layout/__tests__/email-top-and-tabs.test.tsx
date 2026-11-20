// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const srv = vi.hoisted(() => ({
  calls: [] as string[],
  actions: [] as unknown[],
  completed: [] as unknown[],
  emails: [] as unknown[],
  run: { status: "running", actions: [] as unknown[] },
}));
const body = (url: string) => {
  if (url.includes("/top-actions/runs/")) return srv.run;
  if (url.startsWith("/api/channels/email_marketing/actions")) return { actions: srv.actions, completed: srv.completed, more: 0, store: "channel_actions" };
  if (url.startsWith("/api/channels/blog/actions")) return { actions: [], more: 0, store: "channel_actions" };
  if (url.startsWith("/api/email-results")) return { emails: srv.emails, more: false };
  if (url.startsWith("/api/connectors")) return { connectors: [] };
  if (url.startsWith("/api/workspace/email-plan")) return { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], holds: [], released: [] };
  return {};
};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    srv.calls.push(url);
    return { ok: true, status: 200, json: async () => body(url) };
  },
}));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id }: { id: string }) => <div data-testid="email-card" data-id={id} />,
  EmailPreviewFrame: () => null,
}));
vi.mock("../../WorkspaceShell", async (load) => ({
  ...(await load<typeof import("../../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));

import { ChannelPanel } from "../ChannelPanel";
import { ChannelSurface } from "../../actions/ChannelSurface";
import { makeAction } from "../../actions/__tests__/fixtures";
import type { ChannelDetail } from "../channelDetail";
import { announceChannelRunStarted, forgetChannelRun } from "../../actions/topActions/api";
import { noteApiWrite } from "@/lib/workspace/apiWrites";
import { listenForTenantSwitches } from "@/lib/workspace/tenantSwitch";

const RUN = "5b0c1e2a-0000-4000-8000-000000000002";
const detail = (slug: string, workState: ChannelDetail["workState"] = "delivered"): ChannelDetail => ({
  channel: (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!,
  mode: "produce",
  connected: true,
  connectors: [],
  workState,
  lastRunAt: "2026-11-01T00:00:00.000Z",
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});
const panel = (slug = "email_marketing", workState?: ChannelDetail["workState"]) => (
  <ChannelSurface slug={slug}>
    <ChannelPanel key="page" detail={detail(slug, workState)} actionCount={0} onOpenConnectors={() => undefined} />
  </ChannelSurface>
);
const draft = (id: string, proposed_at: string, over: Record<string, unknown> = {}) =>
  makeAction("send_message", { id, channel_slug: "email_marketing", title: `Email ${id}`, status: "pending", exec_status: null, email_card: true, proposed_at, ...over });
const settled = () => screen.findByTestId("channel-tab-overview");
const tab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));
const quiet = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
};
const cards = () => screen.queryAllByTestId("email-card").map((c) => c.getAttribute("data-id"));

beforeEach(() => {
  srv.calls.length = 0;
  srv.actions = [];
  srv.completed = [];
  srv.emails = [];
  srv.run = { status: "running", actions: [] };
  window.sessionStorage.clear();
  window.localStorage.clear();
  forgetChannelRun("email_marketing", RUN);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the working loader on a New campaign run", () => {
  it("sits at the top of What Zavi wants to do and leaves when the run ends", async () => {
    srv.actions = [draft("older", "2026-11-01T00:00:00.000Z"), draft("fix-it", "2026-11-01T00:00:00.000Z", { email_card: false, blocking: true })];
    render(panel());
    await screen.findByTestId("action-section");
    act(() => announceChannelRunStarted("email_marketing", RUN));
    const writing = await screen.findByTestId("top-action-writing");
    expect(writing.textContent).toContain("Cooking up new suggestions for");
    expect(screen.getByTestId("action-section").contains(writing)).toBe(true);
    expect(writing.compareDocumentPosition(screen.getAllByTestId("email-card")[0]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    srv.actions = [...srv.actions, draft("fresh", "2026-11-02T00:00:00.000Z")];
    srv.run = { status: "success", actions: [{ id: "fresh" }] };
    await act(async () => {
      window.dispatchEvent(new Event("zavi:attention-changed"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await waitFor(() => expect(screen.queryByTestId("top-action-writing")).toBeNull());
    await waitFor(() => expect(cards()).toContain("fresh"));
  });

  it("filed cards stay inside the section, in the server's order", async () => {
    srv.actions = [draft("older", "2026-11-01T00:00:00.000Z"), draft("newest", "2026-11-03T00:00:00.000Z")];
    render(panel());
    const section = await screen.findByTestId("action-section");
    await waitFor(() => expect(within(section).queryAllByTestId("email-card").map((c) => c.getAttribute("data-id"))).toEqual(["older", "newest"]));
  });

  it("nothing scrolls when a run starts", async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    render(panel());
    await screen.findByTestId("action-section");
    act(() => announceChannelRunStarted("email_marketing", RUN));
    await screen.findByTestId("top-action-writing");
    await quiet();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("a reload in the middle of the run shows the loader in the same spot", async () => {
    act(() => announceChannelRunStarted("email_marketing", RUN));
    render(panel());
    const writing = await screen.findByTestId("top-action-writing");
    await screen.findByTestId("action-section");
    expect(screen.getByTestId("action-section").contains(screen.getByTestId("top-action-writing"))).toBe(true);
    expect(writing.isConnected).toBe(true);
  });
});

describe("Overview and Settings stay as they were on a tab switch", () => {
  it("first load reads each Overview route once, and Settings not at all until it is opened", async () => {
    render(panel());
    await screen.findByTestId("action-section");
    await quiet();
    const reads = (needle: string) => srv.calls.filter((u) => u.startsWith(needle)).length;
    expect(reads("/api/email-results")).toBe(0);
    expect(reads("/api/channels/email_marketing/actions")).toBe(1);
    expect(reads("/api/workspace/email-plan")).toBeLessThanOrEqual(3);
    expect(reads("/api/channels/email_marketing/history")).toBeLessThanOrEqual(2);
    expect(screen.queryByTestId("channel-tab-settings")).toBeNull();
    const twice = srv.calls.filter((u, i) => srv.calls.indexOf(u) !== i && !u.includes("email-plan") && !u.includes("/history") && !u.includes("email-test-lists"));
    expect(twice).toEqual([]);
  });

  it("back on Overview: same nodes, no skeleton, not one API call", async () => {
    render(panel());
    const strip = await screen.findByTestId("action-section");
    await quiet();
    tab(/Settings/);
    await screen.findByTestId("channel-tab-settings");
    await quiet();
    expect(screen.getByTestId("channel-tab-overview").hidden).toBe(true);
    const settingsCalls = srv.calls.length;
    tab(/Overview/);
    expect(screen.queryByTestId("sent-emails-loading")).toBeNull();
    await quiet();
        expect(srv.calls.slice(settingsCalls).filter((u) => !u.includes("channel-seen"))).toEqual([]);
    expect(screen.getByTestId("action-section")).toBe(strip);
    expect(screen.getByTestId("channel-tab-overview").hidden).toBe(false);
    expect(screen.getByTestId("channel-tab-settings").hidden).toBe(true);
    tab(/Settings/);
    await quiet();
    expect(srv.calls.slice(settingsCalls).filter((u) => !u.includes("channel-seen"))).toEqual([]);
  });

  it("keeps where the page was scrolled on each tab", async () => {
    const { container } = render(<div style={{ overflowY: "auto" }}>{panel()}</div>);
    await screen.findByTestId("action-section");
    const scroller = container.firstElementChild as HTMLElement;
    scroller.scrollTop = 640;
    fireEvent.scroll(scroller);
    tab(/Settings/);
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    tab(/Overview/);
    expect(scroller.scrollTop).toBe(640);
  });

  it("a save on Settings updates Overview on the way back, quietly", async () => {
    render(panel());
    await screen.findByTestId("action-section");
    await quiet();
    tab(/Settings/);
    await quiet();
    act(() => noteApiWrite("/api/workspace/email-template"));
    srv.calls.length = 0;
    srv.actions = [draft("after-save", "2026-11-02T00:00:00.000Z")];
    tab(/Overview/);
    await waitFor(() => expect(cards()).toEqual(["after-save"]));
  });

  it("a write made on Overview does not trigger the refresh on the next return", async () => {
    render(panel());
    await screen.findByTestId("action-section");
    await quiet();
    act(() => noteApiWrite("/api/somewhere"));
    tab(/Settings/);
    await quiet();
    srv.calls.length = 0;
    tab(/Overview/);
    await quiet();
    expect(srv.calls.filter((u) => !u.includes("channel-seen"))).toEqual([]);
  });

  it("a card change while Settings is showing still reaches the hidden Overview", async () => {
    render(panel());
    await screen.findByTestId("action-section");
    await quiet();
    tab(/Settings/);
    await quiet();
    srv.actions = [draft("landed", "2026-11-02T00:00:00.000Z")];
    await act(async () => {
      window.dispatchEvent(new CustomEvent("zavi:channel-actions-changed", { detail: { slug: "email_marketing" } }));
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(cards()).toEqual(["landed"]));
  });

  it("a hidden Overview does not poll while a run goes, and picks up again on return", async () => {
    srv.actions = [draft("in-flight", "2026-11-01T00:00:00.000Z", { exec_status: "queued", status: "acted" })];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(panel("email_marketing", "running"));
    await screen.findByTestId("action-section");
    await quiet();
    tab(/Settings/);
    await quiet();
    srv.calls.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(srv.calls.filter((u) => u.includes("/email_marketing/actions"))).toEqual([]);
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(srv.calls.filter((u) => u.includes("/email_marketing/actions")).length).toBeGreaterThan(0);
  });

  it("leaving the channel keeps nothing: the way back is a full load", async () => {
    const { rerender } = render(panel());
    await screen.findByTestId("action-section");
    await quiet();
    tab(/Settings/);
    await quiet();
    rerender(panel("blog"));
    await quiet();
    expect(screen.queryByTestId("channel-tab-overview")).toBeNull();
    expect(screen.queryByTestId("email-settings")).toBeNull();
    srv.calls.length = 0;
    rerender(panel());
    await waitFor(() => expect(screen.queryAllByRole("tab").length).toBeGreaterThan(1));
    tab(/Overview/);
    await screen.findByTestId("channel-tab-overview");
    await waitFor(() => expect(srv.calls.some((u) => u.startsWith("/api/channels/email_marketing/actions"))).toBe(true));
  });

  it("a tenant switch reaches the page on Settings, and the fresh mount shows only the new company", async () => {
    const onSwitch = vi.fn();
    const stop = listenForTenantSwitches(onSwitch);
    srv.actions = [draft("old-company", "2026-11-01T00:00:00.000Z")];
    const first = render(panel());
    await waitFor(() => expect(cards()).toEqual(["old-company"]));
    tab(/Settings/);
    await quiet();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "zavi:active-tenant", newValue: "other" }));
    });
    stop();
    first.unmount();
    srv.actions = [draft("other-company", "2026-11-02T00:00:00.000Z")];
    render(panel());
    await waitFor(() => expect(cards()).toEqual(["other-company"]));
  });
});
