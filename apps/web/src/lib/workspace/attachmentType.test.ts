import { describe, expect, it } from "vitest";
import { normalizeAttachmentFile } from "./attachmentType";

const blank = (name: string) => new File(["x"], name, { type: "" });

describe("normalizeAttachmentFile", () => {
  it("gives a blank-MIME .mp4 the video/mp4 type so it is not silently dropped", () => {
    const f = normalizeAttachmentFile(blank("clip.mp4"));
    expect(f.type).toBe("video/mp4");
    expect(f.name).toBe("clip.mp4");
  });

  it("infers images case-insensitively", () => {
    expect(normalizeAttachmentFile(blank("PHOTO.JPG")).type).toBe("image/jpeg");
    expect(normalizeAttachmentFile(blank("a.jpeg")).type).toBe("image/jpeg");
    expect(normalizeAttachmentFile(blank("a.png")).type).toBe("image/png");
    expect(normalizeAttachmentFile(blank("a.webp")).type).toBe("image/webp");
  });

  it("returns a typed file unchanged", () => {
    const typed = new File(["x"], "clip.mp4", { type: "video/quicktime" });
    expect(normalizeAttachmentFile(typed)).toBe(typed);
  });

  it("does not invent a type for unsupported or extensionless files", () => {
    const mov = blank("clip.mov");
    const none = blank("README");
    expect(normalizeAttachmentFile(mov)).toBe(mov);
    expect(normalizeAttachmentFile(none)).toBe(none);
  });
});
