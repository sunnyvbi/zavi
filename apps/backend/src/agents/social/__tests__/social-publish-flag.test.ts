import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.error
              ? { data: null, error: state.error }
              : { data: state.blob === null ? null : { blob: state.blob }, error: null },
        }),
      }),
    }),
  }),
}));

import { isSocialPublishEnabled } from "../social-publish-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isSocialPublishEnabled — default ON unless explicitly paused", () => {
  it("absent key → ON (the default)", async () => {
    state.blob = {};
    expect(await isSocialPublishEnabled()).toBe(true);
  });

  it("the OLD key is inert — prod's stale social_publish_enabled:false no longer pauses", async () => {
    state.blob = { social_publish_enabled: false };
    expect(await isSocialPublishEnabled()).toBe(true);
  });

  it("social_publish_paused: true → OFF (the one-row kill switch)", async () => {
    state.blob = { social_publish_paused: true };
    expect(await isSocialPublishEnabled()).toBe(false);
  });

  it("a non-boolean pause value is not a pause (strict === true)", async () => {
    state.blob = { social_publish_paused: "true" };
    expect(await isSocialPublishEnabled()).toBe(true);
  });

  it("system_config read error → OFF (outage fails safe)", async () => {
    state.error = { message: "pooler down" };
    expect(await isSocialPublishEnabled()).toBe(false);
  });

  it("no system_config row at all → ON (absent key)", async () => {
    state.blob = null;
    expect(await isSocialPublishEnabled()).toBe(true);
  });
});
