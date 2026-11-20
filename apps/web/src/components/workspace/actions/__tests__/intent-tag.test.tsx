// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { INTENT_TAG, cardTag } from "../registry";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });
const tag = () => screen.getByTestId("action-kind").textContent;

describe("cardTag", () => {
  it("maps every intent to plain words, and falls back when there is none", () => {
    expect(INTENT_TAG).toEqual({ fix_setup: "Fix setup", improve: "Improve results", create: "Create", reach_out: "Reach out", review: "Review", answer: "Question" });
    expect(cardTag({ body: { step: { intent: "reach_out" } } }, "Message")).toBe("Reach out");
    expect(cardTag({ body: {} }, "Message")).toBe("Message");
    expect(cardTag({ body: { step: { intent: "unknown_word" } } }, "Fix")).toBe("Fix");
  });
});

describe("the tag on the card", () => {
  it("an action card shows its intent's words, not the type's", () => {
    const a = makeAction("check", { body: { step: { body: "b", intent: "fix_setup" } } });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(tag()).toBe("Fix");
  });

  it("reads the server's top-level body.intent, with no step.intent on the row", () => {
    const a = makeAction("send_message", { body: { intent: "reach_out", step: { body: "b" } } });
    render(<ChannelActionCard action={a} handlers={handlers()} />);
    expect(tag()).toBe("Reach out");
    expect(cardTag({ body: { intent: "improve", step: { intent: "create" } } }, "Fix")).toBe("Improve results");
  });

  it("an action card with no intent keeps the type's word", () => {
    render(<ChannelActionCard action={makeAction("fix", { body: { step: { body: "b" } } })} handlers={handlers()} />);
    expect(tag()).toBe("Fix");
  });

  it("a post uses the intent too; Create only when the row has none", () => {
    const withIntent = { ...FIXTURES.text_post, body: { ...FIXTURES.text_post.body, step: { ...FIXTURES.text_post.body.step, intent: "review" } } };
    render(<ChannelActionCard action={withIntent} handlers={handlers()} />);
    expect(tag()).toBe("Review");
    cleanup();
    render(<ChannelActionCard action={FIXTURES.text_post} handlers={handlers()} />);
    expect(tag()).toBe("Create");
    cleanup();
    render(<ChannelActionCard action={FIXTURES.reply} handlers={handlers()} />);
    expect(tag()).toBe("Create");
  });

  it("the top line reads the tag, then Do this first, and flags New", () => {
    const a = makeAction("check", { blocking: true, body: { step: { body: "b", intent: "review" } } });
    render(<ChannelActionCard action={a} handlers={handlers()} isNew />);
    const line = screen.getByTestId("action-kind").parentElement as HTMLElement;
    const text = line.textContent ?? "";
    expect(within(line).getByText("Do this first")).toBeTruthy();
    expect(text.indexOf("Review")).toBeLessThan(text.indexOf("Do this first"));
    expect(text).toContain("New");
  });
});
