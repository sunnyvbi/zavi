// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { Dialog } from "./Dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
  document.querySelectorAll(".workspace-shell").forEach((node) => node.remove());
});

function TransformedPager({ onClose, onPaneKey }: { onClose: () => void; onPaneKey: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div data-testid="pager" style={{ transform: "translateX(-100px)", width: "200%" }} onKeyDown={(event) => onPaneKey(event.key)}>
    <button type="button" onClick={() => setOpen(true)}>Upload CSV</button>
    {open && <Dialog id="csv-dialog" label="Upload CSV" onClose={onClose}><input aria-label="File name" /><button type="button">Import</button></Dialog>}
  </div>;
}

describe("Dialog inside a transformed ancestor", () => {
  it("mounts on document.body so the transform cannot become its containing block", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
    const close = vi.fn();
    const paneKey = vi.fn();
    render(<TransformedPager onClose={close} onPaneKey={paneKey} />);
    const opener = screen.getByRole("button", { name: "Upload CSV" });
    opener.focus();
    fireEvent.click(opener);
    const pager = screen.getByTestId("pager");
    const dialog = screen.getByRole("dialog", { name: "Upload CSV" });
    expect(pager.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.closest('[style*="transform"]')).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const field = screen.getByRole("textbox", { name: "File name" });
    fireEvent.keyDown(field, { key: "a" });
    expect(paneKey).toHaveBeenCalledWith("a");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(paneKey).not.toHaveBeenCalledWith("Escape");
  });

  it("mounts inside the workspace shell so html.dark .workspace-shell styles still reach it", () => {
    document.documentElement.classList.add("dark");
    const shell = document.createElement("div");
    shell.className = "workspace-shell";
    document.body.append(shell);
    render(<TransformedPager onClose={vi.fn()} onPaneKey={vi.fn()} />, { container: shell.appendChild(document.createElement("div")) });
    fireEvent.click(screen.getByRole("button", { name: "Upload CSV" }));
    const pager = screen.getByTestId("pager");
    const dialog = screen.getByRole("dialog", { name: "Upload CSV" });
    expect(dialog.parentElement).toBe(shell);
    expect(dialog.closest("html.dark .workspace-shell")).toBe(shell);
    expect(pager.contains(dialog)).toBe(false);
    expect(dialog.closest('[style*="transform"]')).toBeNull();
  });

  it("mounts an open-on-first-render dialog once across hydration", async () => {
    let mounts = 0;
    let unmounts = 0;
    function Probe() {
      useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <button type="button">Continue</button>;
    }
    const tree = <Dialog id="hydrated-dialog" label="Hydrated" onClose={vi.fn()}><Probe /></Dialog>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);
    document.body.append(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, tree); });
    expect(screen.getByRole("dialog", { name: "Hydrated" })).toBeTruthy();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("Dialog host after the workspace shell changes", () => {
  const addShell = () => {
    const shell = document.createElement("div");
    shell.className = "workspace-shell";
    document.body.append(shell);
    return shell;
  };
  function Toggle() {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen((value) => !value)}>Toggle</button>
      <Dialog id="late-dialog" label="Late" onClose={vi.fn()}><p hidden={!open}>body</p></Dialog>
    </>;
  }

  it("moves into a shell that appears after the dialog mounted, then opens inside it", async () => {
    render(<Toggle />);
    expect(screen.getByRole("dialog", { name: "Late" }).parentElement).toBe(document.body);
    const shell = addShell();
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Late" }).parentElement).toBe(shell));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("follows a replaced shell node instead of staying on the removed one", async () => {
    const first = addShell();
    render(<Toggle />);
    expect(screen.getByRole("dialog", { name: "Late" }).parentElement).toBe(first);
    first.remove();
    const second = addShell();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Late" }).parentElement).toBe(second));
    expect(first.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByRole("dialog", { name: "Late" }).parentElement).toBe(second);
    expect(screen.getByText("body").hidden).toBe(false);
  });

  it("opens inside a shell added while it was closed", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open</button>{open && <Dialog id="opened" label="Opened" onClose={vi.fn()}>x</Dialog>}</>;
    }
    render(<Opener />);
    const shell = addShell();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Opened" }).parentElement).toBe(shell);
  });
});
