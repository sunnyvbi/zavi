import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { LaunchVideoForm } from "./LaunchVideoForm";

describe("/launch-video voiceover notice", () => {
  it("tells the visitor what the audio is, before generation", () => {
    const html = renderToStaticMarkup(<LaunchVideoForm />);
    expect(html).toContain('data-testid="launch-video-voiceover-notice"');
    expect(html).toMatch(/no voiceover/i);
    expect(html).not.toMatch(/will be silent/i);
  });

  it("does not promise a follow-up we do not send", () => {
    const html = renderToStaticMarkup(<LaunchVideoForm />);
    expect(html).not.toMatch(/let you know|notify you|when voiceover is back/i);
  });
});
