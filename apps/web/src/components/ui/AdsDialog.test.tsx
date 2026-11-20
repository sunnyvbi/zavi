// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdsDialog } from "./AdsDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); });

it("uses the reference history width and removes the width cap on small screens", () => {
  render(<AdsDialog label="History details" size="history" onClose={() => {}}><p>Saved action</p></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "History details" });
  expect(dialog.className).toContain("w-history-dialog");
  expect(dialog.className).toContain("max-w-history-dialog");
  expect(dialog.className).toContain("compact:w-full");
  expect(dialog.className).toContain("compact:max-w-none");
});

const box = { left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON() {} } as DOMRect;
const cancel = (el: Element) => fireEvent(el, new Event("cancel", { cancelable: true }));

it("opens as a modal, and Escape (native cancel) closes it once without letting the browser close it", () => {
  const onClose = vi.fn();
  render(<AdsDialog label="Edit budget" onClose={onClose}><button>Inside</button></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Edit budget" });
  expect(dialog.hasAttribute("open")).toBe(true);
  const e = new Event("cancel", { cancelable: true });
  fireEvent(dialog, e);
  expect(e.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("gives Escape to onEscape first, and refuses it while busy", () => {
  const onClose = vi.fn();
  let layered = true;
  const onEscape = () => { if (!layered) return false; layered = false; return true; };
  const { rerender } = render(<AdsDialog label="Details" onClose={onClose} onEscape={onEscape}><p>x</p></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Details" });
  cancel(dialog);
  expect(onClose).not.toHaveBeenCalled();
  cancel(dialog);
  expect(onClose).toHaveBeenCalledTimes(1);
  rerender(<AdsDialog label="Details" onClose={onClose} busy><p>x</p></AdsDialog>);
  cancel(dialog);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("ignores a queued close while it is open again, and a nested dialog's events", () => {
  const onClose = vi.fn();
  render(<AdsDialog label="Outer" onClose={onClose}><AdsDialog label="Inner" onClose={() => {}}><p>x</p></AdsDialog></AdsDialog>);
  const outer = screen.getByRole("dialog", { name: "Outer" });
  fireEvent(outer, new Event("close"));
  cancel(screen.getByRole("dialog", { name: "Inner" }));
  expect(onClose).not.toHaveBeenCalled();
  outer.removeAttribute("open");
  fireEvent(outer, new Event("close"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes on a mousedown outside its box only, never on its own padding or content", () => {
  const onClose = vi.fn();
  render(<AdsDialog label="Edit budget" onClose={onClose} closeOnBackdrop><button>Inside</button></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Edit budget" });
  dialog.getBoundingClientRect = () => box;
  fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }), { clientX: 10, clientY: 10 });
  fireEvent.mouseDown(dialog, { clientX: 101, clientY: 399 });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(dialog, { clientX: 50, clientY: 50 });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("refuses a backdrop close while busy", () => {
  const onClose = vi.fn();
  const { rerender } = render(<AdsDialog label="Busy" onClose={onClose} closeOnBackdrop busy><p>x</p></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Busy" });
  dialog.getBoundingClientRect = () => box;
  fireEvent.mouseDown(dialog, { clientX: 50, clientY: 50 });
  expect(onClose).not.toHaveBeenCalled();
  rerender(<AdsDialog label="Busy" onClose={onClose} closeOnBackdrop><p>x</p></AdsDialog>);
  fireEvent.mouseDown(dialog, { clientX: 50, clientY: 50 });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps Escape keydown away from document listeners such as the channel drawer", () => {
  const drawer = vi.fn();
  document.addEventListener("keydown", drawer);
  try {
    render(<AdsDialog label="Edit" onClose={() => {}}><p>x</p></AdsDialog>);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit" }), { key: "Escape" });
    expect(drawer).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("keydown", drawer);
  }
});

it("returns focus to the opener when it closes", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const { unmount } = render(<AdsDialog label="Edit" onClose={() => {}}><button>Inside</button></AdsDialog>);
  screen.getByRole("button", { name: "Inside" }).focus();
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("with unsaved input, Escape asks before discarding: Keep editing keeps the dialog, Discard changes closes it once", () => {
  const onClose = vi.fn();
  render(<AdsDialog label="Review campaign" onClose={onClose} confirmDiscard><input aria-label="Budget" defaultValue="40" /></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Review campaign" });
  const e = new Event("cancel", { cancelable: true });
  fireEvent(dialog, e);
  expect(e.defaultPrevented).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  const ask = screen.getByRole("dialog", { name: "Discard your changes?" });
  expect(ask.hasAttribute("open")).toBe(true);
  cancel(ask);
  expect(screen.queryByRole("dialog", { name: "Discard your changes?" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog.hasAttribute("open")).toBe(true);
  cancel(dialog);
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "Budget" }) as HTMLInputElement).value).toBe("40");
  cancel(dialog);
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("with unsaved input, a browser-forced close (the Android back gesture after a refused cancel) reopens the dialog and asks", () => {
  const onClose = vi.fn();
  render(<AdsDialog label="Review campaign" onClose={onClose} confirmDiscard><p>x</p></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Review campaign" });
  dialog.removeAttribute("open");
  fireEvent(dialog, new Event("close"));
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("with unsaved input, a backdrop click asks too; without it the dialog still closes at once, and busy still refuses", () => {
  const onClose = vi.fn();
  const { rerender } = render(<AdsDialog label="Edit" onClose={onClose} closeOnBackdrop confirmDiscard><p>x</p></AdsDialog>);
  const dialog = screen.getByRole("dialog", { name: "Edit" });
  dialog.getBoundingClientRect = () => box;
  fireEvent.mouseDown(dialog, { clientX: 50, clientY: 50 });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  rerender(<AdsDialog label="Edit" onClose={onClose} closeOnBackdrop confirmDiscard busy><p>x</p></AdsDialog>);
  cancel(dialog);
  expect(screen.queryByRole("dialog", { name: "Discard your changes?" })).toBeNull();
  rerender(<AdsDialog label="Edit" onClose={onClose} closeOnBackdrop><p>x</p></AdsDialog>);
  cancel(dialog);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Discard your changes?" })).toBeNull();
});

it("opens outside a hidden tab, so a modal never blocks the page unseen", () => {
  render(<div data-testid="page"><div data-testid="tab" style={{ display: "none" }}><AdsDialog label="New campaign" onClose={() => {}}><p>Form</p></AdsDialog></div></div>);
  const dialog = screen.getByRole("dialog", { name: "New campaign", hidden: true });
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(screen.getByTestId("tab").contains(dialog)).toBe(false);
  expect(dialog.parentElement).toBe(screen.getByTestId("page"));
});

it("opens outside a visible kept-alive tab, so switching tabs cannot hide an already-open modal", () => {
  render(<div data-testid="page"><div data-testid="tab" data-tab-id="channels"><AdsDialog label="Connect account" onClose={() => {}}><p>Form</p></AdsDialog></div></div>);
  const tab = screen.getByTestId("tab");
  const dialog = screen.getByRole("dialog", { name: "Connect account" });
  expect(tab.contains(dialog)).toBe(false);
  expect(dialog.parentElement).toBe(screen.getByTestId("page"));
  tab.style.display = "none";
  expect(getComputedStyle(dialog).display).not.toBe("none");
});
