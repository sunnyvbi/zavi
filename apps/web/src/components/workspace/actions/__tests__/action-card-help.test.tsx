// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionCardLayout } from "../ActionCardLayout";
import { ActionTooltip } from "../ActionTooltip";
import { PopMenu } from "../PopMenu";
import { makeAction } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const touch = (matches: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );

function card() {
  const publish = vi.fn();
  render(
    <ActionCardLayout
      item={makeAction("text_post")}
      main={<p>Body</p>}
      footer={
        <>
          <ActionTooltip description="Publishes the post now." label="Publish">
            <button onClick={publish}>Publish</button>
          </ActionTooltip>
          <ActionTooltip description="Opens the channel chat." label="Ask Zavi">
            <button>Ask Zavi</button>
          </ActionTooltip>
          <PopMenu
            description="Opens the other options."
            label="More actions"
            items={[{ label: "Reject", tooltip: "Hides this card.", onSelect: vi.fn() }]}
            trigger={() => "More"}
          />
        </>
      }
    />,
  );
  return publish;
}

describe("action card help on touch", () => {
  it("shows one help control per card that lists every button", () => {
    touch(true);
    const publish = card();
    expect(screen.queryByRole("button", { name: /^About / })).toBeNull();
    const toggle = screen.getByRole("button", { name: "What these buttons do" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Publish · Publishes the post now.",
      "Ask Zavi · Opens the channel chat.",
      "More actions · Opens the other options.",
    ]);
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "About Reject" })).toBeTruthy();
  });

  it("adds nothing on a pointer device", () => {
    touch(false);
    card();
    expect(screen.queryByRole("button", { name: "What these buttons do" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^About / })).toBeNull();
  });
});
