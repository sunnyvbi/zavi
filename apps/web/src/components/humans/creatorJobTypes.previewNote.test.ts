import { describe, expect, it } from "vitest";
import { submissionPreviewNote } from "./creatorJobTypes";

describe("the note under an unpaid file with no preview", () => {
  it("a supported file Zavi could not process does not tell the business to have it resent", () => {
    const note = submissionPreviewNote({ preview: "unavailable", preview_unavailable_reason: "not_built", watermarked: false, download_url: null });
    expect(note).not.toContain("send it again as an MP4");
  });

  it("never vouches for a file nobody could open before the business pays for it", () => {
    const note = submissionPreviewNote({ preview: "unavailable", preview_unavailable_reason: "not_built", watermarked: false, download_url: null })!;
    expect(note).not.toMatch(/file itself is fine|no need to ask/);
    expect(note).toContain("nobody has checked this file yet");
    expect(note).toContain("Before you approve, which pays the creator");
  });

  it("a file type Zavi cannot preview still asks for an MP4 or JPEG", () => {
    expect(submissionPreviewNote({ preview: "unavailable", preview_unavailable_reason: "file_type", watermarked: false, download_url: null })).toContain(
      "send it again as an MP4 or JPEG",
    );
    expect(submissionPreviewNote({ preview: "unavailable", watermarked: false, download_url: null })).toContain("send it again as an MP4 or JPEG");
  });
});
