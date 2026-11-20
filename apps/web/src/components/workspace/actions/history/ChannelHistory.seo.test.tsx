// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChannelClosedRow, ChannelHistoryState, ChannelRunRow } from "../useChannelHistory";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ChannelHistory } from "./ChannelHistory";

const row = (id: string, over: Partial<ChannelClosedRow> = {}): ChannelClosedRow => ({
  id,
  run_id: "run-1",
  position: 1,
  run_of: 2,
  action_type: "fix",
  title: `Card ${id}`,
  status: "acted",
  status_at: "2026-11-10T06:31:00Z",
  note: null,
  proposed_at: "2026-11-10T06:30:00Z",
  impact: null,
  impact_reason: null,
  score: null,
  ...over,
});
const ready = (closed: ChannelClosedRow[], runs: ChannelRunRow[] = []): ChannelHistoryState => ({ state: "ready", history: { runs, closed, pre_switch: [] } });
const historyButton = () => screen.getByRole("button", { name: /^History/ });

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("SEO history", () => {
  it("shows History with a zero count and an empty line when nothing has closed yet", () => {
    render(<ChannelHistory slug="seo" history={ready([], [{ run_id: "r1", executor: "e2b", trigger: "schedule", status: "success", enqueued_at: "2026-11-10T06:00:00Z", started_at: "2026-11-10T06:00:05Z", finished_at: "2026-11-10T06:05:00Z", redo_of_action_id: null }])} />);
    expect(historyButton().textContent).toContain("0");
    fireEvent.click(historyButton());
    expect(screen.getByTestId("history-empty").textContent).toContain("Nothing here yet");
    expect(screen.getByRole("button", { name: /^Logs/ })).toBeTruthy();
  });

  it("shows History even with no runs and no closed cards", () => {
    render(<ChannelHistory slug="seo" history={ready([])} />);
    expect(historyButton().textContent).toContain("0");
    expect(screen.queryByRole("button", { name: /^Logs/ })).toBeNull();
  });

  it("renders nothing while the read is not ready", () => {
    const { container } = render(<ChannelHistory slug="seo" history={{ state: "loading" }} />);
    expect(container.textContent).toBe("");
  });

  it("lists every closed SEO card with its title and outcome, and opens its detail", () => {
    const closed = [
      row("a", { title: "Point /upcar-ai at the homepage with a canonical tag", executed_at: "2026-11-10T06:32:00Z", approval: null }),
      row("b", { title: "Review the homepage canonical tag", action_type: "check", status: "rejected", note: "Already fine" }),
      row("c", { title: "Replace uncrawlable homepage links", status: "stale" }),
    ];
    render(<ChannelHistory slug="seo" history={ready(closed)} />);
    expect(historyButton().textContent).toContain("3");
    fireEvent.click(historyButton());
    expect(screen.queryByTestId("history-empty")).toBeNull();
    for (const c of closed) expect(screen.getByText(c.title)).toBeTruthy();
    fireEvent.click(screen.getByText("Review the homepage canonical tag"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("This suggestion was rejected.");
    expect(within(dialog).getByText("Review the homepage canonical tag", { exact: false })).toBeTruthy();
  });
});
