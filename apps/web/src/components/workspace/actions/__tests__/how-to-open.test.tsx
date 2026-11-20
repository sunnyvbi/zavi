// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

const setSteps = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/channelActionsApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace/channelActionsApi")>("@/lib/workspace/channelActionsApi");
  return { ...actual, setChannelActionSteps: setSteps };
});

afterEach(cleanup);
beforeEach(() => setSteps.mockReset().mockResolvedValue({ ok: true, steps_done: [] }));

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const toggleOf = () => screen.getByRole("button", { name: "How it works" });

describe("How it works", () => {
  it("is collapsed by default on a post, opens on the caption, each step numbered", () => {
    const a = { ...FIXTURES.text_post, card_kind: "post" as const, primary_label: "Post it", done_label: "I posted it", how_to: ["Open the app.", "Paste the post."] };
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(toggleOf().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Paste the post.")).toBeNull();
    fireEvent.click(toggleOf());
    expect(toggleOf().getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByText("Paste the post.").closest("ol") as HTMLElement;
    expect(list.className).toContain("list-decimal");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Open the app.", "Paste the post."]);
    expect(list.textContent).not.toMatch(/(^|\s)1\.\s/);
  });

  it("is collapsed by default on an action card, steps readable once opened", () => {
    const a = makeAction("fix", { body: { step: { body: "Why.", deliverable: { kind: "copy", label: "Use this", content: "New text." } } }, card_kind: "copy_to_site", primary_label: "Copy text", done_label: "I updated the page", how_to: ["Press Copy text.", "Paste it."] });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(toggleOf().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Paste it.")).toBeNull();
    fireEvent.click(toggleOf());
    const list = screen.getByText("Paste it.").closest("ol") as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("the opened steps", () => {
  const open = (a: Parameters<typeof ChannelActionCard>[0]["action"]) => {
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    fireEvent.click(toggleOf());
  };

  it("are an ol of li rows inside one soft inset box, in order, with no Step N label", () => {
    open({ ...FIXTURES.text_post, card_kind: "post" as const, primary_label: "Post it", done_label: "I posted it", how_to: ["Open the app.", "Paste the post.", "Press Post."] });
    const list = screen.getByText("Press Post.").closest("ol") as HTMLElement;
    expect(list.className).toContain("rounded-xl");
    expect(list.className).toContain("bg-ca-subtle");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.parentElement)).toEqual([list, list, list]);
    expect(items.map((li) => li.textContent)).toEqual(["Open the app.", "Paste the post.", "Press Post."]);
    expect(list.textContent).not.toMatch(/step\s*\d/i);
  });

  it("on a task keep a working tick beside each numbered step, struck through once ticked", () => {
    open(
      makeAction("check", { channel_slug: "made_up_site", body: { step: { title: "Sitemap", body: "Stale." } }, card_kind: "task", primary_label: "Check it", done_label: "Done", how_to: ["Open the site settings.", "Resubmit the sitemap."], steps_done: [] }),
    );
    const how = screen.getByTestId("how-to");
    const items = within(how).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByTestId("how-to-badge").textContent)).toEqual(["1", "2"]);
    expect(how.textContent).not.toMatch(/step\s*\d/i);
    const second = within(items[1]).getByRole("checkbox", { name: "Step 2: Resubmit the sitemap." });
    fireEvent.click(second);
    expect((second as HTMLInputElement).checked).toBe(true);
    expect(setSteps).toHaveBeenCalledWith(expect.anything(), [1]);
    expect(within(items[1]).getByText("Resubmit the sitemap.").className).toContain("line-through");
    expect(within(items[0]).getByText("Open the site settings.").className).not.toContain("line-through");
  });
});

describe("a task whose run wrote its own steps", () => {
  const task = () =>
    makeAction("check", {
      channel_slug: "made_up_site",
      body: { step: { title: "Sitemap", body: "The sitemap is stale.\n\n- Home page.\n- Pricing page.", how_to: ["Open the site settings.", "Resubmit the sitemap."] } },
      card_kind: "task",
      primary_label: "Check it",
      done_label: "Done",
      how_to: ["Open the site settings.", "Resubmit the sitemap."],
      steps_done: [],
    });

  it("shows the model's steps inside How it works, as the tick list", () => {
    render(<ChannelActionCard action={task()} handlers={handlers()} />);
    fireEvent.click(toggleOf());
    const how = screen.getByTestId("how-to");
    expect(how.textContent).toContain("Resubmit the sitemap.");
    expect(within(how).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getAllByTestId("how-to")).toHaveLength(1);
    expect(screen.queryByTestId("action-steps")).toBeNull();
  });

  it.each(["seo", "linkedin_ads"])("on %s How it works is three short lines with nothing to tick, and the run's own steps sit in What it is", (channel_slug) => {
    render(<ChannelActionCard action={{ ...task(), channel_slug }} handlers={handlers()} />);
    fireEvent.click(toggleOf());
    const list = screen.getByText("Read it.").closest("ol") as HTMLElement;
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Read it.", "Press Check it.", "Zavi reports what happened here."]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("how-to")).toBeNull();
    expect(screen.queryByText("Resubmit the sitemap.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect([...screen.getByTestId("about-steps").querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Open the site settings.", "Resubmit the sitemap."]);
  });

  it("shows the body's own list without Show more", () => {
    const a = task();
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    const card = screen.getByTestId(`action-${a.id}`);
    expect(card.textContent).toContain("Home page.");
    expect(card.textContent).toContain("Pricing page.");
  });
});
