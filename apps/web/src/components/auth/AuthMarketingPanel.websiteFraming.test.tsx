// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}` }));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));

import { AuthMarketingPanel } from "./AuthMarketingPanel";
import { AuthShell } from "./AuthShell";
import { BUILD_FRAMING_TIMEOUT_MS, readWebsiteFraming, resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";

const GROWTH = "Meet Zavi, your AI teammate for growing your business.";
const WEBSITE = "Tell Zavi your idea. Zavi builds your website.";

let answer: () => Promise<Response>;
const fetchMock = vi.fn((_url: string) => answer());

function framing(on: boolean) {
  answer = async () =>
    ({ ok: true, status: 200, json: async () => ({ website_framing: on }) }) as Response;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelector("ul")!.querySelectorAll(":scope > li")).map((li) =>
    li.textContent?.trim(),
  );
}

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockClear();
  framing(true);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the signup panel a visitor sees after 'Sign up to build'", () => {
  it("talks about building their website, never about a growth teammate", async () => {
    const { container } = render(<AuthMarketingPanel variant="build" />);
    await settle();
    expect(screen.getByText(WEBSITE)).toBeTruthy();
    expect(screen.queryByText(GROWTH)).toBeNull();
    expect(container.textContent).not.toMatch(/grow|growth|slowing/i);
    expect(rows(container)).toEqual([
      "Builds your site from your words.",
      "Puts it live on its own address.",
      "Changes it whenever you ask in chat.",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps the copy hidden while the setting is read, so growth wording never flashes first", async () => {
    let release!: () => void;
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: async () => ({ website_framing: true }) } as Response);
      });
    const { container } = render(<AuthMarketingPanel variant="build" />);
    await settle();
    const copy = container.querySelector("h2")!.parentElement!;
    expect(copy.className).toContain("invisible");
    release();
    await settle();
    expect(copy.className).not.toContain("invisible");
    expect(screen.getByText(WEBSITE)).toBeTruthy();
  });

  it("a read that never answers gives up after the timeout, shows the website panel, and is retried next time", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      answer = () => new Promise<Response>(() => {});
      fetchMock.mockImplementation(((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }) as never);
      const { container } = render(<AuthMarketingPanel variant="build" />);
      await settle();
      const copy = container.querySelector("h2")!.parentElement!;
      expect(copy.className).toContain("invisible");
      await act(async () => {
        vi.advanceTimersByTime(BUILD_FRAMING_TIMEOUT_MS - 1);
      });
      await settle();
      expect(copy.className).toContain("invisible");
      expect(signals[0].aborted).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await settle();
      expect(signals[0].aborted).toBe(true);
      expect(copy.className).not.toContain("invisible");
      expect(screen.getByText(WEBSITE)).toBeTruthy();
      expect(screen.queryByText(GROWTH)).toBeNull();
      fetchMock.mockImplementation(((_url: string) =>
        Promise.resolve({ ok: true, status: 200, json: async () => ({ website_framing: false }) } as Response)) as never);
      await expect(readWebsiteFraming()).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockImplementation((_url: string) => answer());
      vi.useRealTimers();
    }
  });

  it("a read that answers in time clears its timer, so a late abort never fires", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      fetchMock.mockImplementation(((_url: string, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return answer();
      }) as never);
      await expect(readWebsiteFraming()).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(BUILD_FRAMING_TIMEOUT_MS * 2);
      expect(signals[0].aborted).toBe(false);
    } finally {
      fetchMock.mockImplementation((_url: string) => answer());
      vi.useRealTimers();
    }
  });

  it("shows the old growth panel when the setting is off", async () => {
    framing(false);
    const { container } = render(<AuthMarketingPanel variant="build" />);
    await settle();
    expect(screen.getByText(GROWTH)).toBeTruthy();
    expect(rows(container)).toEqual([
      "Learns how your business works.",
      "Finds what is slowing growth.",
      "Makes a clear plan and puts it to work.",
    ]);
    expect(container.querySelector("h2")!.parentElement!.className).not.toContain("invisible");
  });

  it("shows the website panel, the key's default, when the setting cannot be read", async () => {
    answer = async () => {
      throw new Error("offline");
    };
    render(<AuthMarketingPanel variant="build" />);
    await settle();
    expect(screen.getByText(WEBSITE)).toBeTruthy();
    expect(screen.queryByText(GROWTH)).toBeNull();
  });

  it("leaves the plain login panel alone and never reads the setting", async () => {
    const { container } = render(<AuthMarketingPanel />);
    await settle();
    expect(screen.getByText(GROWTH)).toBeTruthy();
    expect(container.querySelector("h2")!.parentElement!.className).not.toContain("invisible");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AuthShell hands the build variant to its panel", async () => {
    render(
      <AuthShell panelVariant="build">
        <form />
      </AuthShell>,
    );
    await settle();
    expect(screen.getByText(WEBSITE)).toBeTruthy();
    expect(screen.queryByText(GROWTH)).toBeNull();
  });
});
