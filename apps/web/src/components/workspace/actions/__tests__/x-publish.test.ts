
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAction } from "./fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("../topActions/postToast", () => ({ followPostInToast: vi.fn(async () => ({ state: "posted", url: null })) }));
vi.mock("@/lib/api", () => ({ apiFetch }));
const publishPost = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../agent/xStagedPosts", async () => {
  const actual = await vi.importActual<typeof import("../../agent/xStagedPosts")>(
    "../../agent/xStagedPosts",
  );
  return { ...actual, publishPost };
});

import { x_organic } from "../platforms/x_organic";

const ORIGINAL = "Hello founders, today we launch the thing we have been building all year.";
const EDITED = "Hey founders, today we launch the thing we have been building all year.";

const card = makeAction("text_post", {
  channel_slug: "x_organic",
  body: { step: { body: "", effort: "minutes", evidence: [], deliverable: { kind: "post", label: "Post", content: ORIGINAL } } },
});

function dashboard(connected: boolean) {
  apiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      connected,
      drafts: [
        { decision_id: "staged-1", source: "staged", channel: "x", text: ORIGINAL, thread: null, image_path: "img.png", video_path: null, scheduled_at: null, rationale: null, emitted_at: null },
      ],
    }),
  });
}

beforeAll(async () => {
  await Promise.all([import("../../agent/xStagedPosts"), import("../types"), import("@/lib/api")]);
}, 30_000);

beforeEach(() => {
  apiFetch.mockReset();
  publishPost.mockClear();
});

describe("x_organic.publish", () => {
  it("a staged card approves its own decision without reading the dashboard", async () => {
    const own = { ...card, id: "dec-card", run_id: null };
    expect(await x_organic.publish!(own, { text: ORIGINAL, thread: null })).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
    const arg = (publishPost.mock.calls[0] as unknown as [{ staged: { decision_id: string } | null }])[0];
    expect(arg.staged?.decision_id).toBe("dec-card");
  });

  it("approves the STAGED proposal even when the founder edited the text first", async () => {
    dashboard(true);
    const ok = await x_organic.publish!(card, { text: EDITED, thread: null });
    expect(ok).toBe(true);
    expect(publishPost).toHaveBeenCalledTimes(1);
    const arg = (publishPost.mock.calls[0] as unknown as [{ staged: { decision_id: string } | null; channel: string; content: { text: string } }])[0];
    expect(arg.staged?.decision_id).toBe("staged-1");
    expect(arg.content.text).toBe(EDITED);
  });

  it("still approves the staged proposal when the card carries a SAVED AI edit", async () => {
    dashboard(true);
    const edited = { ...card, edited_body: { text: EDITED, thread: null } };
    await x_organic.publish!(edited, { text: EDITED, thread: null });
    const arg = (publishPost.mock.calls[0] as unknown as [{ staged: { decision_id: string } | null }])[0];
    expect(arg.staged?.decision_id).toBe("staged-1");
  });

  it("publishes on the social key, never on the growth channel's slug", async () => {
    dashboard(true);
    await x_organic.publish!(card, { text: EDITED, thread: null });
    const arg = (publishPost.mock.calls[0] as unknown as [{ channel: string }])[0];
    expect(arg.channel).toBe("x");
    expect(arg.channel).not.toBe("x_organic");
  });

  it("answers not-posted, and calls nothing, on an unconnected account", async () => {
    dashboard(false);
    expect(await x_organic.publish!(card, { text: ORIGINAL, thread: null })).toBe(false);
    expect(publishPost).not.toHaveBeenCalled();
  });
});

describe("x_organic: a reply never goes out as a post", () => {
  const replyCard = makeAction("reply", {
    channel_slug: "x_organic",
    body: { step: { body: "", effort: "minutes", evidence: [], deliverable: { kind: "comment", label: "Reply", content: "Turo is not passive income, and here is why." } } },
  });

  it("publish refuses it without reading the account or staging anything", async () => {
    dashboard(true);
    expect(await x_organic.publish?.(replyCard, { text: "Turo is not passive income, and here is why.", thread: null })).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("there is no composer link to open it with either", () => {
    expect(x_organic.composerUrl?.("Turo is not passive income, and here is why.", replyCard)).toBeNull();
  });

  it("a text_post still gets the intent link, and publish still runs", async () => {
    expect(x_organic.composerUrl?.(ORIGINAL, card)).toContain("intent/tweet");
    dashboard(true);
    expect(await x_organic.publish?.(card, { text: ORIGINAL, thread: null })).toBe(true);
    expect(publishPost).toHaveBeenCalledTimes(1);
  });
});
