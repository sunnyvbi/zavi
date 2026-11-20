// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ActionHandlers } from "../types";

const { apiFetch, approveDecision } = vi.hoisted(() => ({ apiFetch: vi.fn(), approveDecision: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision }));

const { ChannelActionCard } = await import("../ChannelActionCard");
const { platformFor } = await import("./index");
const { makeAction } = await import("../__tests__/fixtures");
await import("../../agent/xStagedPosts");

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  approveDecision.mockReset();
});

const platform = platformFor("x_organic");
const handlers = (over: Partial<ActionHandlers> = {}) =>
  ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn(), ...over }) satisfies ActionHandlers;

const POST = "Before you book a P2P rental car, check these three things.";
const REPLY = "Turo is not passive income, and here is the maths.";
const postAction = () =>
  makeAction("text_post", { channel_slug: "x_organic", body: { step: { deliverable: { kind: "post", content: POST } } } });
const replyAction = () =>
  makeAction("reply", { channel_slug: "x_organic", body: { step: { deliverable: { kind: "comment", content: REPLY } } } });

describe("x_organic — one draft, two homes", () => {
  it("not connected: Open draft is the only route, and it is a plain link to X", () => {
    render(<ChannelActionCard action={postAction()} platform={platform} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: /^Open draft$/ });
    expect(link.getAttribute("href")).toBe(`https://x.com/intent/tweet?text=${encodeURIComponent(POST)}`);
    expect(screen.queryByRole("button", { name: /^Post on / })).toBeNull();
  });

  it("connected: BOTH — a Post that publishes, and Open draft in the ··· menu", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ChannelActionCard
        action={postAction()}
        platform={platform}
        handlers={handlers({ onPublish: vi.fn(async () => true) })}
      />,
    );
    expect(screen.getByRole("button", { name: /^Post on / })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Open draft/ }));
    expect(open).toHaveBeenCalledWith(`https://x.com/intent/tweet?text=${encodeURIComponent(POST)}`, "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
});

describe("x_organic — a reply is never posted as an update", () => {
  it("offers neither button, connected or not", () => {
    for (const h of [handlers(), handlers({ onPublish: vi.fn(async () => true) })]) {
      cleanup();
      render(<ChannelActionCard action={replyAction()} platform={platform} handlers={h} />);
      expect(screen.queryByRole("link", { name: /^Open draft$/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Post on / })).toBeNull();
      expect(screen.getByTestId("post-text").textContent).toBe(REPLY);
    }
  });

  it("a post on the same row still gets that link", () => {
    expect(platform?.composerUrl?.(POST, postAction())).toContain("intent/tweet");
    expect(platform?.composerUrl?.(REPLY, replyAction())).toBeNull();
  });
});
