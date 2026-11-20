// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChatConnectCard } from "./ChatConnectCard";

afterEach(cleanup);

describe("ChatConnectCard", () => {
  it("inline renders in place: no backdrop, no fixed dialog", () => {
    render(<ChatConnectCard title="Connect X" blurb="b" onClose={() => {}} inline>body</ChatConnectCard>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect X" }).className).not.toMatch(/\bfixed\b/);
    expect(document.querySelector(".fixed")).toBeNull();
  });

  it("stays a modal by default", () => {
    render(<ChatConnectCard title="Connect X" blurb="b" onClose={() => {}}>body</ChatConnectCard>);
    expect(screen.getByRole("dialog", { name: "Connect X" }).className).toMatch(/\bfixed\b/);
  });
});

describe("ChatConnectCard Escape", () => {
  it("inline ignores Escape; the modal closes on it", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const onInline = vi.fn();
    const onModal = vi.fn();
    render(<ChatConnectCard title="A" blurb="b" onClose={onInline} inline>x</ChatConnectCard>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onInline).not.toHaveBeenCalled();
    cleanup();
    render(<ChatConnectCard title="B" blurb="b" onClose={onModal}>x</ChatConnectCard>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onModal).toHaveBeenCalledTimes(1);
  });
});
