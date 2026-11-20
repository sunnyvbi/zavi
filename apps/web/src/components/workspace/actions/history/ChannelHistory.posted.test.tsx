import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChannelClosedRow, ChannelHistoryState } from "../useChannelHistory";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ChannelHistory } from "./ChannelHistory";
import { historyTimeline } from "./historyPresentation";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

const LIVE = "https://www.linkedin.com/feed/update/urn:li:share:7392";
const row = (over: Partial<ChannelClosedRow> = {}): ChannelClosedRow => ({
  id: "lp1",
  run_id: "run-li",
  position: 1,
  run_of: 1,
  action_type: "text_post",
  title: "Review and edit your post on first paid ads tests",
  status: "acted",
  status_at: "2026-11-03T09:00:00Z",
  note: null,
  proposed_at: "2026-11-03T08:00:00Z",
  impact: null,
  impact_reason: null,
  score: null,
  ...over,
});
const state = (closed: ChannelClosedRow[]): ChannelHistoryState => ({ state: "ready", history: { runs: [], closed, pre_switch: [] } });
const openHistory = () => fireEvent.click(screen.getByRole("button", { name: /^History/ }));

describe("History for a LinkedIn post that went live", () => {
  it("shows a View post link to the live post on the row and in its details, and says it was posted", () => {
    render(<ChannelHistory slug="linkedin_organic" history={state([row({ receipt: { line: "Posted on LinkedIn.", url: LIVE } })])} />);
    openHistory();
    const region = screen.getByRole("region", { name: "History" });
    const link = within(region).getByTestId("history-receipt-link");
    expect(link.getAttribute("href")).toBe(LIVE);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toBe("View post");
    expect(link.closest("button")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: /Review and edit your post/ }));
    expect(screen.getByTestId("history-detail-receipt-link").getAttribute("href")).toBe(LIVE);
    expect(screen.getByText("Posted on LinkedIn")).toBeTruthy();
    expect(screen.queryByText("Marked as done")).toBeNull();
  });

  it("draws no link for a card closed by hand, a line with no URL, or a URL that is not https", () => {
    render(<ChannelHistory slug="linkedin_organic" history={state([
      row({ id: "a" }),
      row({ id: "b", receipt: { line: "Posted on LinkedIn." } }),
      row({ id: "c", receipt: { line: "Posted on LinkedIn.", url: "javascript:alert(1)" } }),
    ])} />);
    openHistory();
    expect(screen.queryByTestId("history-receipt-link")).toBeNull();
    expect(historyTimeline({ source: "action", row: row({ id: "a" }) }).map((e) => e.label)).toEqual(["Zavi suggested it", "Marked as done"]);
    expect(historyTimeline({ source: "action", row: row({ id: "b", receipt: { line: "Posted on LinkedIn." } }) }).map((e) => e.label)).toEqual(["Zavi suggested it", "Posted on LinkedIn"]);
  });

  it("never treats a rejected card's receipt as posted", () => {
    render(<ChannelHistory slug="linkedin_organic" history={state([row({ status: "rejected", receipt: { line: "Posted on LinkedIn.", url: LIVE } })])} />);
    openHistory();
    expect(screen.queryByTestId("history-receipt-link")).toBeNull();
  });
});
