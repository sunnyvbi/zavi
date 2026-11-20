import { describe, expect, it, vi } from "vitest";
import { handleTextareaPaste } from "./paste";

function clipboard({ text = "", image = false }: { text?: string; image?: boolean }) {
  const file = new File(["png"], "shot.png", { type: "image/png" });
  const items = image ? [{ kind: "file", type: "image/png", getAsFile: () => file }] : [];
  return { items, getData: (type: string) => (type === "text/plain" ? text : "") } as unknown as DataTransfer;
}

describe("home chat box paste", () => {
  it("keeps the pasted text when the clipboard also holds a screenshot", () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    handleTextareaPaste({ clipboardData: clipboard({ text: "line one\nline two", image: true }), preventDefault }, onFiles);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })]);
  });

  it("attaches a screenshot-only paste without inserting anything", () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    handleTextareaPaste({ clipboardData: clipboard({ image: true }), preventDefault }, onFiles);
    expect(preventDefault).toHaveBeenCalled();
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("leaves a text-only paste to the browser", () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    handleTextareaPaste({ clipboardData: clipboard({ text: "hi" }), preventDefault }, onFiles);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });
});
