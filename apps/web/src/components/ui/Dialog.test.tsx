// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { Dialog } from "./Dialog";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function FirstClient({ children, capture }: { children: ReactNode; capture: () => void }) {
  useLayoutEffect(capture, [capture]);
  return children;
}
describe("Dialog", () => {
  it("closes on Escape, traps Tab, and restores the opener", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const view = render(<Dialog id="test-dialog" label="Test" onClose={close}><button type="button">First</button><button type="button">Last</button></Dialog>);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("lets a nested confirmation own Escape and refuses dismissal while saving", () => {
    const close = vi.fn();
    const view = render(<Dialog id="test-dialog" label="Test" onClose={close}><div role="alertdialog" aria-label="Confirm"><button type="button">Confirm</button></div></Dialog>);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    view.rerender(<Dialog id="test-dialog" label="Test" onClose={close} busy><button type="button">Saving</button></Dialog>);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
  it("does not dismiss a busy child upload", () => {
    const close = vi.fn();
    render(<Dialog id="test-dialog" label="Test" onClose={close}><div aria-busy="true"><button type="button">Uploading</button></div></Dialog>);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
  it("hydrates the same first frame as the server", async () => {
    const dialog = <Dialog id="test-dialog" label="Test" onClose={vi.fn()}><button type="button">Continue</button></Dialog>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(dialog);
    document.body.append(container);
    const server = container.cloneNode(true);
    let matches = false;
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, <FirstClient capture={() => { matches = container.isEqualNode(server); }}>{dialog}</FirstClient>); });
    expect(matches).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });
});
