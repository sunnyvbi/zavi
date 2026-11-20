// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VideoTile } from "./VideoTile";

afterEach(cleanup);

describe("the delivered video tile on the business side", () => {
  it("plays the watermarked preview when there is one", () => {
    render(<VideoTile url="https://storage.test/preview.mp4" caption="Video · watermarked preview · Oct 22" />);
    const player = screen.getByLabelText("Video · watermarked preview · Oct 22") as HTMLVideoElement;
    expect(player.tagName).toBe("VIDEO");
    expect(player.hasAttribute("controls")).toBe(true);
  });

  it("with nothing to play, shows no play button, only why", () => {
    const { container } = render(<VideoTile url={null} caption="Preview could not be built" />);
    expect(screen.getByRole("img", { name: "Preview could not be built" })).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".lucide-play")).toBeNull();
    expect(container.querySelector(".lucide-video-off")).not.toBeNull();
  });

  it("while the preview is being made, shows a waiting clock instead", () => {
    const { container } = render(<VideoTile url={null} caption="Preview being prepared" waiting />);
    expect(container.querySelector(".lucide-clock")).not.toBeNull();
    expect(container.querySelector(".lucide-play")).toBeNull();
  });
});

describe("the player on its own", () => {
  it("shows only the video and its badge: no caption row and no View larger button", () => {
    const { container } = render(<VideoTile url="https://storage.test/preview.mp4" caption="Video · Oct 22" watermarked />);
    expect(screen.getByText("Watermarked preview")).toBeTruthy();
    expect(screen.queryByText("Video · Oct 22")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("video")?.hasAttribute("controls")).toBe(true);
  });
});

describe("a play link that stops working", () => {
  it("swaps the broken player for the placeholder, and plays again when a fresh link arrives", () => {
    const { container, rerender } = render(<VideoTile url="https://storage.test/expired.mp4" caption="Video · Oct 22" watermarked />);
    fireEvent.error(container.querySelector("video") as HTMLVideoElement);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByTestId("video-tile-empty")).toBeTruthy();
    expect(screen.getByText("The video did not load. Reopen it to try again.")).toBeTruthy();
    expect(screen.queryByText("Watermarked preview")).toBeNull();

    rerender(<VideoTile url="https://storage.test/fresh.mp4" caption="Video · Oct 22" watermarked />);
    expect(container.querySelector("video")?.getAttribute("src")).toBe("https://storage.test/fresh.mp4");
  });
});
