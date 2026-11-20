// @vitest-environment jsdom

import { CHANNELS } from "@zavi/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposerInput } from "./MentionComposerInput";

const channel = CHANNELS[0];

afterEach(cleanup);

function renderInput(overrides?: { value?: string; position?: number }) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const onPasteFiles = vi.fn();
  render(
    <MentionComposerInput
      value={overrides?.value ?? "create a draft for where you need"}
      position={overrides?.position ?? 19}
      channel={channel}
      ariaLabel="Send a message to Zavi"
      onChange={onChange}
      onRemove={onRemove}
      onSubmit={() => {}}
      onPasteFiles={onPasteFiles}
    />,
  );
  return { onChange, onRemove, onPasteFiles };
}

describe("MentionComposerInput", () => {
  it("keeps the selected channel between the prompt text and editable suffix", () => {
    renderInput();
    const textbox = screen.getByRole("textbox", {
      name: "Send a message to Zavi",
    });
    const chip = screen.getByRole("button", { name: `Remove ${channel.name}` });

    expect(textbox.textContent).toContain("create a draft for");
    expect(textbox.textContent).toContain(channel.name);
    expect(textbox.textContent).toContain("where you need");
    expect(chip.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps the same two-line minimum height as the plain composer", () => {
    renderInput();

    expect(
      screen
        .getByRole("textbox", { name: "Send a message to Zavi" })
        .classList.contains("min-h-composerInput"),
    ).toBe(true);
  });

  it("reports text edits without putting spacing placeholders in the value", () => {
    const { onChange } = renderInput({ value: "create a draft for ", position: 19 });
    const textbox = screen.getByRole("textbox", {
      name: "Send a message to Zavi",
    });
    const chip = screen.getByRole("button", { name: `Remove ${channel.name}` });
    const suffix = chip.nextElementSibling as HTMLSpanElement;
    suffix.textContent = "where you need";
    fireEvent.input(textbox);

    expect(onChange).toHaveBeenCalledWith(
      "create a draft for where you need",
      19,
    );
  });

  it("returns the plain text and caret position when the chip is clicked", () => {
    const { onRemove } = renderInput();
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${channel.name}` }),
    );

    expect(onRemove).toHaveBeenCalledWith(
      "create a draft for where you need",
      19,
    );
  });

  it("pastes multi-line text after the chip as plain text and keeps a pasted screenshot", () => {
    const { onChange, onPasteFiles } = renderInput({ value: "create a draft for ", position: 19 });
    const textbox = screen.getByRole("textbox", { name: "Send a message to Zavi" });
    const suffix = screen.getByRole("button", { name: `Remove ${channel.name}` }).nextElementSibling as HTMLSpanElement;
    const range = document.createRange();
    range.selectNodeContents(suffix);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const file = new File(["png"], "shot.png", { type: "image/png" });

    fireEvent.paste(textbox, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: (type: string) =>
          type === "text/plain" ? "launch plan\r\nweek one" : "<b>launch plan</b><div>week one</div>",
      },
    });

    expect(onChange).toHaveBeenLastCalledWith("create a draft for launch plan\nweek one", 19);
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
  });

  it("pastes before the chip when the caret is there", () => {
    const { onChange } = renderInput({ value: "draft  for me", position: 6 });
    const textbox = screen.getByRole("textbox", { name: "Send a message to Zavi" });
    const prefix = screen.getByRole("button", { name: `Remove ${channel.name}` }).previousElementSibling as HTMLSpanElement;
    const range = document.createRange();
    range.selectNodeContents(prefix);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    fireEvent.paste(textbox, { clipboardData: { items: [], getData: () => "a post " } });

    expect(onChange).toHaveBeenLastCalledWith("draft a post  for me", 13);
  });
});
