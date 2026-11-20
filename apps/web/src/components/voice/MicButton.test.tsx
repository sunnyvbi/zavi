// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dictation = {
  supported: true,
  listening: false,
  error: null as string | null,
  start: vi.fn(() => {
    dictation.listening = true;
  }),
  stop: vi.fn(async () => {
    dictation.listening = false;
  }),
  cancel: vi.fn(() => {
    dictation.listening = false;
  }),
};
let emit: (chunk: { transcript: string; isFinal: boolean }) => void = () => {};

vi.mock("@/lib/voice/useDictation", () => ({
  useDictation: (onChunk: typeof emit) => {
    emit = onChunk;
    return dictation;
  },
}));
vi.mock("@/lib/voice/useAudioLevels", () => ({
  useAudioLevels: ({ bars }: { bars: number }) =>
    Array.from({ length: bars }, () => 0.5),
}));

import { MicButton } from "./MicButton";

function mount(onTranscript: (t: string) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  act(() => root.render(<MicButton onTranscript={onTranscript} compact />));
  return { host, root };
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const phase = (host: HTMLElement) =>
  host.querySelector('[data-testid="dictation-wave"]')?.getAttribute("data-phase");
const visibleText = (host: HTMLElement) => {
  const copy = host.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".sr-only").forEach((el) => el.remove());
  return copy.textContent ?? "";
};
const click = (el: HTMLButtonElement | null) =>
  act(() => {
    el?.click();
  });

describe("MicButton", () => {
  it("keeps reduced-motion rules scoped and disables the surface animation", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/voice/MicButton.module.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.dictationSurface\s*\{[^}]*animation:\s*none/s);
    expect(reduced).not.toMatch(/\.dictationSurface\s*,\s*\.transcript/);
  });

  it("walks start → pause → resume → stop → confirm and emits the transcript", async () => {
    const onTranscript = vi.fn();
    const { host, root } = mount(onTranscript);

    click(button(host, "Start dictation"));
    expect(dictation.start).toHaveBeenCalledTimes(1);
    expect(phase(host)).toBe("recording");
    expect(host.querySelectorAll('[data-testid="dictation-wave"] span')).toHaveLength(56);
    expect(button(host, "Pause recording")).not.toBeNull();
    expect(button(host, "Stop recording")).not.toBeNull();
    expect(button(host, "Cancel voice input")).not.toBeNull();
    expect(button(host, "Confirm and insert transcript")).not.toBeNull();

    act(() => emit({ transcript: "hello team", isFinal: true }));
    await act(async () => {
      button(host, "Pause recording")?.click();
    });
    expect(phase(host)).toBe("paused");
    expect(button(host, "Resume recording")).not.toBeNull();

    click(button(host, "Resume recording"));
    expect(dictation.start).toHaveBeenCalledTimes(2);
    act(() => emit({ transcript: "ship it", isFinal: true }));

    await act(async () => {
      button(host, "Stop recording")?.click();
    });
    expect(phase(host)).toBe("stopped");
    expect(button(host, "Pause recording")).toBeNull();

    await act(async () => {
      button(host, "Confirm and insert transcript")?.click();
    });
    expect(onTranscript).toHaveBeenCalledWith("hello team ship it");
    expect(button(host, "Start dictation")).not.toBeNull();
    act(() => root.unmount());
  });

  it("cancel discards the capture and Escape cancels too", () => {
    const onTranscript = vi.fn();
    const { host, root } = mount(onTranscript);
    click(button(host, "Start dictation"));
    act(() => emit({ transcript: "discard me", isFinal: true }));
    click(button(host, "Cancel voice input"));
    expect(dictation.cancel).toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(button(host, "Start dictation")).not.toBeNull();

    click(button(host, "Start dictation"));
    act(() => {
      host
        .querySelector('[role="group"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(button(host, "Start dictation")).not.toBeNull();
    act(() => root.unmount());
  });

  it("shows nothing but the voice wave while recording without an error", () => {
    const { host, root } = mount(vi.fn());
    click(button(host, "Start dictation"));
    expect(visibleText(host)).toBe("");
    expect(host.querySelector('[data-testid="dictation-error"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Recording");
    act(() => emit({ transcript: "book a cake", isFinal: false }));
    expect(visibleText(host)).toBe("book a cake");
    click(button(host, "Cancel voice input"));
    act(() => root.unmount());
  });

  it("puts a dictation error on screen in the overlay, and still announces it", async () => {
    const { host, root } = mount(vi.fn());
    const message = "Microphone permission denied. Enable it in browser settings.";
    dictation.error = message;
    click(button(host, "Start dictation"));

    const shown = host.querySelector<HTMLElement>('[data-testid="dictation-error"]');
    expect(shown).not.toBeNull();
    expect(shown!.closest(".sr-only")).toBeNull();
    expect(shown!.classList.contains("sr-only")).toBe(false);
    expect(shown!.closest('[role="group"]')).not.toBeNull();
    expect(visibleText(host)).toBe(message);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(message);
    expect(host.querySelector('[role="status"]')?.classList.contains("sr-only")).toBe(true);
    const bars = [...host.querySelectorAll<HTMLElement>('[data-testid="dictation-wave"] span')];
    expect(bars.every((bar) => bar.style.height === "14px")).toBe(true);

    act(() => emit({ transcript: "book a cake", isFinal: false }));
    expect(visibleText(host)).toContain(message);
    expect(visibleText(host)).toContain("book a cake");

    await act(async () => {
      button(host, "Pause recording")?.click();
    });
    expect(visibleText(host)).toContain(message);

    dictation.error = null;
    click(button(host, "Resume recording"));
    expect(host.querySelector('[data-testid="dictation-error"]')).toBeNull();
    expect(visibleText(host)).not.toContain(message);
    click(button(host, "Cancel voice input"));
    act(() => root.unmount());
  });

  it("keeps the newest words in view when the transcript is longer than the line", () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(Element.prototype, "scrollWidth", {
      configurable: true,
      get(this: Element) {
        return (this.textContent ?? "").length * 8;
      },
    });
    try {
      const { host, root } = mount(vi.fn());
      click(button(host, "Start dictation"));
      const line = () => host.querySelector<HTMLElement>('[data-testid="dictation-transcript"]')!;
      act(() => emit({ transcript: "short words", isFinal: false }));
      expect(line().dataset.overflowing).toBe("false");
      expect(line().scrollLeft).toBe(0);
      act(() => emit({ transcript: "Hey there how are you are you all good is there anything I can help with today", isFinal: false }));
      expect(line().dataset.overflowing).toBe("true");
      expect(line().scrollLeft).toBe(line().scrollWidth);
      expect(line().className).toContain("text-left");
      expect(line().querySelector('[data-testid="dictation-transcript-text"]')!.className).toContain("pr-12");
      click(button(host, "Cancel voice input"));
      act(() => root.unmount());
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      if (scroll) Object.defineProperty(Element.prototype, "scrollWidth", scroll);
    }
  });

  it("sizes the wave to its container so it fills a wide composer edge to edge", () => {
    const observers: { cb: ResizeObserverCallback; target: Element | null; disconnected: boolean }[] = [];
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      record: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.record = { cb, target: null, disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.target = target;
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
    };
    try {
      const { host, root } = mount(vi.fn());
      click(button(host, "Start dictation"));
      const wave = host.querySelector<HTMLElement>('[data-testid="dictation-wave"]')!;
      const bars = () => wave.querySelectorAll("span").length;
      const live = observers.filter((o) => !o.disconnected && o.target === wave);
      expect(live).toHaveLength(1);
      const resize = (width: number) =>
        act(() => {
          live[0].cb([{ target: wave, contentRect: { width } as DOMRectReadOnly } as unknown as ResizeObserverEntry], {} as ResizeObserver);
        });

      resize(300);
      const narrow = bars();
      expect(narrow).toBe(60);
      resize(900);
      const wide = bars();
      expect(wide).toBe(180);
      expect(wide).toBeGreaterThan(narrow);
      expect(wide * 2 + (wide - 1) * 3).toBeLessThanOrEqual(900);
      expect((wide + 1) * 2 + wide * 3).toBeGreaterThan(900);
      resize(20);
      expect(bars()).toBe(16);

      click(button(host, "Cancel voice input"));
      expect(observers.every((o) => o.disconnected)).toBe(true);
      act(() => root.unmount());
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  it("shows the unsupported label only where the surface asks for it", () => {
    dictation.supported = false;
    try {
      const plain = document.createElement("div");
      document.body.appendChild(plain);
      const plainRoot = createRoot(plain);
      act(() => plainRoot.render(<MicButton onTranscript={() => {}} />));
      expect(plain.querySelector('[data-testid="dictation-unsupported"]')).toBeNull();
      act(() => plainRoot.unmount());

      const studio = document.createElement("div");
      document.body.appendChild(studio);
      const studioRoot = createRoot(studio);
      act(() => studioRoot.render(<MicButton onTranscript={() => {}} showUnsupported />));
      expect(studio.querySelector('[data-testid="dictation-unsupported"]')?.textContent).toBe("Dictation is not supported in this browser");
      act(() => studioRoot.unmount());
    } finally {
      dictation.supported = true;
    }
  });
});
