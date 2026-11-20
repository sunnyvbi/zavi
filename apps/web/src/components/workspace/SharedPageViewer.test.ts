import { afterEach, describe, expect, it, vi } from "vitest";
import { embedderBlocksFrameNavigation } from "./SharedPageViewer";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const serve = (csp: string | null) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ headers: { get: () => csp } })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedderBlocksFrameNavigation", () => {
  it("is true only when the response carries frame-src 'none'", async () => {
    serve("frame-ancestors 'none'; frame-src 'none'");
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(true);
    serve("frame-ancestors 'none'");
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(false);
    serve("frame-ancestors 'none', frame-src 'none'");
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(true);
    serve("frame-src 'none' https://x.example");
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(false);
    serve(null);
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(false);
  });

  it("fails closed when the check itself errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await embedderBlocksFrameNavigation("/pages/x")).toBe(false);
  });
});
