import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePlanStage } from "../posthog";

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockClear();
});

function sent(): { url: string; body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> } } {
  const [url, init] = fetchMock.mock.calls[0];
  return { url, body: JSON.parse(init.body as string) };
}

describe("capturePlanStage", () => {
  it("sends nothing until the project key is set", () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("POSTHOG_PROJECT_KEY", "");
    capturePlanStage("tenant-1", "run-1", "model", 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one stage under the tenant, with no person profile", async () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    capturePlanStage("tenant-1", "run-1", "model", 1000, { outcome: "ok", first_plan: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const { url, body } = sent();
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(body).toMatchObject({ api_key: "phc_test", event: "plan_build_stage", distinct_id: "tenant-1" });
    expect(body.properties).toEqual({
      stage: "model",
      ms: 1000,
      tenant_id: "tenant-1",
      run_id: "run-1",
      is_internal: false,
      outcome: "ok",
      first_plan: true,
      $process_person_profile: false,
    });
  });

  it("flags our own tenants so a query can leave them out", async () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    capturePlanStage("73db45ff-457e-4541-bc8f-bdb625390204", null, "research", 5);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(sent().body.properties).toMatchObject({ is_internal: true, run_id: null });
  });

  it("only warns when PostHog is down or refuses the event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(() => capturePlanStage("tenant-1", "run-1", "model", 1)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[posthog] plan_build_stage failed: TypeError"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    capturePlanStage("tenant-1", "run-1", "model", 1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[posthog] plan_build_stage failed: 401"));
  });
});
