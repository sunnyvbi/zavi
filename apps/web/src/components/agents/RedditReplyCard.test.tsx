// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RedditReplyCard,
  type RedditReplyOpportunity,
} from "./RedditReplyCard";
import { apiFetch } from "@/lib/api";
import { RedditDeliveryUnconfirmed, redditDeliveryStatus, submitToReddit } from "@/components/workspace/agent/reddit/publish";
import { resetRedditPublishStates } from "@/components/workspace/agent/reddit/useRedditPublish";
import { startRailConnect } from "@/app/connectors/connectStrategies";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("@/components/workspace/agent/reddit/publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace/agent/reddit/publish")>()),
  submitToReddit: vi.fn(),
  redditDeliveryStatus: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);
const mockPublish = vi.mocked(submitToReddit);
const mockConnect = vi.mocked(startRailConnect);
const mockStatus = vi.mocked(redditDeliveryStatus);

const opportunity: RedditReplyOpportunity = {
  id: "reply-one",
  type: "reddit_reply",
  subreddit: "turo",
  thread_title: "How should hosts document vehicle condition?",
  thread_url: "https://www.reddit.com/r/turo/comments/example",
  body: "I work on Upcar. The first thing I would check is...",
  reply_style: "Direct answer",
  rule_status: "ready",
  potential: {
    level: "promising",
    confidence: "high",
    reasons: ["The question directly matches verified expertise"],
  },
};

describe("RedditReplyCard", () => {
  beforeEach(() => {
    resetRedditPublishStates();
    cleanup();
    mockFetch.mockReset();
    mockPublish.mockReset();
    mockConnect.mockReset();
    mockStatus.mockReset();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("links to the source thread and copies only the suggested reply", async () => {
    render(<RedditReplyCard opportunity={opportunity} connected />);
    expect(screen.getByText("Reply opportunity")).toBeTruthy();
    expect(screen.getByRole("link", { name: /How should hosts/ })).toHaveProperty("href", opportunity.thread_url);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(opportunity.body));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("offers exactly Copy and Approve & post", () => {
    render(<RedditReplyCard opportunity={opportunity} connected />);
    const actions = screen.getAllByRole("button").filter((b) => !b.hasAttribute("aria-expanded"));
    expect(actions.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Copy", "Approve & post"]);
  });

  it("disables Copy and Approve when the current rules disallow the reply", () => {
    render(<RedditReplyCard opportunity={{ ...opportunity, rule_status: "not_allowed" }} connected />);
    expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Approve & post" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks to connect Reddit instead of posting when no account is connected", async () => {
    mockConnect.mockResolvedValue(undefined);
    render(<RedditReplyCard opportunity={opportunity} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Reddit to post" }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledWith("reddit", "reddit_social"));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("posts the reply to its thread, then closes the run draft through its approval", async () => {
    mockPublish.mockResolvedValue({ decisionId: "d-new", status: "published" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(<RedditReplyCard opportunity={opportunity} onChanged={onChanged} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Posted");
    const [action, content, ownProposal] = mockPublish.mock.calls[0];
    expect(action.body.link).toBe(opportunity.thread_url);
    expect(content).toEqual({ text: opportunity.body });
    expect(ownProposal).toMatchObject({ ownProposal: false, publishNow: true });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/approvals/reply-one/approve");
    expect(onChanged).toHaveBeenCalled();
  });

  it("closes a channel-action card through the channel-actions route after posting", async () => {
    mockPublish.mockResolvedValue({ decisionId: "d-new", status: "published" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    render(<RedditReplyCard opportunity={{ ...opportunity, action_source: "channel_action" }} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Posted");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/channel-actions/reply-one");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body)).action).toBe("acted");
  });

  it("refuses to post a reply that has no thread", async () => {
    render(<RedditReplyCard opportunity={{ ...opportunity, thread_url: undefined }} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This reply has no Reddit thread to post on.");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("shows Reddit's refusal and keeps the card open when posting fails", async () => {
    mockPublish.mockRejectedValue(new Error("Reddit did not take it (THREAD_LOCKED)."));
    const onChanged = vi.fn();
    render(<RedditReplyCard opportunity={opportunity} onChanged={onChanged} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Reddit did not take it (THREAD_LOCKED).");
    expect(screen.queryByText("Posted")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("says the reply went out when only closing the card fails", async () => {
    mockPublish.mockResolvedValue({ decisionId: "d-new", status: "published" });
    mockFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) } as Response);
    render(<RedditReplyCard opportunity={{ ...opportunity, action_source: "channel_action" }} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Posted");
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Posted to Reddit, but Zavi could not mark this card as done/);
  });

  it("offers Check again after an unconfirmed delivery and never stages a second reply", async () => {
    mockPublish.mockRejectedValue(new RedditDeliveryUnconfirmed("d-9"));
    mockStatus.mockResolvedValue({ decisionId: "d-9", status: "published" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    render(<RedditReplyCard opportunity={opportunity} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not confirm/);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Posted");
    expect(mockStatus).toHaveBeenCalledWith("d-9", 1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("shows a scheduled reply as Scheduled and leaves the card open", async () => {
    mockPublish.mockResolvedValue({ decisionId: "d-5", status: "scheduled" });
    const onChanged = vi.fn();
    render(<RedditReplyCard opportunity={opportunity} onChanged={onChanged} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Scheduled");
    expect(screen.queryByText("Posted")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps Posted after the card remounts, so the reply cannot be sent twice", async () => {
    mockPublish.mockResolvedValue({ decisionId: "d-1", status: "published" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const view = render(<RedditReplyCard opportunity={opportunity} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Posted");
    view.unmount();
    render(<RedditReplyCard opportunity={opportunity} connected />);
    expect(screen.getByText("Posted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & post" })).toBeNull();
  });
});
