// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
import type { ActionHandlers } from "../types";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

function reachable(id: string): string {
  const card = screen.getByTestId(`action-${id}`);
  fireEvent.click(within(card).getByRole("button", { name: "What it is" }));
  return `${card.textContent} ${screen.getByRole("dialog").textContent}`;
}

const SENTENCES = [
  "Mobile signups fell 38% week over week while desktop held flat.",
  "The drop is concentrated in Austin and Dallas, which together carry 61% of paid spend.",
  "The signup_form_v2 experiment shipped on the 12th and only targets mobile.",
  "Open the funnel report and compare the two cities before changing any budget.",
];
const BODY = SENTENCES.join(" ");

const TASK_TYPES = ["check", "fix", "setup", "page", "other", "send_message"] as const;

describe("a multi-sentence task body", () => {
  it.each(TASK_TYPES)("%s: every sentence is reachable on the card", (t) => {
    const a = makeAction(t, { channel_slug: "seo", title: `A ${t} with a long body`, body: { step: { body: BODY, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);

    const shown = reachable(a.id);
    for (const s of SENTENCES) expect(shown, `lost: ${s}`).toContain(s);
  });

  it("names the experiment that isRaw would otherwise delete", () => {
    const a = makeAction("check", { channel_slug: "seo", title: "Check the drop", body: { step: { body: BODY, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    expect(reachable(a.id)).toContain("signup_form_v2");
  });

  it("a task whose run wrote its own steps keeps every sentence and every body list line", () => {
    const list = ["Austin landing page.", "Dallas landing page."];
    const a = makeAction("check", {
      channel_slug: "seo",
      title: "Check the two city pages",
      body: { step: { body: `${BODY}\n\n- ${list[0]}\n- ${list[1]}`, effort: "hours", how_to: ["Open the funnel report.", "Compare the two cities."] } },
      card_kind: "task",
      primary_label: "Check it",
      done_label: "Done",
      how_to: ["Open the funnel report.", "Compare the two cities."],
    });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(screen.getByTestId("about-steps").textContent).toContain("Compare the two cities.");
    const shown = reachable(a.id);
    for (const s of [...SENTENCES, ...list]) expect(shown, `lost: ${s}`).toContain(s);
  });

  it("offers no Show More when the body IS the lead", () => {
    const one = "Mobile signups fell 38% week over week while desktop held flat.";
    const a = makeAction("check", { channel_slug: "seo", title: "Short", body: { step: { body: one, effort: "hours" } } });
    render(<ChannelActionCard action={a} platform={platformFor("seo")} handlers={handlers()} />);
    expect(screen.getByTestId(`action-${a.id}`).textContent).toContain(one);
    expect(screen.queryByRole("button", { name: /Show (more|less)/i })).toBeNull();
  });
});
