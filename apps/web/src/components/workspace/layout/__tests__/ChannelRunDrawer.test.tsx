// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChannelRunFoot } from "../ChannelRunFoot";
import { ChannelRunDrawer, ChannelRunDrawerView, RUN_PAGE } from "../ChannelRunDrawer";
import { renderToString } from "react-dom/server";
import { ChannelSurface } from "../../actions/ChannelSurface";
import { CHANNELS, campaignMediaChannels } from "@zavi/shared";
import { AdsChannelHistory } from "../../actions/history/AdsChannelHistory";
import type { ChannelHistoryState } from "../../actions/useChannelHistory";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/memory/RememberedPill", () => ({ RememberedPill: () => null }));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const SLUG = "email_marketing";

const PAYLOAD = {
  runs: [
    {
      run_id: "run-ok",
      executor: "email-marketer",
      trigger: "cron",
      status: "success",
      enqueued_at: "2026-09-18T10:00:00Z",
      started_at: "2026-09-18T10:00:05Z",
      finished_at: "2026-09-18T10:04:00Z",
      redo_of_action_id: null,
    },
    {
      run_id: "run-bad",
      executor: "email-marketer",
      trigger: "manual",
      status: "parse_failed",
      enqueued_at: "2026-09-17T10:00:00Z",
      started_at: "2026-09-17T10:00:05Z",
      finished_at: "2026-09-17T10:01:00Z",
      redo_of_action_id: null,
    },
  ],
  closed: [
    {
      id: "act-1",
      run_id: "run-ok",
      position: 1,
      run_of: 3,
      action_type: "text_post",
      title: "Send the September re-engagement mail",
      status: "acted",
      status_at: "2026-09-18T12:00:00Z",
      note: "Sent it from the shared inbox.",
      proposed_at: "2026-09-18T10:03:00Z",
      impact: 4,
      impact_reason: null,
      score: 12.5,
    },
  ],
  pre_switch: [
    {
      run_id: "run-old",
      title: "Old step from before the move",
      position: 2,
      of: 5,
      status: "archived",
      emitted_at: "2026-09-01T09:00:00Z",
      archived_at: "2026-09-16T09:00:00Z",
      source: "decision",
    },
  ],
};

const answers = (body: unknown, ok = true) =>
  apiFetch.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

const ADS_HISTORY: ChannelHistoryState = {
  state: "ready",
  history: {
    runs: PAYLOAD.runs,
    closed: [{ ...PAYLOAD.closed[0], action_type: "create_ad", status: "acted" }],
    pre_switch: [],
  },
};

describe("advertising History and Logs", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });

  it.each(campaignMediaChannels)("uses separate reference disclosures on %s", async (slug) => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={slug} />);
    expect((await screen.findByRole("button", { name: "History 2" })).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /^Logs / }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    expect(screen.queryByText("Runs and past items")).toBeNull();
  });

  it("uses the reference history in the actual channel footer", async () => {
    answers(PAYLOAD);
    render(<ChannelRunFoot slug="meta_ads" />);
    expect(await screen.findByRole("button", { name: "History 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Logs / })).toBeTruthy();
    expect(screen.queryByTestId("run-drawer")).toBeNull();
  });

  it("opens real action details, closes on Escape and restores focus", () => {
    render(<AdsChannelHistory slug="meta_ads" history={ADS_HISTORY} />);
    fireEvent.click(screen.getByRole("button", { name: "History 1" }));
    const row = screen.getByRole("button", { name: /Send the September re-engagement mail/ });
    row.focus();
    fireEvent.click(row);
    const dialog = screen.getByRole("dialog", { name: "Send the September re-engagement mail" });
    expect(within(dialog).getByRole("heading", { name: "What happened" })).toBeTruthy();
    expect(within(dialog).getByText("Zavi suggested it")).toBeTruthy();
    expect(within(dialog).getByText("Marked as done")).toBeTruthy();
    expect(within(dialog).getByText("Sent it from the shared inbox.")).toBeTruthy();
    expect(within(dialog).queryByText("Measured results are not available for this item.")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Undo|Bring it back|Approve/ })).toBeNull();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("uses real run lifecycle records as logs and preserves failed status", () => {
    render(<AdsChannelHistory slug="meta_ads" history={ADS_HISTORY} />);
    fireEvent.click(screen.getByRole("button", { name: /^Logs / }));
    expect(screen.getAllByText("Run started").length).toBeGreaterThan(0);
    expect(screen.getByText("Finished · on schedule")).toBeTruthy();
    expect(screen.getByText("Times in UTC")).toBeTruthy();
    expect(screen.queryByText(/Compared them|Read your Meta Ads numbers/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more logs" }));
    expect(screen.getByText("Failed · you ran it").className).toContain("text-danger");
  });

  it("uses the danger badge palette without a conflicting muted text color", () => {
    if (ADS_HISTORY.state !== "ready") throw new Error("Fixture must be ready");
    render(<AdsChannelHistory slug="meta_ads" history={{ state: "ready", history: { ...ADS_HISTORY.history, closed: [{ ...ADS_HISTORY.history.closed[0], status: "rejected" }] } }} />);
    fireEvent.click(screen.getByRole("button", { name: "History 1" }));
    const badge = screen.getByText("Rejected").parentElement;
    expect(badge?.className).toContain("text-danger");
    expect(badge?.className).not.toContain("text-inkMuted");
  });

  it("keeps archived and stale details read-only without inventing restoration", () => {
    if (ADS_HISTORY.state !== "ready") throw new Error("Fixture must be ready");
    const history: ChannelHistoryState = { state: "ready", history: { ...ADS_HISTORY.history, closed: [{ ...ADS_HISTORY.history.closed[0], status: "stale" }], pre_switch: [{ ...PAYLOAD.pre_switch[0], source: "decision" }] } };
    render(<AdsChannelHistory slug="meta_ads" history={history} />);
    fireEvent.click(screen.getByRole("button", { name: "History 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Old step from before the move/ }));
    expect(screen.getByRole("dialog").textContent).toContain("cannot be approved or restored");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: /Send the September re-engagement mail/ }));
    expect(screen.getByRole("dialog").textContent).toContain("cannot be restored from history");
    expect(screen.queryByRole("button", { name: "Bring it back" })).toBeNull();
  });

  it("keeps the same initial markup during hydration in both themes", () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const element = <div className="workspace-shell"><AdsChannelHistory slug="meta_ads" history={ADS_HISTORY} /></div>;
      const container = document.createElement("div");
      container.innerHTML = renderToString(element);
      document.body.append(container);
      const html = container.innerHTML;
      const mounted = render(element, { container, hydrate: true });
      expect(container.innerHTML).toBe(html);
      mounted.unmount();
      container.remove();
    }
    document.documentElement.classList.remove("dark");
  });
});

const settle = async () => {
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
};

describe("ChannelRunDrawer", () => {
  it("renders all three lists, closed, when the read lands", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);

    const drawer = await screen.findByTestId("run-drawer");
    expect((drawer as HTMLDetailsElement).open).toBe(false);
    expect(within(drawer).getByText("4")).toBeTruthy();
    const count = within(drawer).getByTestId("run-drawer-count");
    expect(count.getAttribute("data-quiet")).toBe("true");
    expect(count.className).not.toMatch(/(^|\s)bg-ink(\s|$)/);

    expect(within(drawer).getByText("Runs")).toBeTruthy();
    expect(within(drawer).getByText("Finished here")).toBeTruthy();
    expect(within(drawer).getByText("Before the switch")).toBeTruthy();
    expect(
      within(drawer).getByText("Send the September re-engagement mail"),
    ).toBeTruthy();
    expect(within(drawer).getByText("Old step from before the move")).toBeTruthy();
  });

  it("lists Finished here first and keeps Runs behind its own closed toggle", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    const finished = within(drawer).getByText("Finished here");
    const runs = within(drawer).getByTestId("section-runs") as HTMLDetailsElement;
    expect(finished.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runs.tagName).toBe("DETAILS");
    expect(runs.open).toBe(false);
  });

  it("gives the pre-switch rows NO control of any kind", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);

    const fold = await screen.findByTestId("pre-switch");
    expect(within(fold).queryAllByRole("button")).toHaveLength(0);
    expect(within(fold).queryAllByRole("link")).toHaveLength(0);
    expect(fold.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    expect(fold.textContent).toContain("priced against an account that has moved on");
  });

  it("does not render a failed run as a finished one", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);

    const failed = await screen.findByText("Failed");
    expect(failed.className).toContain("text-danger");
    const ok = screen.getByText("Finished");
    expect(ok.className).not.toContain("text-danger");
    expect(document.body.textContent).not.toContain("parse_failed");
  });

  it("says the history could not be read, instead of showing an empty one", async () => {
    answers({ error: { code: "read_failed" } }, false);
    render(<ChannelRunDrawer slug={SLUG} />);

    const said = await screen.findByTestId("channel-refresh-line");
    expect(said.textContent).toMatch(/couldn.t refresh just now/i);
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    expect(document.body.textContent).not.toContain("Runs and past items");
  });

  it("shows no count, and no drawer, while the read is in flight", async () => {
    let land!: (v: unknown) => void;
    apiFetch.mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    const { container } = render(<ChannelRunDrawer slug={SLUG} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    expect(container.textContent).toBe("");

    await act(async () => {
      land({ ok: true, status: 200, json: async () => ({ runs: [], closed: [], pre_switch: [] }) });
    });
  });

  it("renders nothing at all for a channel that has never run", async () => {
    answers({ runs: [], closed: [], pre_switch: [] });
    const { container } = render(<ChannelRunDrawer slug={SLUG} />);

    await settle();
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("ChannelRunDrawer layout", () => {
  const manyRuns = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      run_id: `run-${i}`,
      executor: "email-marketer",
      trigger: "cron",
      status: "success",
      enqueued_at: new Date(Date.now() - i * 86_400_000).toISOString(),
      started_at: null,
      finished_at: new Date(Date.now() - i * 86_400_000).toISOString(),
      redo_of_action_id: null,
    }));

  it("pages a long run list five at a time and keeps the count honest", async () => {
    answers({ runs: manyRuns(12), closed: [], pre_switch: [] });
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    expect(RUN_PAGE).toBe(5);
    expect(within(drawer).getByText("12")).toBeTruthy();
    expect(drawer.querySelectorAll("li")).toHaveLength(5);
    expect(within(drawer).getByText("5 of 12")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Show more" }));
    expect(drawer.querySelectorAll("li")).toHaveLength(10);
    expect(within(drawer).getByText("10 of 12")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Show more" }));
    expect(drawer.querySelectorAll("li")).toHaveLength(12);
    expect(within(drawer).queryByRole("button")).toBeNull();
    expect(within(drawer).getByText("12 of 12")).toBeTruthy();
  });

  it("shows no pager when one page holds every row", async () => {
    answers({ runs: manyRuns(RUN_PAGE), closed: [], pre_switch: [] });
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    expect(drawer.querySelectorAll("li")).toHaveLength(RUN_PAGE);
    expect(within(drawer).queryByRole("button")).toBeNull();
  });

  it("rows carry no arrow icon; the header has one small chevron and no native marker", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    drawer.querySelectorAll("li").forEach((li) => expect(li.querySelectorAll("svg")).toHaveLength(0));
    expect(drawer.querySelector('[class*="lucide-arrow"]')).toBeNull();
    const summary = drawer.querySelector("summary")!;
    expect(summary.className).toContain("[&::-webkit-details-marker]:hidden");
    expect(summary.className).toContain("list-none");
    const chevron = within(summary).getByTestId("run-drawer-chevron");
    expect(chevron.getAttribute("class")).toContain("lucide-chevron-down");
    expect(chevron.getAttribute("class")).toContain("group-open:rotate-180");
    expect(drawer.className).toContain("group");
  });

  it("the header's hover fills the whole box: no vertical padding on the box, clipped to its corners", async () => {
    answers(PAYLOAD);
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    const box = drawer.className.split(/\s+/);
    expect(box.some((c) => /^py-|^pt-|^pb-/.test(c))).toBe(false);
    expect(box).toContain("overflow-hidden");
    const summary = within(drawer).getByTestId("run-drawer-summary");
    expect(summary.className).toContain("-mx-4");
    expect(summary.className).toContain("hover:bg-creamDeep/60");
    expect(summary.className).toContain("focus-visible:ring-inset");
  });

  it("puts each day label in its own right-hand slot, not glued to the status words", async () => {
    answers({ ...PAYLOAD, runs: manyRuns(2) });
    render(<ChannelRunDrawer slug={SLUG} />);
    const drawer = await screen.findByTestId("run-drawer");
    const days = within(drawer).getAllByTestId("row-day");
    const runDays = within(within(drawer).getByTestId("section-runs")).getAllByTestId("row-day");
    expect(runDays.map((d) => d.textContent)).toEqual(["Today", "Yesterday"]);
    for (const d of days) {
      expect(d.className).toContain("shrink-0");
      expect(d.parentElement!.className).toContain("gap-3");
    }
    const firstRow = within(drawer).getByTestId("section-runs").querySelector("li")!;
    expect(within(firstRow).getByText(/Finished/).textContent).not.toContain("Today");
    const dot = within(firstRow).getByTestId("run-dot");
    expect(dot.parentElement!.className).toContain("h-5");
    expect(dot.parentElement!.className).toContain("items-center");
  });
});

describe("history across all channel surfaces", () => {
  it.each(CHANNELS.map((channel) => channel.slug).filter((slug) => slug !== "email_marketing"))("%s uses the shared History and Logs", (slug) => {
    render(<ChannelSurface slug={slug}><ChannelRunDrawerView slug={slug} history={ADS_HISTORY} /></ChannelSurface>);
    expect(screen.getByTestId("ads-channel-history")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^History/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Logs/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Undo|Restore|Bring it back/ })).toBeNull();
  });

  it("email_marketing shows a collapsed History card counting finished items and sent planned emails", async () => {
    apiFetch.mockImplementation(async (url: string) => url === "/api/workspace/email-plan"
      ? { ok: true, status: 200, json: async () => ({ ok: true, role: "owner", timezone: "UTC", items: [
        { id: "p1", route: "mailchimp", list_id: "L", list_name: "Regulars", planned_at: "2026-10-19T16:00:00Z", planned_label: "x", timezone: "UTC", angle: "Pumpkin loaf is back", why: null, source: "email_agent", status: "sent", status_reason: null, content_version: 1, schedule_gen: 1, card: { rail: "channel_actions", id: "card-9" }, vetoed: false, scheduled: null, unattended: false, sent_at: "2026-10-19T16:00:00Z" },
        { id: "p2", route: "mailchimp", list_id: "L", list_name: "Regulars", planned_at: "2026-10-25T16:00:00Z", planned_label: "x", timezone: "UTC", angle: "Still planned", why: null, source: "email_agent", status: "planned", status_reason: null, content_version: 1, schedule_gen: 1, card: null, vetoed: false, scheduled: null, unattended: false, sent_at: null },
      ], holds: [], released: [] }) }
      : { ok: true, status: 200, json: async () => ({}) });
    const history: ChannelHistoryState = { state: "ready", history: { ...ADS_HISTORY.history, closed: [...ADS_HISTORY.history.closed, { ...ADS_HISTORY.history.closed[0], id: "act-2", title: "A rejected one", status: "rejected" }] } };
    render(<ChannelSurface slug="email_marketing"><ChannelRunDrawerView slug="email_marketing" history={history} /></ChannelSurface>);
    expect(screen.getByRole("button", { name: /^Logs/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
    const done = await screen.findByRole("button", { name: /^History\s*2$/ });
    expect(done.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(done);
    expect(done.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Send the September re-engagement mail")).toBeTruthy();
    expect(screen.getByText("Pumpkin loaf is back").closest("a")!.getAttribute("href")).toBe("/workspace/email-cards/channel_actions/card-9");
    expect(screen.queryByText("A rejected one")).toBeNull();
    expect(screen.queryByText("Still planned")).toBeNull();
  });

  it("another channel keeps History with every closed item and no Done card", () => {
    render(<ChannelSurface slug="meta_ads"><ChannelRunDrawerView slug="meta_ads" history={ADS_HISTORY} /></ChannelSurface>);
    expect(screen.getByRole("button", { name: /^History/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Done/ })).toBeNull();
  });
});
