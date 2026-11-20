// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { VideoControls } from "./VideoControls";

afterEach(cleanup);

function mount() {
  const ref = createRef<HTMLVideoElement>();
  render(
    <div>
      <video ref={ref} />
      <VideoControls video={ref} title="Ad" />
    </div>,
  );
  return screen.getByTestId("video-controls");
}

describe("VideoControls layout", () => {
  it("keeps the seek bar on its own full-width row, apart from the four controls and the time label", () => {
    const controls = mount();
    const seek = screen.getByRole("slider", { name: "Seek" });
    const seekRow = seek.parentElement!;
    expect(controls.className).toContain("flex-col");
    expect(seekRow.parentElement).toBe(controls);
    expect(seekRow.className).toContain("w-full");
    expect(seekRow.className).toMatch(/min-w-\[\d+px\]/);
    for (const name of ["Play", "Mute", "Full screen"]) {
      const button = screen.getByRole("button", { name });
      expect(seekRow.contains(button)).toBe(false);
      expect(button.parentElement).not.toBe(controls);
      expect(button.parentElement).toBe(screen.getByTestId("video-button-row"));
    }
    const time = screen.getByText(/0:00 \/ 0:00/);
    expect(seekRow.contains(time)).toBe(false);
    expect(time.parentElement).toBe(controls);
    expect(screen.getByTestId("video-button-row").contains(time)).toBe(false);
  });

  it("gives the time label its own full-width line so three fixed buttons cannot squeeze it", () => {
    const controls = mount();
    const time = screen.getByTestId("video-time");
    expect(time.textContent).toBe("0:00 / 0:00");
    expect(time.parentElement).toBe(controls);
    expect(time.className).toContain("w-full");
    expect(time.className).not.toContain("truncate");
    expect(time.className).toContain("whitespace-nowrap");
    const order = Array.from(controls.children);
    expect(order.indexOf(time)).toBeGreaterThan(order.indexOf(screen.getByTestId("video-seek-row")));
    expect(order.indexOf(time)).toBeLessThan(order.indexOf(screen.getByTestId("video-button-row")));
  });
});
