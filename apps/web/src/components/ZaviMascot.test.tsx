// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ZaviMascot } from "./ZaviMascot";

afterEach(cleanup);

const sources = (v: Element | null) => [...(v?.querySelectorAll("source") ?? [])].map((s) => s.getAttribute("src") ?? "");

describe("ZaviMascot", () => {
  it("is a still image below 48px, a video at 48px and up", () => {
    const small = render(<ZaviMascot size={28} />);
    expect(small.container.querySelector("video")).toBeNull();
    expect(small.container.querySelector("img")?.getAttribute("src")).toContain("zavi-still");
    cleanup();
    const big = render(<ZaviMascot size={48} />);
    expect(big.container.querySelector("video")?.getAttribute("data-clip")).toBe("idle");
  });

  it("offers Safari the HEVC clip first and everyone else the WebM", () => {
    const { container } = render(<ZaviMascot size={96} working />);
    const [mov, webm] = sources(container.querySelector("video"));
    expect(mov).toContain("zavi-working.mov");
    expect(webm).toContain("zavi-working.webm");
  });

  it("celebrates when the counter goes up, never for its value on mount", () => {
    const { rerender } = render(<ZaviMascot size={80} celebrate={2} />);
    expect(screen.queryByTestId("zavi-mascot-celebrate")).toBeNull();
    rerender(<ZaviMascot size={80} celebrate={3} />);
    expect(screen.getByTestId("zavi-mascot-celebrate")).toBeTruthy();
    fireEvent.ended(screen.getByTestId("zavi-mascot-celebrate"));
    expect(screen.queryByTestId("zavi-mascot-celebrate")).toBeNull();
  });

  it("plays the poke reaction on tap, and falls back to the still when no format plays", () => {
    const { container } = render(<ZaviMascot size={96} />);
    fireEvent.click(screen.getByTestId("zavi-mascot"));
    expect(screen.getByTestId("zavi-mascot-poke")).toBeTruthy();
    const loop = container.querySelector('video[data-clip="idle"]')!;
    fireEvent.error(loop.querySelector("source:last-of-type")!);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeTruthy();
  });
});
