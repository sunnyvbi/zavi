// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

afterEach(cleanup);

const seo = platformFor("seo");
const handlers = () => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() }) satisfies ActionHandlers;
const prCard = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("fix", {
    channel_slug: "seo",
    title: "Give /pricing its own title",
    executable: true,
    card_kind: "executes",
    primary_label: "Open pull request",
    done_label: "Done",
    how_to: [],
    ...over,
  });

describe("the SEO pull request card", () => {
  it("while the engineer works it says so", () => {
    render(<ChannelActionCard action={prCard({ exec_status: "dispatching" })} platform={seo} handlers={handlers()} />);
    expect(screen.getByTestId("exec-state").textContent).toContain("Zavi's engineer is opening the pull request");
  });

  it("while the PR is held for an approval it says so, with no spinner", () => {
    render(<ChannelActionCard action={prCard({ exec_status: "dispatching", exec_waiting: "approvals" })} platform={seo} handlers={handlers()} />);
    const state = screen.getByTestId("exec-state");
    expect(state.getAttribute("data-exec")).toBe("waiting");
    expect(state.textContent).toContain("waiting for your approval lower on this page");
  });

  it("an outcome-unknown failure never says nothing changed", () => {
    render(
      <ChannelActionCard
        action={prCard({ exec_status: "failed", exec_code: "exec_outcome_unknown", exec_bucket: "partial_risk", note: "The pull request is still waiting in Approvals." })}
        platform={seo}
        handlers={handlers()}
      />,
    );
    const text = screen.getByTestId("exec-state").textContent ?? "";
    expect(text).toContain("Zavi will not open another pull request from this card.");
    expect(text).not.toContain("No pull request was opened.");
    expect(text).not.toContain("Nothing in your repository changed");
  });
});

describe("a held engineer PR on the channel page", () => {
  it("is drawn live (with its verbs), never in the read-only Older fold", async () => {
    const { chatStagedItemsOf, priorItemsOf } = await import("../../layout/ChannelsPanel");
    const held = { id: "d-site", action_source: "decision" as const, thread_id: null, decision_class: "engineer.ship-pr" };
    const sweep = { id: "d-old", action_source: "decision" as const, thread_id: null, decision_class: "channel.recipe_step" };
    expect(chatStagedItemsOf([held, sweep] as never[]).map((d: { id: string }) => d.id)).toEqual(["d-site"]);
    expect(priorItemsOf([held, sweep] as never[]).map((d: { id: string }) => d.id)).toEqual(["d-old"]);
  });
});
