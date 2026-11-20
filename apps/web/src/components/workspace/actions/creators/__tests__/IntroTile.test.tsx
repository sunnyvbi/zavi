import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntroTile } from "../CreatorCard";

const PHOTO = "https://signed.test/photo.jpg?token=a";
const ILL = "https://signed.test/ill.png?token=b";
const html = (p: Parameters<typeof IntroTile>[0]) => renderToStaticMarkup(<IntroTile {...p} />);

describe("IntroTile priority", () => {
  it("a photo wins over everything", () => {
    const out = html({ name: "Maya Films", hasVideo: true, photoUrl: PHOTO, illustrationUrl: ILL });
    expect(out).toContain(PHOTO.replace(/&/g, "&amp;"));
    expect(out).not.toContain("intro video");
    expect(out).not.toContain("Illustration");
    expect(out).not.toContain(ILL);
  });

  it("no photo: the intro video tile exactly as before", () => {
    const withIll = html({ name: "Maya Films", hasVideo: true, illustrationUrl: ILL });
    const before = html({ name: "Maya Films", hasVideo: true });
    expect(withIll).toBe(before);
    expect(before).toContain('aria-label="Maya Films intro video"');
  });

  it("no photo, no video: the illustration with a visible Illustration label", () => {
    const out = html({ name: "Maya Films", hasVideo: false, illustrationUrl: ILL });
    expect(out).toContain(ILL.replace(/&/g, "&amp;"));
    expect(out).toContain(">Illustration<");
    expect(out).not.toContain("MF");
  });

  it("nothing at all: initials", () => {
    const out = html({ name: "Maya Films", hasVideo: false });
    expect(out).toContain(">MF<");
    expect(out).toContain("No intro video yet");
    expect(out).not.toContain("<img");
  });
});
