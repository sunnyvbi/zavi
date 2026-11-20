// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { BrandMentionsTable } from "./BrandMentionsTable";
import { submitToReddit } from "./publish";
import { resetRedditPublishStates } from "./useRedditPublish";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("./publish", async (importOriginal) => ({ ...(await importOriginal<typeof import("./publish")>()), submitToReddit: vi.fn() }));
const mockFetch = vi.mocked(apiFetch);
afterEach(() => {
  cleanup();
  mockFetch.mockReset();
  resetRedditPublishStates();
});

const mention = (subreddit: string) => ({
  thread_id: `t-${subreddit}`,
  url: `https://www.reddit.com/r/${subreddit}/comments/abc${subreddit}/title/`,
  subreddit,
  title: "Anyone tried Acme?",
  author: null,
  term: "acme",
  sentiment: null,
  score: 3,
  comment_count: 1,
  observed_at: new Date().toISOString(),
  draft: null,
});

async function draftFor(subreddit: string, verdict: "allowed" | "banned") {
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ draft: { text: "Thanks for trying it." } }), { status: 200 }));
  render(
    <BrandMentionsTable
      lists={{ brand_mentions: [mention(subreddit)] } as never}
      total={1}
      terms={["acme"]}
      onChanged={() => undefined}
      connected
      communities={[{ name: subreddit, rules_verdict: verdict }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));
  return screen.findByRole("button", { name: /Approve & post/ });
}

it("never offers to post a brand-mention reply in a community that bans self-promotion", async () => {
  const button = await draftFor("promo", "banned");
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/does not allow self-promotion/)).toBeTruthy();
  fireEvent.click(button);
  expect(vi.mocked(submitToReddit)).not.toHaveBeenCalled();
});

it("an allowed community keeps Approve & post", async () => {
  expect(((await draftFor("saas", "allowed")) as HTMLButtonElement).disabled).toBe(false);
});

function renderSaved(draft: { text: string | null; state: "drafted" | "posted" | "dismissed" }) {
  render(
    <BrandMentionsTable
      lists={{ brand_mentions: [{ ...mention("saas"), draft }] } as never}
      total={1}
      terms={["acme"]}
      onChanged={() => undefined}
      connected
      communities={[{ name: "saas", rules_verdict: "allowed" }]}
    />,
  );
}

it("a thread already replied to shows Posted, with no way to draft and post it again", () => {
  renderSaved({ text: "Thanks for trying it.", state: "posted" });

  expect(screen.getByText("Posted")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Draft reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve & post/ })).toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("a saved draft opens with its own text instead of paying for a new one", async () => {
  renderSaved({ text: "Here is what worked for us.", state: "drafted" });

  expect(screen.queryByRole("button", { name: "Draft reply" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show draft" }));

  expect(await screen.findByText("Here is what worked for us.")).toBeTruthy();
  expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/draft"), expect.anything());
});
