// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("editing a split thread", () => {
  it("exposes a textarea per tail part and Copy sends the edited parts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const a = makeAction("text_post", {
      body: { step: { deliverable: { kind: "thread", content: "Intro.\n---\nPlans cost $20/month.\n---\nLink in bio." } } },
    } as never);
    render(
      <ChannelActionCard
        action={a}
        platform={platformFor("x_organic")}
        handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    const part2 = screen.getByLabelText("Edit part 2") as HTMLTextAreaElement;
    expect(part2.value).toBe("Plans cost $20/month.");
    expect(screen.getByLabelText("Edit part 3")).toBeTruthy();
    fireEvent.change(part2, { target: { value: "Plans cost $24/month." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy/ }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("Intro.\n\nPlans cost $24/month.\n\nLink in bio.");
  });
});
