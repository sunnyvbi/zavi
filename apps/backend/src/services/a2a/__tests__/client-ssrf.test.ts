
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: { lookup: vi.fn() },
  };
});

import { promises as dns } from "node:dns";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

import { fetchAgentCards, dispatchPeer, SsrfBlockedError } from "../client";

beforeEach(() => {
  mockLookup.mockReset();
  fetchSpy.mockReset();
});

describe("a2a/client SSRF defense", () => {
  it("fetchAgentCards refuses an IMDS-shaped peer URL (literal IP)", async () => {
    await expect(
      fetchAgentCards({
        base_url: "https://169.254.169.254",
        shared_secret: "x",
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatchPeer refuses an IMDS-shaped peer URL (literal IP)", async () => {
    await expect(
      dispatchPeer(
        { base_url: "https://169.254.169.254", shared_secret: "x" },
        { tenant_id: "t1", agent_id: "a1" },
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatchPeer refuses a hostname that resolves to a private IP", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(
      dispatchPeer(
        { base_url: "https://evil.example", shared_secret: "x" },
        { tenant_id: "t1", agent_id: "a1" },
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatchPeer refuses an http:// (non-https) peer URL", async () => {
    await expect(
      dispatchPeer(
        { base_url: "http://peer.example", shared_secret: "x" },
        { tenant_id: "t1", agent_id: "a1" },
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatchPeer passes through to fetch when peer URL resolves to a public IP", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        run_id: "r1",
        status: "success",
        parsed: null,
        output_text: "",
        cost_usd: 0,
        cost_tokens: 0,
        parse_error: null,
        error: null,
      }),
    });
    const out = await dispatchPeer(
      { base_url: "https://peer.example", shared_secret: "x" },
      { tenant_id: "t1", agent_id: "a1" },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.run_id).toBe("r1");
  });
});
