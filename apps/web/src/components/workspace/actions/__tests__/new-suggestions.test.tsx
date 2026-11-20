// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChannelActionSection } from "../ChannelActionSection";
import { platformFor } from "../platforms";
import type { ActionHandlers, ActionItem } from "../types";
import { base } from "../../agent/cardViews";

afterEach(cleanup);

const handlers = { onApprove: async () => true, onReject: async () => true, onSnooze: async () => true, onDone: async () => true, onRedo: async () => true } as unknown as ActionHandlers;
const card = (id: string): ActionItem => ({ ...base(id, "meta_ads", "send_message", `Card ${id}`, ""), body: {} });
const sections = () => Array.from(document.querySelectorAll("[data-ad-section]")).map((el) => `${el.getAttribute("data-ad-section")}:${["old", "fresh", "a", "b"].filter((id) => el.querySelector(`[data-testid="action-${id}"]`)).length}`);
const section = (actions: ActionItem[], cooking: boolean) => (
  <ChannelActionSection actions={actions} platform={platformFor("meta_ads")} handlers={handlers} emptyGroups empty={<p>caught up</p>} cooking={cooking ? <p>cooking</p> : undefined} />
);

describe("cards that land during a run", () => {
  it("shows the empty card over both empty groups, then the cooking card in its place", () => {
    const view = render(section([], false));
    expect(screen.getByText("caught up")).toBeTruthy();
    expect(sections()).toEqual(["fix:0", "ready:0"]);
    expect(screen.getByText("Nothing to fix right now.")).toBeTruthy();
    expect(screen.getByText("Nothing ready right now.")).toBeTruthy();
    view.rerender(section([], true));
    expect(screen.queryByText("caught up")).toBeNull();
    expect(screen.getByText("cooking")).toBeTruthy();
    expect(sections()).toEqual(["fix:0", "ready:0"]);
  });

  it("puts cards filed by the run under New suggestions and leaves the earlier ones where they were", () => {
    const view = render(section([card("old")], false));
    expect(sections()).toEqual(["ready:1"]);
    view.rerender(section([card("old")], true));
    expect(screen.getByText("cooking")).toBeTruthy();
    view.rerender(section([card("old"), card("fresh")], true));
    expect(sections()).toEqual(["new:1", "ready:1"]);
    view.rerender(section([card("old"), card("fresh")], false));
    expect(screen.queryByText("cooking")).toBeNull();
    expect(sections()).toEqual(["new:1", "ready:1"]);
    expect(screen.getByRole("heading", { name: "New suggestions" })).toBeTruthy();
  });

  it("keeps them under New suggestions when the cooking card flickers back for the same run", () => {
    const view = render(section([], true));
    view.rerender(section([card("fresh")], true));
    view.rerender(section([card("fresh")], false));
    view.rerender(section([card("fresh")], true));
    view.rerender(section([card("fresh")], false));
    expect(sections()).toEqual(["new:1"]);
  });

  it("calls nothing new on a page that loaded with its cards", () => {
    render(section([card("a"), card("b")], false));
    expect(sections()).toEqual(["ready:2"]);
  });
});
