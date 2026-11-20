import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { START_CARD_DONE_FIXTURE } from "@zavi/shared";
import type { StartCardState } from "./useStartCard";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";
import { emailStartCard, startCardEmailTarget, START_CARD_EMAIL_TIMEOUT_MS } from "./startCardEmail";

const request = vi.mocked(apiFetch);

beforeEach(() => {
  request.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startCardEmailTarget", () => {
  it.each<StartCardState>([
    { phase: "captcha", domain: "acme.com" },
    { phase: "creating", domain: "acme.com" },
    { phase: "queued", domain: "acme.com" },
  ])("keeps the site before a card exists in $phase", (state) => {
    expect(startCardEmailTarget(state)).toEqual({ startCardSite: "acme.com" });
  });

  it("keeps an existing card reference", () => {
    const publicId = START_CARD_DONE_FIXTURE.public_id;
    expect(startCardEmailTarget({ phase: "card", domain: "acme.com", publicId, card: null, stalled: false }))
      .toEqual({ startCardId: publicId });
  });

  it.each<StartCardState>([{ phase: "idle" }, { phase: "error", domain: "acme.com", message: "unavailable" }])(
    "does not request delivery for $phase",
    (state) => expect(startCardEmailTarget(state)).toEqual({}),
  );
});

describe("emailStartCard", () => {
  it("prefers the existing card and clears its deadline on success", async () => {
    request.mockResolvedValue(new Response());
    await emailStartCard({ startCardId: START_CARD_DONE_FIXTURE.public_id, startCardSite: "acme.com" });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ public_id: START_CARD_DONE_FIXTURE.public_id });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the site when no usable card reference exists", async () => {
    request.mockResolvedValue(new Response());
    await emailStartCard({ startCardId: "invalid", startCardSite: "acme.com" });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ url: "acme.com" });
  });

  it("does not issue a request without a delivery target", async () => {
    await emailStartCard({});
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases onboarding even if a stalled request ignores cancellation", async () => {
    request.mockReturnValue(new Promise<Response>(() => {}));
    const done = vi.fn();
    const delivery = emailStartCard({ startCardSite: "acme.com" }).then(done);
    await vi.advanceTimersByTimeAsync(START_CARD_EMAIL_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await delivery;
    expect(done).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(request.mock.calls[0][1]?.retryOnNetworkError).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("absorbs a request failure and clears its deadline", async () => {
    request.mockRejectedValue(new Error("offline"));
    await expect(emailStartCard({ startCardSite: "acme.com" })).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
