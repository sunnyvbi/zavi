// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ActionTooltip } from "../ActionTooltip";
import { actionHint } from "../actionHints";
import { actionFooterParts } from "../AdFooter";
import { PostFooter } from "../PostFooter";
import { PopMenu } from "../PopMenu";
import { makeAction } from "./fixtures";
import { getCreatorVideoCard } from "../../ugc/creatorCards";
import { creatorActionHint } from "../../ugc/creatorActionHints";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function description(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

describe("action explanations are safe to inspect", () => {
  it("supports hover, keyboard, Escape and screen readers without activating the action", () => {
    const run = vi.fn();
    render(
      <ActionTooltip
        description="Open a brief; no payment is made."
        label="Approve"
      >
        <button onClick={run}>Approve</button>
      </ActionTooltip>,
    );
    const button = screen.getByRole("button", { name: "Approve" });
    expect(description(button)).toContain("no payment");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip").textContent).toContain("Open a brief");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("lets touch users inspect a menu option without selecting it", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: true,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const run = vi.fn();
    render(
      <PopMenu
        description="More options for this card"
        items={[
          {
            label: "Reject",
            tooltip: "Hide only in this browser",
            onSelect: run,
          },
        ]}
        trigger={() => "More"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "About Reject" }));
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Hide only in this browser",
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reject" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("explains disabled actions by keyboard and keeps their handlers disabled", () => {
    const run = vi.fn();
    render(
      <ActionTooltip
        description="Fill the missing fields first."
        label="Create"
      >
        <button disabled onClick={run}>
          Create
        </button>
      </ActionTooltip>,
    );
    const help = screen.getByRole("group", { name: "About Create" });
    expect(help.tabIndex).toBe(0);
    fireEvent.focus(help);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Fill the missing fields first.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("allows the pointer to enter the tooltip, clamps to the viewport and closes outside", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "tooltip"
          ? new DOMRect(0, 0, 300, 100)
          : new DOMRect(0, 0, 50, 32);
      },
    );
    render(
      <ActionTooltip description="A longer explanation" label="Open">
        <button>Open</button>
      </ActionTooltip>,
    );
    const button = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    const tip = screen.getByRole("tooltip");
    expect(tip.style.left).toBe("8px");
    expect(tip.style.top).toBe("40px");
    fireEvent.pointerLeave(button);
    fireEvent.mouseEnter(tip);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("explanations follow the operation and current card", () => {
  const handlers = () => ({
    onSetStatus: vi.fn(),
    onRedo: vi.fn(),
    onApprove: vi.fn(),
    onOpenChat: vi.fn(),
  });

  it("distinguishes approval that executes a change from opening campaign review", () => {
    const a = makeAction("other", {
      channel_slug: "chatgpt_ads",
      title: "Upcar renters",
      executable: true,
      body: { change_sentence: "Raise the daily budget to $25." },
    });
    const h = handlers();
    const footer = () =>
      actionFooterParts({
        a,
        handlers: h,
        link: null,
        platformName: "ChatGPT Ads",
        approveLabel: "Approve",
      }).footer;
    const view = render(<>{footer()}</>);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(description(approve)).toContain("ChatGPT Ads · “Upcar renters”");
    expect(description(approve)).toContain("execute this card's exact change");
    expect(description(approve)).toContain("$25");
    fireEvent.click(approve);
    expect(h.onApprove).toHaveBeenCalledWith(a);
    const review = vi.fn();
    view.rerender(
      <>
        {
          actionFooterParts({
            a: { ...a, executable: false },
            handlers: { ...h, onReviewExecute: review },
            link: null,
            platformName: "ChatGPT Ads",
            approveLabel: "Approve",
          }).footer
        }
      </>,
    );
    const open = screen.getByRole("button", { name: "Review and create" });
    expect(description(open)).toContain(
      "does not create a campaign or spend money",
    );
    fireEvent.click(open);
    expect(review).toHaveBeenCalledOnce();
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it("updates a copy action to completion help after handoff and explains actual publishing separately", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const a = makeAction("text_post", {
      card_kind: "copy_to_site",
      primary_label: "Copy",
      done_label: "I posted it",
    });
    const h = handlers();
    const props = {
      a,
      handlers: h,
      text: "A draft",
      thread: null,
      editing: false,
      onToggleEdit: vi.fn(),
      platformName: "X",
      composerHref: null,
      blockedReason: null,
    };
    const view = render(<PostFooter {...props} />);
    expect(description(screen.getByRole("button", { name: "Copy" }))).toContain(
      "clipboard",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      description(screen.getByRole("button", { name: "I posted it" })),
    ).toContain("does not perform the suggested work");
    expect(h.onSetStatus).not.toHaveBeenCalled();
    view.rerender(
      <PostFooter
        {...props}
        a={{ ...a, card_kind: "post" }}
        handlers={{ ...h, onPublish: vi.fn() }}
        directPublishOnly
      />,
    );
    expect(description(screen.getByRole("button", { name: "Post" }))).toContain(
      "may go live immediately",
    );
  });

  it("explains the Instagram creator brief using its actual placement and budget", () => {
    const card = getCreatorVideoCard("instagram_organic", {
      creator: "Meri",
      price_cents: 25000,
    });
    const approve = creatorActionHint(
      "instagram_organic",
      card,
      card.primary.target,
    );
    expect(approve).toContain("Instagram");
    expect(approve).toContain("prefilled UGC brief");
    expect(approve).toContain("$250 per video");
    expect(approve).toContain("Budget estimate");
    expect(approve).toContain("10% fee");
    expect(approve).toContain("Your Instagram Reels");
    expect(approve).toContain(
      "does not hire a creator, charge you, or publish a video",
    );
    const reject = creatorActionHint("instagram_organic", card, {
      kind: "hide",
    });
    expect(reject).toContain("in this browser only");
    expect(reject).toContain("for 14 days");
    expect(reject).toContain("does not send feedback");
    expect(
      creatorActionHint("instagram_organic", card, {
        kind: "drawer",
        name: "review",
      }),
    ).toContain("does not accept the delivery or release payment");
  });

  it("uses a safe readable fallback for new channels and never interprets the title as an operation", () => {
    const hint = actionHint(
      { title: "Publish and charge $100", channel_slug: "new_channel" },
      "copy",
    );
    expect(hint).toContain("new channel");
    expect(hint).toContain("copying does not publish or send it");
  });
});
