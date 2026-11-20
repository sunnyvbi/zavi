// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  useLiveAppUrl,
  __resetLiveAppUrlCache,
  LIVE_APP_URL_TTL_MS,
  LIVE_APP_URL_RETRY_MS,
} from "./useLiveAppUrl";

const LIVE = "https://upcarai-6ec4d609.onrender.com";

const answers = { url: null as string | null };

function Probe() {
  const live = useLiveAppUrl(true);
  return <span data-testid="url">{live?.url ?? "none"}</span>;
}

const shown = (root: HTMLElement) => root.querySelector('[data-testid="url"]')!.textContent;

async function mount() {
  const view = render(<Probe />);
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
  return view;
}

const ok = (url: string | null) => ({
  ok: true,
  status: 200,
  json: async () => ({ preview: url ? { url, kind: "final" } : { url: null, kind: "none" } }),
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
  __resetLiveAppUrlCache();
  apiFetch.mockReset();
  answers.url = null;
  apiFetch.mockImplementation(async () => ok(answers.url));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLiveAppUrl", () => {
  it("answers every card in the thread from one read", async () => {
    answers.url = LIVE;
    const a = await mount();
    const b = await mount();
    expect(shown(a.container as HTMLElement)).toBe(LIVE);
    expect(shown(b.container as HTMLElement)).toBe(LIVE);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask while the answer is still fresh", async () => {
    answers.url = LIVE;
    await mount();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_APP_URL_TTL_MS - 1);
    });
    await mount();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("shows an app that went live LATER in the same session", async () => {
    await mount();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    answers.url = LIVE;
    await act(async () => {
      vi.advanceTimersByTime(LIVE_APP_URL_TTL_MS + 1);
    });
    const later = await mount();

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(shown(later.container as HTMLElement)).toBe(LIVE);
  });

  it("never lets ONE failed read suppress the card for the rest of the session", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const first = await mount();
    expect(shown(first.container as HTMLElement)).toBe("none");

    answers.url = LIVE;
    await act(async () => {
      vi.advanceTimersByTime(LIVE_APP_URL_RETRY_MS + 1);
    });
    const second = await mount();

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(shown(second.container as HTMLElement)).toBe(LIVE);
  });

  it("does not hammer the endpoint while a failure is still recent", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_APP_URL_RETRY_MS - 1);
    });
    await mount();
    await mount();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("caches a truthful 'not live' too, so a workspace with no app costs one read", async () => {
    const view = await mount();
    expect(shown(view.container as HTMLElement)).toBe("none");
    await mount();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("caches per thread: site A's answer is never reused for site B's chat", async () => {
    const TA = "d0000000-0000-4000-8000-0000000000a1";
    const TB = "d0000000-0000-4000-8000-0000000000b1";
    apiFetch.mockImplementation(async (path: string) =>
      ok(path.includes(TA) ? "https://alpha.zaviagent.com" : "https://beta.zaviagent.com"),
    );
    function ThreadProbe({ id }: { id: string }) {
      const live = useLiveAppUrl(true, id);
      return <span data-testid="url">{live?.url ?? "none"}</span>;
    }
    const a = render(<ThreadProbe id={TA} />);
    const b = render(<ThreadProbe id={TB} />);
    const a2 = render(<ThreadProbe id={TA} />);
    await act(async () => {
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });
    expect(shown(a.container as HTMLElement)).toBe("https://alpha.zaviagent.com");
    expect(shown(a2.container as HTMLElement)).toBe("https://alpha.zaviagent.com");
    expect(shown(b.container as HTMLElement)).toBe("https://beta.zaviagent.com");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a later reply re-asks: an unbound thread adopted by a site is not stuck on the workspace app", async () => {
    const T = "d0000000-0000-4000-8000-0000000000c1";
    let bound = false;
    apiFetch.mockImplementation(async () => ok(bound ? "https://alpha.zaviagent.com" : LIVE));
    function ReplyProbe({ run }: { run: string }) {
      const live = useLiveAppUrl(true, T, run);
      return <span data-testid="url">{live?.url ?? "none"}</span>;
    }
    const first = render(<ReplyProbe run="run-1" />);
    await act(async () => {
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });
    expect(shown(first.container as HTMLElement)).toBe(LIVE);
    bound = true;
    const second = render(<ReplyProbe run="run-2" />);
    await act(async () => {
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });
    expect(shown(second.container as HTMLElement)).toBe("https://alpha.zaviagent.com");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("drops an answer that lands after a sign-out reset", async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const view = render(<Probe />);
    __resetLiveAppUrlCache();
    await act(async () => {
      release(ok(LIVE));
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });
    expect(shown(view.container as HTMLElement)).toBe("none");
  });

  it("keeps a mounted card subscribed across a cache reset", async () => {
    answers.url = LIVE;
    const view = await mount();
    expect(shown(view.container as HTMLElement)).toBe(LIVE);

    __resetLiveAppUrlCache();
    answers.url = null;

    await act(async () => {
      await mount();
    });

    expect(shown(view.container as HTMLElement)).toBe("none");
  });
});
