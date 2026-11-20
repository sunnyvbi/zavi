import { describe, it, expect, vi, beforeEach } from "vitest";

const blobHolder: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: null,
  error: null,
};

vi.mock("@/services/supabase", () => {
  const q: Record<string, (...a: unknown[]) => unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => ({
      data: blobHolder.blob === null ? null : { blob: blobHolder.blob },
      error: blobHolder.error,
    }),
  };
  return { serviceClient: () => ({ from: () => q }) };
});

import { isEngineerLargeDiffAllowlisted } from "../engineer-large-diff-allowlist";
import {
  DEFAULT_BUILDER_CAPS,
  OPERATOR_OPT_IN_BUILDER_CAPS,
} from "@/services/pr-builder/from-sandbox-fs";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

beforeEach(() => {
  blobHolder.blob = null;
  blobHolder.error = null;
});

describe("engineer large-diff allowlist → cap tier selection", () => {
  it("(a) tenant NOT in allowlist → DEFAULT caps (5000 lines)", async () => {
    blobHolder.blob = { engineer_large_diff_allowlist: ["some-other-tenant"] };
    const allowed = await isEngineerLargeDiffAllowlisted(TENANT);
    expect(allowed).toBe(false);
    const caps = allowed ? OPERATOR_OPT_IN_BUILDER_CAPS : DEFAULT_BUILDER_CAPS;
    expect(caps).toBe(DEFAULT_BUILDER_CAPS);
    expect(caps.maxChangedLines).toBe(5000);
  });

  it("(b) tenant IN allowlist → OPERATOR_OPT_IN XL caps (15000 lines)", async () => {
    blobHolder.blob = {
      engineer_large_diff_allowlist: ["x", TENANT, "y"],
    };
    const allowed = await isEngineerLargeDiffAllowlisted(TENANT);
    expect(allowed).toBe(true);
    const caps = allowed ? OPERATOR_OPT_IN_BUILDER_CAPS : DEFAULT_BUILDER_CAPS;
    expect(caps).toBe(OPERATOR_OPT_IN_BUILDER_CAPS);
    expect(caps.maxChangedLines).toBe(15000);
  });

  it("(c) flag absent entirely → DEFAULT caps (default behavior preserved)", async () => {
    blobHolder.blob = {};
    const allowed = await isEngineerLargeDiffAllowlisted(TENANT);
    expect(allowed).toBe(false);
    const caps = allowed ? OPERATOR_OPT_IN_BUILDER_CAPS : DEFAULT_BUILDER_CAPS;
    expect(caps).toBe(DEFAULT_BUILDER_CAPS);
    expect(caps.maxChangedLines).toBe(5000);
  });

  it("(c') system_config row missing → DEFAULT caps (soft-fail closed)", async () => {
    blobHolder.blob = null;
    expect(await isEngineerLargeDiffAllowlisted(TENANT)).toBe(false);
  });

  it("(c'') system_config read error → DEFAULT caps (soft-fail closed)", async () => {
    blobHolder.blob = { engineer_large_diff_allowlist: [TENANT] };
    blobHolder.error = { message: "boom" };
    expect(await isEngineerLargeDiffAllowlisted(TENANT)).toBe(false);
  });

  it("non-array allowlist value is ignored → DEFAULT caps", async () => {
    blobHolder.blob = { engineer_large_diff_allowlist: "not-an-array" };
    expect(await isEngineerLargeDiffAllowlisted(TENANT)).toBe(false);
  });

  it("tier ordering: DEFAULT < OPERATOR_OPT_IN on every dimension", () => {
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxChangedLines).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.maxChangedLines,
    );
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.diffByteCap).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.diffByteCap,
    );
    expect(OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes).toBeGreaterThan(
      DEFAULT_BUILDER_CAPS.maxPostImageBytes,
    );
  });
});
