// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WebsiteEditorToolbar } from "./WebsiteEditorToolbar";
import type { SelectedElement } from "./editorProtocol";

const heading: SelectedElement = {
  selector: "section.hero h2",
  tag: "h2",
  text: "Recent shoots",
  textEditable: true,
  style: {},
};

afterEach(cleanup);

type Props = Parameters<typeof WebsiteEditorToolbar>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    selected: heading,
    canUndo: true,
    canRedo: true,
    onApply: vi.fn(),
    onDelete: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onClose: vi.fn(),
    onAskAi: vi.fn(async () => {}),
    ...over,
  };
}

const MANUAL = ["Element text", "Font", "Bold", "Undo", "Redo", "Delete element", "Done", "Text color", "Background color"];

function aiInput() {
  return screen.queryByLabelText("Ask AI to change this element") as HTMLInputElement | null;
}

function openAi() {
  fireEvent.click(screen.getByRole("button", { name: "Edit Element" }));
  return aiInput()!;
}

describe("element toolbar toggles between manual tools and AI", () => {
  it("opens in manual mode with every tool and no AI input in the DOM", () => {
    render(<WebsiteEditorToolbar {...props()} />);
    expect(aiInput()).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    for (const label of MANUAL) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit with AI" })).toBeNull();
    const bar = screen.getByTestId("editor-toolbar-tools");
    expect(within(bar).getByRole("button", { name: "Edit Element" })).toBeTruthy();
    expect(within(bar).getByLabelText("Bold")).toBeTruthy();
    const done = screen.getByLabelText("Done");
    expect(bar.lastElementChild).toBe(done);
    const row = bar.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(within(row).getByRole("button", { name: "Edit Element" })).toBeTruthy();
    expect(within(row).getByLabelText("Bold")).toBeTruthy();
    expect(row.contains(done)).toBe(false);
    expect(screen.getByTestId("editor-toolbar").children).toHaveLength(1);
  });

  it("never renders the design options row", () => {
    render(<WebsiteEditorToolbar {...props()} />);
    expect(screen.queryByText(/design options/i)).toBeNull();
    expect(screen.getByTestId("editor-toolbar").children).toHaveLength(1);
  });

  it("has no AI button and no way into AI mode without onAskAi", () => {
    render(<WebsiteEditorToolbar {...props({ onAskAi: undefined })} />);
    expect(screen.queryByRole("button", { name: "Edit Element" })).toBeNull();
    expect(aiInput()).toBeNull();
    expect(screen.getByLabelText("Bold")).toBeTruthy();
  });

  it("Edit Element swaps the tools for a focused input, Send and a close that goes back", () => {
    render(<WebsiteEditorToolbar {...props()} />);
    const input = openAi();
    expect(document.activeElement).toBe(input);
    for (const label of MANUAL) expect(screen.queryByLabelText(label)).toBeNull();
    const bar = screen.getByTestId("editor-toolbar-tools");
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Send", "Back to tools"]);
    expect(within(bar).getAllByRole("textbox")).toEqual([input]);
    expect(input.placeholder).toBe("What to change?");
    expect(bar.lastElementChild).toBe(screen.getByRole("button", { name: "Back to tools" }));
    expect(screen.queryByRole("button", { name: "Edit Element" })).toBeNull();
  });

  it("Enter sends the trimmed text once", async () => {
    const onAskAi = vi.fn(async () => {});
    render(<WebsiteEditorToolbar {...props({ onAskAi })} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "   make it bolder  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(onAskAi).toHaveBeenCalledWith("make it bolder");
  });

  it("Send while busy cannot send twice and shows the busy state", async () => {
    let resolve: () => void = () => {};
    const onAskAi = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<WebsiteEditorToolbar {...props({ onAskAi })} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "shorter" } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(send.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(send.querySelector(".animate-spin")).not.toBeNull();
    resolve();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(onAskAi).toHaveBeenCalledTimes(1);
  });

  it("Send with only spaces does nothing", () => {
    const onAskAi = vi.fn(async () => {});
    render(<WebsiteEditorToolbar {...props({ onAskAi })} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAskAi).not.toHaveBeenCalled();
  });

  it("Escape in the input returns to the tools without closing the selection", () => {
    const p = props();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    render(<WebsiteEditorToolbar {...p} />);
    const input = openAi();
    fireEvent.keyDown(input, { key: "Escape" });
    window.removeEventListener("keydown", windowEscape);
    expect(aiInput()).toBeNull();
    expect(screen.getByLabelText("Bold")).toBeTruthy();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onAskAi).not.toHaveBeenCalled();
    expect(windowEscape).not.toHaveBeenCalled();
  });

  it("the close icon in AI mode returns to the tools without closing the selection, and closes it only from the tools", () => {
    const p = props();
    render(<WebsiteEditorToolbar {...p} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "make it bigger" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to tools" }));
    expect(aiInput()).toBeNull();
    expect(screen.getByLabelText("Bold")).toBeTruthy();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onAskAi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Done"));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("selecting another element resets to manual mode with an empty input", () => {
    const p = props();
    const view = render(<WebsiteEditorToolbar {...p} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "half typed" } });
    view.rerender(<WebsiteEditorToolbar {...p} selected={{ ...heading, selector: "footer p", tag: "p" }} />);
    expect(aiInput()).toBeNull();
    expect(screen.getByLabelText("Bold")).toBeTruthy();
    expect(openAi().value).toBe("");
  });

  it("drops an answer for a previous selection after switching elements", async () => {
    let reject: (e: unknown) => void = () => {};
    const onAskAi = vi.fn(() => new Promise<void>((_, rej) => (reject = rej)));
    const p = props({ onAskAi });
    const view = render(<WebsiteEditorToolbar {...p} />);
    const input = openAi();
    fireEvent.change(input, { target: { value: "make it red" } });
    fireEvent.keyDown(input, { key: "Enter" });
    view.rerender(<WebsiteEditorToolbar {...p} selected={{ ...heading, selector: "footer p", tag: "p" }} />);
    const next = openAi();
    reject(new Error("old element failed"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(next.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Send" }).querySelector(".animate-spin")).toBeNull();
  });
});

describe("Apply saves typed edits in the manual tools", () => {
  const link: SelectedElement = { selector: "main a.cta", tag: "a", text: "Explore Cakes", textEditable: true, style: {}, attrs: { href: "/book" } };

  it("shows no Apply until something typed differs from the element", () => {
    render(<WebsiteEditorToolbar {...props()} />);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Element text"), { target: { value: "Recent shoots" } });
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Element text"), { target: { value: "Latest shoots" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  it("applies the text and the link together in one patch, and pressing it never also fires the field's blur save", () => {
    const p = props({ selected: link });
    render(<WebsiteEditorToolbar {...p} />);
    const text = screen.getByLabelText("Element text");
    fireEvent.change(text, { target: { value: "Order a cake" } });
    const href = screen.getByLabelText("Link URL");
    href.focus();
    fireEvent.change(href, { target: { value: "/order" } });
    const apply = screen.getByRole("button", { name: "Apply" });
    const kept = fireEvent.mouseDown(apply);
    expect(kept).toBe(false);
    fireEvent.click(apply);
    expect(p.onApply).toHaveBeenCalledTimes(1);
    expect(p.onApply).toHaveBeenCalledWith({ text: "Order a cake", attrs: { href: "/order" } });
  });

  it("is not offered in AI mode", () => {
    render(<WebsiteEditorToolbar {...props()} />);
    fireEvent.change(screen.getByLabelText("Element text"), { target: { value: "Latest shoots" } });
    openAi();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
