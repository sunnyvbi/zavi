import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}` }));

import {
  BUILD_FRAMING_TIMEOUT_MS,
  readChatToastNamed,
  readCookieClearOfComposer,
  readHomeBuildCta,
  readIdeaAttach,
  readIdeaExamples,
  readSiteListFirst,
  readWebsiteFraming,
  resetWebsiteFramingForTests,
} from "./buildFraming";

const fetchMock = vi.fn();

async function readAll() {
  return Promise.all([
    readWebsiteFraming(),
    readIdeaExamples(),
    readIdeaAttach(),
    readChatToastNamed(),
    readSiteListFirst(),
    readHomeBuildCta(),
    readCookieClearOfComposer(),
  ]);
}

const ALL_ON = [true, true, true, true, true, true, true];

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("build-framing flags fall back to their defaults, never off", () => {
  it("a network error gives every flag its default (on)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await readAll()).toEqual(ALL_ON);
  });

  it("a 5xx gives every flag its default (on)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await readAll()).toEqual(ALL_ON);
  });

  it("a body that is not JSON gives every flag its default (on)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    expect(await readAll()).toEqual(ALL_ON);
  });

  it("a read that hangs past the cap and ignores the abort still answers the defaults at the cap", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    let answered: boolean[] | null = null;
    void readAll().then((v) => {
      answered = v;
    });
    await vi.advanceTimersByTimeAsync(BUILD_FRAMING_TIMEOUT_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toEqual(ALL_ON);
  });

  it("a read that hangs aborts its request at the cap", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    void readWebsiteFraming();
    await vi.advanceTimersByTimeAsync(BUILD_FRAMING_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
  });

  it("a key missing from the answer takes its default, while an explicit false still turns its own flag off", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ chat_toast_named: false, website_framing: "yes" }),
    });
    expect(await readAll()).toEqual([true, true, true, false, true, true, true]);
  });

  it("a failed read is not remembered: the next read asks again and takes the real answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await readSiteListFirst()).toBe(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ site_list_first: false }) });
    expect(await readSiteListFirst()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("build_flags_fail_to_default off is honoured on the web too", () => {
  const ALL_OFF = [false, false, false, false, false, false, false];
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
      },
    });
  });

  const answer = (failToDefault: boolean) => ({
    ok: true,
    status: 200,
    json: async () => ({
      website_framing: true,
      idea_examples: true,
      idea_attach: true,
      chat_toast_named: true,
      site_list_first: true,
      home_build_cta: true,
      cookie_clear_of_composer: true,
      fail_to_default: failToDefault,
    }),
  });

  it("a read that says the switch is off is remembered, so a later failed read turns every flag off", async () => {
    fetchMock.mockResolvedValueOnce(answer(false));
    expect(await readAll()).toEqual(ALL_ON);
    resetWebsiteFramingForTests();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await readAll()).toEqual(ALL_OFF);
  });

  it("a read that says the switch is on keeps the failed-read fallback at the defaults", async () => {
    fetchMock.mockResolvedValueOnce(answer(true));
    await readAll();
    resetWebsiteFramingForTests();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect(await readAll()).toEqual(ALL_ON);
  });

  it("a page that never read the switch, and has none stored, falls back to the defaults", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await readAll()).toEqual(ALL_ON);
  });
});
