import { describe, it, expect, vi } from "vitest";
import {
  HarnessFailure,
  classifyFailureOrigin,
  parsePromptSnapshot,
  preflightInstrumentSelfTest,
  withBenchSandbox,
  type BenchSandboxDeps,
} from "../shadow-harness";

const SHA = "a".repeat(40);

function deps(over: Partial<BenchSandboxDeps> = {}): BenchSandboxDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    createShadowSandboxForRun: vi.fn(async () => {
      order.push("create");
      return { sandbox_id: "sbx-1", repo_full_name: "o/r" };
    }),
    destroyShadowSandbox: vi.fn(async (id) => {
      order.push(`destroy:${id}`);
    }),
    execCommand: vi.fn(async () => {
      order.push("checkout");
      return { exit_code: 0, stdout: `${SHA}\n`, stderr: "" };
    }),
    revokeSandboxGithubToken: vi.fn(async () => {
      order.push("revoke");
    }),
    ...over,
  };
}

describe("shared harness: failure attribution", () => {
  it("HarnessFailure is always ours", () => {
    expect(classifyFailureOrigin(new HarnessFailure("x"), "openai")).toBe("harness");
  });
  it("model-behavior errors count against the model", () => {
    const e = Object.assign(new Error("bad tool input"), { name: "ModelBehaviorError" });
    expect(classifyFailureOrigin(e, "openai")).toBe("model");
  });
  it("a local module fault is ours", () => {
    expect(classifyFailureOrigin(new Error("Cannot find module 'x'"), "openai")).toBe("harness");
  });
  it("rate limits are neither (unknown)", () => {
    const e = Object.assign(new Error("slow down"), { status: 429 });
    expect(classifyFailureOrigin(e, "openai")).toBe("unknown");
  });
});

describe("shared harness: prompt snapshot", () => {
  it("round-trips the live format and refuses ambiguity", () => {
    const s = "--- system ---\nSYS\n\n--- initial user ---\nASK";
    expect(parsePromptSnapshot(s, false)).toEqual({ system: "SYS", initial_user: "ASK" });
    expect(parsePromptSnapshot(s + "\n\n--- initial user ---\nX", false)).toBeNull();
    expect(parsePromptSnapshot("--- system ---\nSYS", false)).toBeNull();
  });
});

describe("shared harness: instrument self-test", () => {
  it("throws HarnessFailure on a rejected request shape and merges extraBody", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("nope", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      preflightInstrumentSelfTest({
        label: "openrouter",
        baseURL: "https://x/api/v1",
        apiKey: "k",
        model: "m/x",
        extraBody: { provider: { order: ["P"] } },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HarnessFailure);
    expect((bodies[0] as { provider: unknown }).provider).toEqual({ order: ["P"] });
  });
});

describe("shared harness: bench engineer sandbox", () => {
  it("checks out the pinned sha and scrubs the credential BEFORE the model gets the box, then destroys it", async () => {
    const d = deps();
    const out = await withBenchSandbox(
      d,
      { run_id: "r", tenant_id: "t", payload: {}, pinned_sha: SHA },
      async (h) => {
        d.order.push(`run:${h.sandbox_id}`);
        return 7;
      },
    );
    expect(out).toBe(7);
    expect(d.order).toEqual(["create", "checkout", "revoke", "run:sbx-1", "destroy:sbx-1"]);
  });

  it("destroys the box even when the trial throws", async () => {
    const d = deps();
    await expect(
      withBenchSandbox(d, { run_id: "r", tenant_id: "t", payload: {}, pinned_sha: SHA }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(d.order.at(-1)).toBe("destroy:sbx-1");
  });

  it("refuses a non-sha pin before provisioning anything", async () => {
    const d = deps();
    await expect(
      withBenchSandbox(d, { run_id: "r", tenant_id: "t", payload: {}, pinned_sha: "main; rm -rf /" }, async () => 1),
    ).rejects.toBeInstanceOf(HarnessFailure);
    expect(d.createShadowSandboxForRun).not.toHaveBeenCalled();
  });

  it("a failed checkout is a harness failure and the model never runs", async () => {
    const run = vi.fn();
    const d = deps({ execCommand: vi.fn(async () => ({ exit_code: 128, stdout: "", stderr: "bad" })) });
    await expect(
      withBenchSandbox(d, { run_id: "r", tenant_id: "t", payload: {}, pinned_sha: SHA }, run),
    ).rejects.toBeInstanceOf(HarnessFailure);
    expect(run).not.toHaveBeenCalled();
    expect(d.revokeSandboxGithubToken).not.toHaveBeenCalled();
  });
});
