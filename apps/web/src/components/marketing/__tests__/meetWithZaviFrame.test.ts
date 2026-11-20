import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const meet = readFileSync(join(__dirname, "../MeetWithZavi.tsx"), "utf8");
const chat = readFileSync(join(__dirname, "../growth-home/ChatPreview.tsx"), "utf8");
const frame = readFileSync(join(__dirname, "../growth-home/PreviewFrame.tsx"), "utf8");

describe("the four channel mockups", () => {
  it("all sit in the one frame, so switching tabs never changes the size", () => {
    expect(meet.match(/<PreviewFrame/g)?.length).toBe(2);
    expect(chat.match(/<PreviewFrame/g)?.length).toBe(1);
    expect(meet).not.toMatch(/xl:h-\[604px\]|xl:max-w-\[786px\]|xl:max-w-\[706px\]|max-w-\[642px\]|max-w-\[486px\]/);
    expect(meet).toMatch(/CHAT_PANE_CLASS = `w-full min-w-0 \$\{PREVIEW_FRAME_MAX_W\}`/);
    expect(meet).toMatch(/<div className=\{CHAT_PANE_CLASS\}>/);
    expect(frame).toMatch(/PREVIEW_FRAME_INNER_H = "h-\[540px\] sm:h-\[580px\]"/);
  });

  it("show the same Zavi mark everywhere, the app icon", () => {
    expect(meet).not.toMatch(/ZaviBadge|ZaviMark/);
    for (const src of [meet, chat]) {
      expect(src).toMatch(/import \{[^}]*ZaviAvatar[^}]*\} from "\.\/(growth-home\/)?PreviewFrame"/);
      expect(src).not.toMatch(/zavi-app-icon\.png/);
    }
    expect(frame.match(/zavi-app-icon\.png/g)?.length).toBe(1);
  });

  it("open the chat list at the same width in every skin", () => {
    const sidebars = meet.match(/<aside className="hidden w-\[\d+px\][^"]*"/g) ?? [];
    expect(sidebars.length).toBe(2);
    for (const aside of sidebars) expect(aside).toMatch(/^<aside className="hidden w-\[248px\] .* sm:flex"$/);
    expect(chat).toMatch(/const SIDEBAR = "hidden w-\[248px\] shrink-0 flex-col sm:flex"/);
  });
});
