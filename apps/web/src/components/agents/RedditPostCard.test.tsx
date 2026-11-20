// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedditPostCard, type RedditPostSuggestion } from "./RedditPostCard";
import { apiFetch } from "@/lib/api";
import { submitToReddit } from "@/components/workspace/agent/reddit/publish";
import { resetRedditPublishStates } from "@/components/workspace/agent/reddit/useRedditPublish";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("@/components/workspace/agent/reddit/publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace/agent/reddit/publish")>()),
  submitToReddit: vi.fn(),
}));
const mockPublish = vi.mocked(submitToReddit);

afterEach(cleanup);

const suggestion: RedditPostSuggestion = {
  id: "one",
  type: "reddit_post",
  subreddit: "smallbusiness",
  title: "What we learned after changing our intake flow",
  body: "Full disclosure, I run Acme.\n\nThe awkward part was not the form.",
  post_type: "text",
  style: "Lesson learned",
  affiliation_disclosure: "first_line",
  rule_status: "verify_manually",
  required_flair: "Discussion",
  potential: {
    level: "promising",
    confidence: "medium",
    reasons: ["The topic appears in the current community sample"],
  },
};

describe("RedditPostCard", () => {
  beforeEach(() => {
    resetRedditPublishStates();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("looks like a Reddit post and keeps Copy post beside the post action", async () => {
    render(<RedditPostCard suggestion={suggestion} />);
    expect(screen.getByText("r/smallbusiness")).toBeTruthy();
    expect(screen.getByText(suggestion.title)).toBeTruthy();
    expect(screen.getByText("Verify rules")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Reddit to post" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy post" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `${suggestion.title}\n\n${suggestion.body}`,
      ),
    );
  });

  it("disables the primary copy action when current rules disallow the post", () => {
    render(
      <RedditPostCard
        suggestion={{ ...suggestion, rule_status: "not_allowed" }}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Copy post" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Copy title" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Copy body" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Not allowed here")).toBeTruthy();
  });

  it("loads generated images through the run-artifact contract", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ signed_url: "https://example.test/reddit.png" }),
    } as Response);
    render(
      <RedditPostCard
        suggestion={{
          ...suggestion,
          post_type: "image",
          image_artifact_id: "artifact-123",
        }}
      />,
    );
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/run-artifacts/artifact-123/url",
      ),
    );
    expect(
      (await screen.findByAltText("Suggested Reddit post visual")).getAttribute(
        "src",
      ),
    ).toBe("https://example.test/reddit.png");
  });

  it("does not offer a complete image post when its artifact cannot load", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    render(
      <RedditPostCard
        suggestion={{
          ...suggestion,
          post_type: "image",
          image_artifact_id: "missing-artifact",
        }}
      />,
    );
    expect(
      await screen.findByText("Image unavailable. Run again"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Copy post" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("posts the text post from the connected account, then closes the suggestion", async () => {
    mockPublish.mockReset().mockResolvedValue({ decisionId: "d-new", status: "published" });
    vi.mocked(apiFetch).mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(
      <RedditPostCard
        suggestion={{ ...suggestion, required_flair: undefined, action_source: "channel_action" }}
        onChanged={onChanged}
        connected
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await screen.findByText("Posted");
    const [action, content, ownProposal] = mockPublish.mock.calls[0];
    expect(action.body.step?.deliverable?.presentation).toMatchObject({
      type: "reddit_post",
      subreddit: "smallbusiness",
      title: suggestion.title,
    });
    expect(content).toEqual({ text: suggestion.body });
    expect(ownProposal).toMatchObject({ ownProposal: false, publishNow: true });
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe("/api/channel-actions/one");
    expect(onChanged).toHaveBeenCalled();
  });

  it("explains a required flair instead of posting without it", async () => {
    mockPublish.mockReset();
    render(<RedditPostCard suggestion={suggestion} connected />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      `r/smallbusiness needs the "Discussion" flair, which Zavi can't set yet.`,
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
