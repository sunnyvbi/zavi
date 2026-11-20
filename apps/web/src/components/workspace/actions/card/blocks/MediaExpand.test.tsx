// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MediaTile } from "./MediaTile";

afterEach(cleanup);

it("opens an image full size from the expand button and closes it again", () => {
  render(<MediaTile url="https://files.test/pin.png" alt="Car at the door" />);
  expect(screen.queryByTestId("media-lightbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand image" }));
  const box = screen.getByTestId("media-lightbox");
  expect(box.querySelector("img")?.getAttribute("src")).toBe("https://files.test/pin.png");
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.queryByTestId("media-lightbox")).toBeNull();
});

it("opens a video in the full size view with its own controls, and Escape closes it", () => {
  render(<MediaTile url="https://files.test/ad.mp4" alt="Ad video" video />);
  fireEvent.click(screen.getByRole("button", { name: "Expand video" }));
  const player = screen.getByTestId("media-lightbox").querySelector("video");
  expect(player?.getAttribute("src")).toBe("https://files.test/ad.mp4");
  expect(player?.controls).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("media-lightbox")).toBeNull();
});

it("offers no expand once the media has failed to load", () => {
  render(<MediaTile url="https://files.test/gone.png" alt="Gone" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("button", { name: "Expand image" })).toBeNull();
});

it("a click on the image itself opens it and hands focus back to the expand button on close", () => {
  render(<MediaTile url="https://files.test/pin.png" alt="Car at the door" />);
  fireEvent.click(screen.getByRole("img").parentElement!.querySelector("span[aria-hidden]")!);
  expect(screen.getByTestId("media-lightbox")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand image" }));
});
