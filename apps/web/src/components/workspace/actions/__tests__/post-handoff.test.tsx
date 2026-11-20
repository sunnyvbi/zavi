// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChannelActionBody } from "@/lib/workspace/channelActionsApi";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor, xIntentUrl } from "../platforms";
import { redditSubmitUrl, replyPasteHint } from "@/lib/reddit/handoff";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";
import { startRailConnect } from "@/app/connectors/connectStrategies";
import { ChannelSurface } from "../ChannelSurface";
import { PostCard } from "../PostCard";
import { Reply } from "lucide-react";

vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(startRailConnect).mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function handlers(over: Partial<ActionHandlers> = {}) {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn(), ...over } satisfies ActionHandlers;
}

const THREAD = "https://www.reddit.com/r/smallbusiness/comments/abc123/how_do_you_price_a_retainer/";
const REPLY_TEXT = "We moved to a retainer after the third project. Bill it monthly and cap the hours.";
const POST_TEXT = "What finally made pricing click for us: bill for the month, not the deliverable.";

function redditBody(presentation: Record<string, unknown>, content: string): ChannelActionBody {
  return { step: { deliverable: { kind: "post", label: "Reply", content, presentation } } } as ChannelActionBody;
}

const reddit = platformFor("reddit_organic");

describe("a prefilled composer: Post is a link and copies nothing", () => {
  it("X keeps its intent link and does not touch the clipboard", async () => {
    const a = makeAction("text_post", {
      channel_slug: "x_organic",
      body: { step: { deliverable: { kind: "post", content: "Short enough for X." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: /^Open draft$/ });
    expect(link.getAttribute("href")).toBe(xIntentUrl("Short enough for X."));
    await act(async () => {
      fireEvent.click(link);
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("handoff-hint")).toBeNull();
    expect(screen.getByRole("button", { name: "I posted it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("X's Open draft link says opening it does not publish through Zavi", () => {
    const a = makeAction("text_post", {
      channel_slug: "x_organic",
      body: { step: { deliverable: { kind: "post", content: "Short enough for X." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: /^Open draft$/ });
    expect(document.getElementById(link.getAttribute("aria-describedby")!)?.textContent).toContain("opening it does not publish through Zavi");
  });

  it("LinkedIn keeps its share link and does not touch the clipboard", async () => {
    const a = makeAction("text_post", {
      channel_slug: "linkedin_organic",
      body: { step: { deliverable: { kind: "post", content: "A LinkedIn post." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("linkedin_organic")} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: "Open draft in browser account" });
    expect(link.getAttribute("href")).toBe(
      `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent("A LinkedIn post.")}`,
    );
    await act(async () => {
      fireEvent.click(link);
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("Reddit direct publishing", () => {
  const replyAction = () => makeAction("reply", {
    channel_slug: "reddit_organic",
    body: { link: THREAD, step: { deliverable: { kind: "comment", content: REPLY_TEXT } } } as ChannelActionBody,
  });
  it("sends edited text to the publisher without copying or opening Reddit", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    const h = handlers({ onPublish: publish });
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Shorter answer." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" })));
    expect(publish).toHaveBeenCalledWith(expect.anything(), { text: "Shorter answer.", thread: null });
    expect(h.onSetStatus).toHaveBeenCalledWith(expect.anything(), "acted", { keep: true });
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("offers no Copy, Open draft or Done in More actions on a connected Reddit card", () => {
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={handlers({ onPublish: vi.fn().mockResolvedValue(true) })} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryAllByRole("menuitem", { name: /Copy|Open draft|Done|Mark as posted/ })).toHaveLength(0);
  });
  it("offers Connect Reddit to post when disconnected, and the press connects instead of marking anything done", async () => {
    vi.mocked(startRailConnect).mockResolvedValue(undefined as never);
    const h = handlers();
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={h} />);
    const connect = screen.getByRole("button", { name: "Connect Reddit to post" });
    expect(connect.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: /^Post on/ })).toBeNull();
    expect(screen.queryByText("Connect Reddit in Settings → Integrations to post.")).toBeNull();
    await act(async () => fireEvent.click(connect));
    expect(startRailConnect).toHaveBeenCalledTimes(1);
    expect(startRailConnect).toHaveBeenCalledWith("reddit", "reddit_social");
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Post|Open draft/ })).toBeNull();
    expect(reddit.composerUrl).toBeUndefined();
  });
  it("says so when connecting Reddit cannot start, and still marks nothing done", async () => {
    vi.mocked(startRailConnect).mockRejectedValueOnce(new Error("blocked"));
    const h = handlers();
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={h} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect Reddit to post" })));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't start connecting Reddit. Try again from Settings.");
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });
  it("clears the connect failure on the next press", async () => {
    vi.mocked(startRailConnect).mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined as never);
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={handlers()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect Reddit to post" })));
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect Reddit to post" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("keeps Copy and Done for a disconnected founder who posts it by hand", async () => {
    const h = handlers();
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={h} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Copy/ })));
    expect(writeText).toHaveBeenCalledWith(REPLY_TEXT);
    expect(open).not.toHaveBeenCalled();
    expect(h.onSetStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Done/ })));
    expect(h.onSetStatus).toHaveBeenCalledWith(expect.anything(), "acted", { keep: true });
    expect(startRailConnect).not.toHaveBeenCalled();
  });
  it("keeps Copy enabled but refuses Post in a community that bans self-promotion", () => {
    const banned = makeAction("reply", {
      channel_slug: "reddit_organic",
      body: { link: THREAD, step: { deliverable: { kind: "comment", content: REPLY_TEXT, presentation: { type: "reddit_reply", thread_url: THREAD, rule_status: "not_allowed" } } } } as ChannelActionBody,
    });
    render(<ChannelActionCard action={banned} platform={reddit} handlers={handlers({ onPublish: vi.fn().mockResolvedValue(true) })} />);
    expect(screen.getByRole("status").textContent).toBe("This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.");
    expect(screen.getByRole("button", { name: "Post on Reddit" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect((screen.getByRole("menuitem", { name: /^Copy/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("leaves a non-Reddit direct-publish card on its Settings instruction", () => {
    const a = makeAction("text_post", { channel_slug: "x_organic", body: { step: { deliverable: { kind: "post", content: "Short enough for X." } } } });
    const h = handlers();
    render(<ChannelActionCard action={a} platform={{ ...platformFor("x_organic"), directPublishOnly: true }} handlers={h} />);
    expect(screen.queryByRole("button", { name: "Connect Reddit to post" })).toBeNull();
    expect(screen.getByRole("button", { name: "Post on X" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryAllByRole("menuitem", { name: /^(Copy|Done)/ })).toHaveLength(0);
    expect(startRailConnect).not.toHaveBeenCalled();
  });
  it("does not mark a queued or failed delivery as posted", async () => {
    const h = handlers({ onPublish: vi.fn().mockResolvedValue(false) });
    render(<ChannelActionCard action={replyAction()} platform={reddit} handlers={h} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" })));
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });
});

describe("a card that brings its own save", () => {
  const UUID = "55555555-5555-4555-8555-555555555555";
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ revision: "r1", content: null, editable: true }) });
  });
  const ownAction = () => makeAction("reply", {
    id: UUID,
    source: "channel_action",
    executable: false,
    channel_slug: "reddit_organic",
    body: { link: THREAD, step: { deliverable: { kind: "comment", content: REPLY_TEXT } } } as ChannelActionBody,
  });

  it("saves through onSave and never reads or writes the channel-action post draft", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ChannelSurface slug="reddit_organic"><PostCard action={ownAction()} icon={Reply} platform={reddit} handlers={handlers({ onPublish: vi.fn() })} onSave={onSave} /></ChannelSurface>);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit the reply" });
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Own save." } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(onSave).toHaveBeenCalledWith("Own save.");
    expect(apiFetch.mock.calls.filter(([path]) => String(path).includes("/post-draft"))).toEqual([]);
  });

  it("still uses the stored post draft for a card without its own save", async () => {
    render(<ChannelSurface slug="reddit_organic"><PostCard action={ownAction()} icon={Reply} platform={reddit} handlers={handlers({ onPublish: vi.fn() })} /></ChannelSurface>);
    await act(async () => { await Promise.resolve(); });
    expect(apiFetch.mock.calls.some(([path]) => String(path).includes(`/api/channel-actions/${UUID}/post-draft`))).toBe(true);
  });
});
