// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../../ChannelActionCard";
import { platformFor } from "../../platforms";
import type { ActionHandlers } from "../../types";
import { makeAction } from "../../__tests__/fixtures";

vi.mock("../../managed-campaigns/ChannelBalance", () => ({ ChannelBalance: () => <div /> }));

let writeText: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  open = vi.fn();
  vi.stubGlobal("open", open);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function handlers(over: Partial<ActionHandlers> = {}) {
  return { onSetStatus: vi.fn().mockResolvedValue(true), onRedo: vi.fn(), onApprove: vi.fn().mockResolvedValue(true), onOpenChat: vi.fn(), ...over } satisfies ActionHandlers;
}

const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("the main button on a card Zavi carries out", () => {
  it.each([
    ["create_ad", "Create ad"],
    ["update_ad", "Adjust budget"],
    ["pause_ad", "Pause"],
  ] as const)("%s runs on one press and copies nothing", async (type, label) => {
    const h = handlers();
    const a = makeAction(type, { channel_slug: "meta_ads", executable: true, card_kind: "executes", primary_label: label, done_label: "Done", body: { action_label: label } });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={h} />);
    await press(screen.getByRole("button", { name: label }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it.each([
    ["create_ad", "Create ad"],
    ["update_ad", "Apply change"],
    ["pause_ad", "Pause"],
  ] as const)("%s with no served words is named by its type and still runs", async (type, label) => {
    const h = handlers();
    const a = makeAction(type, { channel_slug: "google_ads", executable: true });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={h} />);
    await press(screen.getByRole("button", { name: label }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it("a failed change offers Try again and runs it", async () => {
    const h = handlers();
    const a = makeAction("update_ad", { channel_slug: "meta_ads", executable: true, exec_status: "failed", card_kind: "executes", primary_label: "Apply change", done_label: "Done" });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={h} />);
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it("a post on a connected account posts on one press", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const onSetStatus = vi.fn().mockResolvedValue(true);
    const h = handlers({ onPublish, onSetStatus });
    const a = makeAction("text_post", { channel_slug: "x_organic", card_kind: "post", primary_label: "Post on X", done_label: "Posted", body: { step: { deliverable: { kind: "post", content: "Hello there." } } } });
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={h} />);
    await press(screen.getByRole("button", { name: "Post on X" }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onSetStatus.mock.calls.map((c) => c[1])).toEqual(["acted"]);
    expect(writeText).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the main button on a card the founder carries out", () => {
  it("copies, then offers only the done words", async () => {
    const h = handlers();
    const a = makeAction("create_ad", { channel_slug: "meta_ads", card_kind: "ad_manual", primary_label: "Copy ad", done_label: "I created it", body: { step: { deliverable: { kind: "ad", content: "Headline: A" } } } });
    render(<ChannelActionCard action={a} platform={platformFor("meta_ads")} handlers={h} />);
    await press(screen.getByRole("button", { name: "Copy ad" }));
    expect(writeText).toHaveBeenCalledWith("Headline: A");
    expect(h.onApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await press(screen.getByRole("button", { name: "I created it" }));
    expect(h.onSetStatus).toHaveBeenCalledWith(a, "acted", expect.anything());
  });

  it("a hand-off link with no served words is named by its type", () => {
    const a = makeAction("update_ad", { channel_slug: "google_ads", body: { link: "https://ads.google.com/aw/campaigns" } });
    render(<ChannelActionCard action={a} platform={platformFor("google_ads")} handlers={handlers()} />);
    expect(screen.getByRole("link", { name: "Apply change" }).getAttribute("href")).toBe("https://ads.google.com/aw/campaigns");
    expect(screen.queryByRole("link", { name: "Review it" })).toBeNull();
  });
});
