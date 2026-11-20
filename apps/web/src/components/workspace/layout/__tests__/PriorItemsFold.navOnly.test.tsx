// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PriorItemsFold } from "../../actions/ChannelActionsLane";

afterEach(cleanup);

function byText(root: HTMLElement, label: string) {
  const hit = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!hit) throw new Error(`no button labelled ${label}`);
  return hit;
}

describe("the read-only fold guards verbs without deadening the run card's doors", () => {
  it("presses a nav-only row's control and leaves a verb row unpressable", () => {
    const openAll = vi.fn();
    const approve = vi.fn();

    const { container } = render(
      <PriorItemsFold count={2}>
        <li data-nav-only="">
          <button type="button" onClick={openAll}>
            Open all
          </button>
        </li>
        <li>
          <button type="button" onClick={approve}>
            Approve
          </button>
        </li>
      </PriorItemsFold>,
    );

    const door = byText(container, "Open all");
    expect(door.closest("fieldset[disabled]")).toBeNull();
    fireEvent.click(door);
    expect(openAll).toHaveBeenCalledTimes(1);

    const verb = byText(container, "Approve");
    const guard = verb.closest("fieldset");
    expect(guard).toBeTruthy();
    expect(guard?.hasAttribute("disabled")).toBe(true);
  });

  it("still renders nothing when the channel has no rows on the approvals list", () => {
    const { container } = render(
      <PriorItemsFold count={0}>
        <li data-nav-only="">
          <button type="button">Open all</button>
        </li>
      </PriorItemsFold>,
    );
    expect(container.querySelector("details")).toBeNull();
  });

  it("keeps every verb guarded when no row declares itself nav-only", () => {
    const { container } = render(
      <PriorItemsFold count={1}>
        <li>
          <button type="button">Approve</button>
        </li>
        <li>
          <button type="button">Reject</button>
        </li>
      </PriorItemsFold>,
    );

    for (const label of ["Approve", "Reject"]) {
      const guard = byText(container, label).closest("fieldset");
      expect(guard?.hasAttribute("disabled")).toBe(true);
    }
  });
});
