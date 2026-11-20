import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn(async () => {
    throw new Error("callModel should not be reached for a deterministic pick");
  }),
}));
vi.mock("@/services/llm/models", () => ({
  DEFAULT_PROVIDER: "anthropic",
  MODELS: { anthropic: { haiku: "claude-haiku-test" } },
}));

const readReadyProfilesMock = vi.fn();
const readTenantDefaultRepoMock = vi.fn(async () => null as string | null);
vi.mock("@/services/sandbox/repo-profiles", () => ({
  readReadyProfiles: (...args: unknown[]) => readReadyProfilesMock(...args),
  readTenantDefaultRepo: (...args: unknown[]) =>
    readTenantDefaultRepoMock(...(args as [])),
}));

import { pickRepoForTask, classifyTaskPlatform } from "../repo-picker";

type Prof = {
  repo_full_name: string;
  kind: string;
  kinds: string[];
  language_stats: Record<string, number>;
  frameworks: string[];
  topics: string[];
  description: string | null;
  default_branch: string | null;
  manifest_paths: string[];
  profile_status: "ready";
};
const prof = (repo: string, kind: string, kinds?: string[]): Prof => ({
  repo_full_name: repo,
  kind,
  kinds: kinds ?? [kind],
  language_stats: {},
  frameworks: [],
  topics: [],
  description: null,
  default_branch: "main",
  manifest_paths: [],
  profile_status: "ready",
});

const TENANT = "t-1";
const UPCAR_PROFILES = [
  prof("rravi149/OraiCar", "ios"),
  prof("rravi149/OraiCarAndroid", "android"),
  prof("rravi149/upcar", "web"),
];
const UPCAR_REPOS = UPCAR_PROFILES.map((p) => p.repo_full_name);

describe("repo-picker — profile-driven deterministic routing", () => {
  it("web task → the web-kind repo (by profile, not name)", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(UPCAR_PROFILES);
    const r = await pickRepoForTask({
      task_description: "add a banner to the web app",
      repos: UPCAR_REPOS,
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "rravi149/upcar" });
  });

  it("iOS task → the ios-kind repo", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(UPCAR_PROFILES);
    const r = await pickRepoForTask({
      task_description: "fix the SwiftUI banner",
      repos: UPCAR_REPOS,
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "rravi149/OraiCar" });
  });

  it("Android task → the android-kind repo", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(UPCAR_PROFILES);
    const r = await pickRepoForTask({
      task_description: "fix the Kotlin Compose banner",
      repos: UPCAR_REPOS,
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "rravi149/OraiCarAndroid" });
  });

  it("generalizes: a Swift repo named 'acme-mobile' routes by profile kind, not name", async () => {
    const acme = [prof("acme/acme-mobile", "ios"), prof("acme/acme-api", "backend")];
    readReadyProfilesMock.mockResolvedValueOnce(acme);
    const r = await pickRepoForTask({
      task_description: "fix the SwiftUI login screen in the iOS app",
      repos: acme.map((p) => p.repo_full_name),
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "acme/acme-mobile" });
  });

  it("backend task → the backend-kind repo (acme)", async () => {
    const acme = [prof("acme/acme-mobile", "ios"), prof("acme/acme-api", "backend")];
    readReadyProfilesMock.mockResolvedValueOnce(acme);
    const r = await pickRepoForTask({
      task_description: "fix the API endpoint that returns 500",
      repos: acme.map((p) => p.repo_full_name),
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "acme/acme-api" });
  });

  it("ambiguous (no platform word) → ask fallback, never a wrong pick", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(UPCAR_PROFILES);
    const r = await pickRepoForTask({
      task_description: "improve the thing",
      repos: UPCAR_REPOS,
      tenant_id: TENANT,
    });
    expect(r.decision).toBe("ask");
  });

  it("two web repos + a web task → ASK (kind doesn't distinguish them)", async () => {
    const twoWeb = [prof("acme/site", "web"), prof("acme/admin", "web")];
    readReadyProfilesMock.mockResolvedValueOnce(twoWeb);
    const r = await pickRepoForTask({
      task_description: "fix the homepage",
      repos: twoWeb.map((p) => p.repo_full_name),
      tenant_id: TENANT,
    });
    expect(r.decision).toBe("ask");
  });

  it("multi-platform mention (web + iOS) → not deterministic (ask fallback)", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(UPCAR_PROFILES);
    const r = await pickRepoForTask({
      task_description: "fix the web app and the iOS app",
      repos: UPCAR_REPOS,
      tenant_id: TENANT,
    });
    expect(r.decision).toBe("ask");
  });

  it("un-profiled repos (<2 ready profiles) → no deterministic pick → ask fallback", async () => {
    readReadyProfilesMock.mockResolvedValueOnce([prof("acme/site", "web")]);
    const r = await pickRepoForTask({
      task_description: "fix the homepage",
      repos: ["acme/site", "acme/api"],
      tenant_id: TENANT,
    });
    expect(r.decision).toBe("ask");
  });

  it("single connected repo short-circuits to pick (no profile read needed)", async () => {
    const r = await pickRepoForTask({
      task_description: "anything",
      repos: ["rravi149/upcar"],
      tenant_id: TENANT,
    });
    expect(r).toEqual({ decision: "pick", repo: "rravi149/upcar" });
  });
});

describe("classifyTaskPlatform — single-platform keyword detection", () => {
  it("detects ios / android / web / backend singly", () => {
    expect(classifyTaskPlatform("fix the SwiftUI view")).toBe("ios");
    expect(classifyTaskPlatform("update the Kotlin compose screen")).toBe("android");
    expect(classifyTaskPlatform("change the dashboard frontend")).toBe("web");
    expect(classifyTaskPlatform("add a database migration to the api")).toBe("backend");
  });
  it("returns null when 0 or 2+ platforms are named", () => {
    expect(classifyTaskPlatform("improve the thing")).toBeNull();
    expect(classifyTaskPlatform("fix the web app and the iOS app")).toBeNull();
  });
});
