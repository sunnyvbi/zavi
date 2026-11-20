import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: vi.fn() }));

import { slackFetch } from "@/services/tools/slack/_client";
import { postMessageTool } from "@/services/tools/slack/post_message";
import { linksToOwnApp } from "@/services/web-base";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;
const ctx = { tenant_id: "00000000-0000-0000-0000-0000000000aa", slack_team_id: "T1", log: () => {} };
const posted = () => mockedFetch.mock.calls[0][2] as Record<string, unknown>;
const post = (text: string, extra: Record<string, unknown> = {}) => postMessageTool.execute(ctx, { channel_id: "C123456789", text, ...extra });

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue({ ts: "1.0", channel: "C123456789" });
  vi.stubEnv("WEB_BASE_URL", "https://www.example-app.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slack_post_message link previews", () => {
  it("turns previews off when the text links to our own app", async () => {
    await post("Approve it here: <https://www.example-app.com/workspace?tab=channels|Open>");
    expect(posted()).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  it("leaves Slack's default for an outside link only", async () => {
    await post("Worth a read: https://news.example.org/story");
    expect(posted()).not.toHaveProperty("unfurl_links");
    expect(posted()).not.toHaveProperty("unfurl_media");
  });

  it("respects a caller that asked for previews", async () => {
    await post("https://www.example-app.com/pricing", { unfurl_links: true });
    expect(posted()).not.toHaveProperty("unfurl_links");
  });

  it("still posts when the base URL cannot be read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_BASE_URL", "not a url");
    await post("https://www.example-app.com/pricing");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(posted()).not.toHaveProperty("unfurl_links");
  });
});

describe("linksToOwnApp", () => {
  it.each([
    ["https://www.example-app.com/x", true],
    ["http://example-app.com", true],
    ["see https://inbox.example-app.com/a?b=1.", true],
    ["<https://example-app.com|Open>", true],
    ["https://example-app.com.evil.io/x", false],
    ["https://notexample-app.com/x", false],
    ["example-app.com without a scheme", false],
    ["https://news.example.org/?u=example-app.com", false],
  ])("%s -> %s", (text, want) => {
    expect(linksToOwnApp(text)).toBe(want);
  });
});
