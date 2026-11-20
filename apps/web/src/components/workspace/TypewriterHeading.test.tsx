// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { TYPEWRITER_PHRASES, TypewriterHeading } from "./TypewriterHeading";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const text = () => host.querySelector("h1")?.textContent ?? "";

describe("TypewriterHeading", () => {
  it("stays on Let's start and never erases itself", () => {
    act(() => root.render(<TypewriterHeading mode="grow" />));
    const full = `Let's ${TYPEWRITER_PHRASES.grow[0]}`;
    expect(text()).toBe(full);

    for (let i = 0; i < 100; i += 1) act(() => vi.advanceTimersByTime(200));
    expect(text()).toBe(full);
  });

  it("reads Let's start in build mode too", () => {
    act(() => root.render(<TypewriterHeading mode="build" />));
    expect(text()).toBe(`Let's ${TYPEWRITER_PHRASES.build[0]}`);
  });

  it("renders the headline alone, with no trailing dot element", () => {
    act(() => root.render(<TypewriterHeading mode="grow" />));
    const h1 = host.querySelector("h1")!;
    expect(h1.children.length).toBe(0);
    expect(h1.textContent).toBe(`Let's ${TYPEWRITER_PHRASES.grow[0]}`);
    expect(h1.querySelector(".rounded-full")).toBeNull();
    expect(h1.hasAttribute("aria-label")).toBe(false);
  });

  it("hydrates without a server/client mismatch", async () => {
    vi.useRealTimers();
    const html = renderToString(<TypewriterHeading mode="grow" />);
    const node = document.createElement("div");
    const recoverableErrors: unknown[] = [];
    node.innerHTML = html;
    document.body.appendChild(node);

    const hydrated = hydrateRoot(node, <TypewriterHeading mode="grow" />, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
    await act(async () => Promise.resolve());

    expect(html).toContain("Let&#x27;s start");
    expect(recoverableErrors).toEqual([]);
    act(() => hydrated.unmount());
    node.remove();
  });
});
