// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WebsiteEditorToolbar } from "./WebsiteEditorToolbar";
import type { SelectedElement } from "./editorProtocol";

const container: SelectedElement = {
  selector: "main > div:nth-of-type(2)",
  tag: "div",
  text: "",
  textEditable: false,
  style: {},
};

afterEach(cleanup);

function mount(onAskAi: (m: string) => Promise<void>) {
  render(
    <WebsiteEditorToolbar
      selected={container}
      canUndo={false}
      canRedo={false}
      onApply={() => {}}
      onDelete={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
      onClose={() => {}}
      onAskAi={onAskAi}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Element" }));
  return screen.getByLabelText("Ask AI to change this element") as HTMLInputElement;
}

function ask(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("WebsiteEditorToolbar — Ask AI failure", () => {
  it("shows the server's reason, keeps what was typed, and clears on the next keystroke", async () => {
    const reason = "I couldn't turn that into an edit on this element - try describing the text, color, or link.";
    const onAskAi = vi.fn(async () => {
      throw new Error(reason);
    });
    const input = mount(onAskAi);
    ask(input, "This is good. We need to improve it further.");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(reason);
    expect(alert.getAttribute("title")).toBe(reason);
    expect(input.value).toBe("This is good. We need to improve it further.");
    expect(onAskAi).toHaveBeenCalledWith("This is good. We need to improve it further.");

    fireEvent.change(input, { target: { value: "make the title shorter" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to a generic line when the failure carries no message", async () => {
    const input = mount(async () => {
      throw new Error("");
    });
    ask(input, "anything");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't do that. Try again");
  });

  it("clears the input and shows no alert on success", async () => {
    const input = mount(async () => {});
    ask(input, "make the title shorter");
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
