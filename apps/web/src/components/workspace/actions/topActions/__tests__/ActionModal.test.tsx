// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionModal } from "../ActionModal";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

describe("ActionModal", () => {
  it("draws one divider when its body is empty", () => {
    render(
      <ActionModal eyebrow="Pinterest" title="Empty" sub="" onClose={() => {}} footer={<button type="button">Go</button>}>
        {null}
      </ActionModal>,
    );
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector("[data-testid=action-modal-body]")).toBeNull();
    const header = within(dialog).getByRole("heading", { name: "Empty" }).parentElement!;
    expect(header.className).not.toContain("border-b");
  });

  it("lets the footer wrap on a phone so the primary button never leaves the screen", () => {
    render(
      <ActionModal
        eyebrow="Pinterest"
        title="Create a pin"
        sub=""
        onClose={() => {}}
        footer={
          <>
            <button type="button">Cancel</button>
            <button type="button">Send for approval</button>
            <button type="button">Post</button>
          </>
        }
      >
        <p>Body</p>
      </ActionModal>,
    );
    const footer = screen.getByTestId("action-modal-footer");
    const row = footer.className.split(" ");
    expect(row).toContain("flex-col");
    expect(row).toContain("sm:flex-row");
    const buttons = screen.getByRole("button", { name: "Post" }).parentElement!;
    expect(buttons).toBe(screen.getByTestId("action-modal-buttons"));
    const group = buttons.className.split(" ");
    expect(group).toContain("flex-wrap");
    expect(group).toContain("w-full");
    expect(group).toContain("sm:w-auto");
  });

  it("renders a supplied body", () => {
    render(
      <ActionModal eyebrow="Pinterest" title="Create a pin" sub="" onClose={() => {}} footer={<button type="button">Go</button>}>
        <label>Title<input /></label>
      </ActionModal>,
    );
    expect(screen.getByTestId("action-modal-body")).toBeTruthy();
    expect(screen.getByText("Title")).toBeTruthy();
  });

  it("draws the close button as an icon, not a text cross, and the button still closes the modal", () => {
    const onClose = vi.fn();
    render(
      <ActionModal eyebrow="Email" title="New campaign" sub="" onClose={onClose} footer={<button type="button">Go</button>}>
        <p>Body</p>
      </ActionModal>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    const icons = close.querySelectorAll("svg");
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("aria-hidden")).toBe("true");
    expect(close.textContent).toBe("");
    expect(close.textContent).not.toContain("\u00d7");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button does nothing while the modal is busy", () => {
    const onClose = vi.fn();
    render(
      <ActionModal eyebrow="Email" title="New campaign" sub="" busy onClose={onClose} footer={<button type="button">Go</button>}>
        <p>Body</p>
      </ActionModal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
  });
  it("hideClose removes the X and, with no footer, draws no footer bar", () => {
    render(
      <ActionModal eyebrow="Email" title="Connect" sub="" hideClose onClose={() => {}}>
        <p>Body</p>
      </ActionModal>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByTestId("action-modal-footer")).toBeNull();
  });

  it("hideClose modal still closes on Escape but not while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ActionModal eyebrow="Email" title="Connect" sub="" hideClose onClose={onClose}>
        <p>Body</p>
      </ActionModal>,
    );
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <ActionModal eyebrow="Email" title="Connect" sub="" hideClose busy onClose={onClose}>
        <p>Body</p>
      </ActionModal>,
    );
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("other callers keep their X and footer by default", () => {
    render(
      <ActionModal eyebrow="Email" title="New campaign" sub="" onClose={() => {}} footer={<button type="button">Go</button>}>
        <p>Body</p>
      </ActionModal>,
    );
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getByTestId("action-modal-footer")).toBeTruthy();
  });
});
