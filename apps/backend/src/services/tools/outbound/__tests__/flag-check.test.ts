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

import { isOutboundEmailProducerEnabled } from "../_flag-check";

beforeEach(() => setState({ blob: {} }));

describe("isOutboundEmailProducerEnabled (default ON, kill switch + optional allowlist)", () => {
  it("ON by default when flag absent and no allowlist", async () => {
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(true);
  });

  it("OFF fleet-wide when explicitly set to false (kill switch)", async () => {
    setState({ blob: { outbound_email_producer_enabled: false } });
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(false);
  });

  it("restricts to listed tenants when allowlist is non-empty", async () => {
    setState({ blob: { outbound_email_producer_tenants: ["t9"] } });
    expect(await isOutboundEmailProducerEnabled("t9")).toBe(true);
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(false);
  });

  it("empty allowlist ⇒ available to all (default-on)", async () => {
    setState({ blob: { outbound_email_producer_tenants: [] } });
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(true);
  });

  it("kill switch wins even with the tenant allowlisted", async () => {
    setState({
      blob: {
        outbound_email_producer_enabled: false,
        outbound_email_producer_tenants: ["t1"],
      },
    });
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(false);
  });

  it("fail-closed on a read error", async () => {
    setState({ error: true });
    expect(await isOutboundEmailProducerEnabled("t1")).toBe(false);
  });

  it("false for an empty tenant id", async () => {
    expect(await isOutboundEmailProducerEnabled("")).toBe(false);
  });
});
