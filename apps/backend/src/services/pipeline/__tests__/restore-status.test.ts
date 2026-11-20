import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRestoreStatus,
  realListDeploys,
  type RestoreStatusDeps,
} from "../restore-status";

const WANTED = "abc1234def0000000000000000000000000000ff";
const PREVIOUS = "1111111111111111111111111111111111111111";

const fetchMock = vi.fn();

function renderResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

function deploy(id: string, status: string, commit: string) {
  return { deploy: { id, status, commit: { id: commit } }, cursor: `c-${id}` };
}

function deps(over: Partial<RestoreStatusDeps> = {}): RestoreStatusDeps {
  return {
    loadHostingServiceId: async () => "srv-123",
    renderToken: () => "render-token",
    listDeploys: realListDeploys,
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRestoreStatus", () => {
  it("live: the newest deploy for the commit is serving", async () => {
    fetchMock.mockResolvedValueOnce(
      renderResponse(200, [deploy("d2", "live", WANTED), deploy("d1", "live", PREVIOUS)]),
    );
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out).toEqual({ state: "live", served_sha: WANTED, deploy_status: "live" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.render.com/v1/services/srv-123/deploys?limit=10");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer render-token");
  });

  it("failed: the commit's deploy ended in a failure status, the old commit still serves", async () => {
    fetchMock.mockResolvedValueOnce(
      renderResponse(200, [deploy("d2", "build_failed", WANTED), deploy("d1", "live", PREVIOUS)]),
    );
    const out = await getRestoreStatus("tnt-1", WANTED, deps());
    expect(out).toEqual({ state: "failed", served_sha: PREVIOUS, deploy_status: "build_failed" });
  });

  it("deploying: the commit's deploy is still in progress", async () => {
    fetchMock.mockResolvedValueOnce(
      renderResponse(200, [deploy("d2", "build_in_progress", WANTED), deploy("d1", "live", PREVIOUS)]),
    );
    const out = await getRestoreStatus("tnt-1", "ABC1234", deps());
    expect(out).toEqual({
      state: "deploying",
      served_sha: PREVIOUS,
      deploy_status: "build_in_progress",
    });
  });

  it("deploying: Render has not picked the commit up yet (no matching deploy)", async () => {
    fetchMock.mockResolvedValueOnce(renderResponse(200, [deploy("d1", "live", PREVIOUS)]));
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out).toEqual({ state: "deploying", served_sha: PREVIOUS, deploy_status: null });
  });

  it("picks the newest deploy for the commit, not an older failed retry", async () => {
    fetchMock.mockResolvedValueOnce(
      renderResponse(200, [deploy("d3", "live", WANTED), deploy("d2", "build_failed", WANTED)]),
    );
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out.state).toBe("live");
  });

  it("unknown: no provisioned hosting row, and Render is never called", async () => {
    const out = await getRestoreStatus(
      "tnt-1",
      "abc1234",
      deps({ loadHostingServiceId: async () => null }),
    );
    expect(out).toEqual({ state: "unknown", served_sha: null, deploy_status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown: no RENDER_API_KEY, and Render is never called", async () => {
    const out = await getRestoreStatus("tnt-1", "abc1234", deps({ renderToken: () => null }));
    expect(out).toEqual({ state: "unknown", served_sha: null, deploy_status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown: Render returns a non-200", async () => {
    fetchMock.mockResolvedValueOnce(renderResponse(502, { message: "bad gateway" }));
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out).toEqual({ state: "unknown", served_sha: null, deploy_status: null });
  });

  it("unknown: the network call throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out).toEqual({ state: "unknown", served_sha: null, deploy_status: null });
  });

  it("unknown: the hosting read throws", async () => {
    const out = await getRestoreStatus(
      "tnt-1",
      "abc1234",
      deps({
        loadHostingServiceId: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(out.state).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown: a malformed commit sha never reaches Render", async () => {
    const out = await getRestoreStatus("tnt-1", "not-a-sha", deps());
    expect(out.state).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates a malformed Render body (items without status are skipped)", async () => {
    fetchMock.mockResolvedValueOnce(
      renderResponse(200, [{ deploy: { id: "x" } }, null, deploy("d1", "live", WANTED)]),
    );
    const out = await getRestoreStatus("tnt-1", "abc1234", deps());
    expect(out).toEqual({ state: "live", served_sha: WANTED, deploy_status: "live" });
  });
});
