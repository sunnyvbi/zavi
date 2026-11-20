
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  from: vi.fn(),
  serviceClient: vi.fn(),
}));

m.from.mockImplementation(() => ({ createSignedUrl: m.createSignedUrl }));
m.serviceClient.mockImplementation(() => ({ storage: { from: m.from } }));

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}) },
}));
vi.mock("@/services/connectors/pipedream/api", () => ({
  runAction: vi.fn(),
  verifyAccountOwned: vi.fn(),
}));

import { resolveMediaProps } from "../social-publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "e0fe9ea8-0000-4000-8000-000000000000";
const PATH = `${TENANT}/8f14e45f-ceea-467a-a2f4-1d2c3b4a5e6f.jpg`;

beforeEach(() => {
  m.createSignedUrl.mockReset();
  m.from.mockClear();
  m.createSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://sb.example/signed?token=abc" },
    error: null,
  });
});

describe("resolveMediaProps", () => {
  it("swaps the frozen path for a freshly-signed URL, leaving other props alone", async () => {
    const out = await resolveMediaProps(TENANT, "file", {
      file: PATH,
      text: "hi",
      visibility: "PUBLIC",
    });
    expect(out).toEqual({
      file: "https://sb.example/signed?token=abc",
      text: "hi",
      visibility: "PUBLIC",
    });
    expect(m.from).toHaveBeenCalledWith("agent-chat-images");
  });

  it("does not mutate the caller's props object (the frozen row stays a path)", async () => {
    const props = { file: PATH, text: "hi" };
    await resolveMediaProps(TENANT, "file", props);
    expect(props.file).toBe(PATH);
  });

  it("REFUSES a path belonging to another tenant", async () => {
    await expect(
      resolveMediaProps(TENANT, "file", {
        file: `${OTHER}/8f14e45f-ceea-467a-a2f4-1d2c3b4a5e6f.jpg`,
      }),
    ).rejects.toThrow(/not owned by tenant/);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("REFUSES a path that merely contains the tenant id later in the string", async () => {
    await expect(
      resolveMediaProps(TENANT, "file", { file: `evil/${TENANT}/x.jpg` }),
    ).rejects.toThrow(/not owned by tenant/);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("REFUSES a value that is already a URL — signing is the only way media ships", async () => {
    await expect(
      resolveMediaProps(TENANT, "file", { file: "https://evil.example/x.jpg" }),
    ).rejects.toThrow(/only storage paths are publishable/);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("REFUSES a missing or non-string media prop", async () => {
    await expect(resolveMediaProps(TENANT, "file", {})).rejects.toThrow(/missing or not a string/);
    await expect(resolveMediaProps(TENANT, "file", { file: 42 })).rejects.toThrow(
      /missing or not a string/,
    );
  });

  it("surfaces a signing failure rather than publishing without media", async () => {
    m.createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    await expect(resolveMediaProps(TENANT, "file", { file: PATH })).rejects.toThrow(
      /could not sign media path: Object not found/,
    );
  });
});
