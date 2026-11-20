import { describe, it, expect, vi, beforeEach } from "vitest";

const { sbMock, setState } = vi.hoisted(() => {
  const state: { blob: Record<string, unknown>; error: boolean } = {
    blob: {},
    error: false,
  };
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = () =>
    Promise.resolve({
      data: state.error ? null : { blob: state.blob },
      error: state.error ? { message: "boom" } : null,
    });
  return {
    sbMock: vi.fn(() => builder),
    setState: (s: { blob?: Record<string, unknown>; error?: boolean }) => {
      state.blob = s.blob ?? {};
      state.error = s.error ?? false;
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: sbMock }));

import { isGoogleAdsWriteEnabled } from "../_flag-check";

beforeEach(() => setState({ blob: {} }));

describe("isGoogleAdsWriteEnabled (default ON, kill switch)", () => {
  it("ON by default when the flag is absent", async () => {
    expect(await isGoogleAdsWriteEnabled()).toBe(true);
  });

  it("ON when explicitly set to true", async () => {
    setState({ blob: { google_ads_write_enabled: true } });
    expect(await isGoogleAdsWriteEnabled()).toBe(true);
  });

  it("OFF only when explicitly set to false (kill switch)", async () => {
    setState({ blob: { google_ads_write_enabled: false } });
    expect(await isGoogleAdsWriteEnabled()).toBe(false);
  });

  it("fail-closed on a read error", async () => {
    setState({ error: true });
    expect(await isGoogleAdsWriteEnabled()).toBe(false);
  });
});
