
import { describe, it, expect, vi } from "vitest";
import { withSandboxGithubToken, type RearmDeps } from "../sandbox-token-rearm";

const SANDBOX = "sbx_1";
const NODE_OPTIONS = "--max-old-space-size=6144";

function deps(over: Partial<RearmDeps> = {}) {
  return {
    resolveCreds: vi.fn(async () => ({
      kind: "resolved" as const,
      owner: "o",
      repo: "r",
      repo_full_name: "o/r",
      installation_token: "ghs_live",
      provisioned: false,
    })),
    inject: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    quarantine: vi.fn(async () => "paused"),
    ...over,
  } as RearmDeps & Record<string, ReturnType<typeof vi.fn>>;
}

describe("withSandboxGithubToken", () => {
  it("injects the token BEFORE fn and revokes AFTER it", async () => {
    const d = deps();
    const order: string[] = [];
    d.inject = vi.fn(async () => void order.push("inject"));
    d.revoke = vi.fn(async () => void order.push("revoke"));

    const out = await withSandboxGithubToken(
      "t1",
      { repo_hint: "o/r" },
      SANDBOX,
      async () => {
        order.push("fetch");
        return "pb";
      },
      d,
    );

    expect(out).toBe("pb");
    expect(order).toEqual(["inject", "fetch", "revoke"]);
  });

  it("injects GITHUB_TOKEN *and* re-states NODE_OPTIONS (setEnv rewrites the file)", async () => {
    const d = deps();
    await withSandboxGithubToken("t1", {}, SANDBOX, async () => 1, d);
    expect(d.inject).toHaveBeenCalledWith(SANDBOX, {
      GITHUB_TOKEN: "ghs_live",
      NODE_OPTIONS,
    });
    expect(d.revoke).toHaveBeenCalledWith(SANDBOX, { NODE_OPTIONS });
  });

  it("revokes even when fn THROWS (no token left behind on the error path)", async () => {
    const d = deps();
    await expect(
      withSandboxGithubToken("t1", {}, SANDBOX, async () => {
        throw new Error("fetch 128");
      }, d),
    ).rejects.toThrow("fetch 128");
    expect(d.revoke).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN when creds throw — fn still runs, and nothing is revoked", async () => {
    const d = deps({
      resolveCreds: vi.fn(async () => {
        throw new Error("no github app");
      }),
    });
    const out = await withSandboxGithubToken("t1", {}, SANDBOX, async () => "ran", d);
    expect(out).toBe("ran");
    expect(d.inject).not.toHaveBeenCalled();
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("fails OPEN on needs_pick — no inject, no revoke, fn still runs", async () => {
    const d = deps({
      resolveCreds: vi.fn(async () => ({
        kind: "needs_pick" as const,
        repos: ["o/a", "o/b"],
      })),
    });
    const out = await withSandboxGithubToken("t1", {}, SANDBOX, async () => "ran", d);
    expect(out).toBe("ran");
    expect(d.inject).not.toHaveBeenCalled();
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it("a failing re-revoke keeps the good result but quarantines the sandbox (#3474)", async () => {
    const d = deps({
      revoke: vi.fn(async () => {
        throw new Error("sandbox gone");
      }),
    });
    await expect(
      withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", d),
    ).resolves.toBe("pb");
    expect(d.quarantine).toHaveBeenCalledTimes(1);
    expect(d.quarantine).toHaveBeenCalledWith(SANDBOX, "t1", "sandbox gone");
  });

  it("a clean re-revoke never quarantines", async () => {
    const d = deps();
    await withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", d);
    expect(d.quarantine).not.toHaveBeenCalled();
  });

  it("a quarantine that itself fails never masks the caller's result", async () => {
    const d = deps({
      revoke: vi.fn(async () => {
        throw new Error("sandbox gone");
      }),
      quarantine: vi.fn(async () => {
        throw new Error("e2b down");
      }),
    });
    await expect(withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", d)).resolves.toBe("pb");
  });

  it("strictRevoke: a failing re-revoke throws, so the caller never runs repo code with the token", async () => {
    const d = deps({
      revoke: vi.fn(async () => {
        throw new Error("sandbox gone");
      }),
    });
    await expect(
      withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", { ...d, strictRevoke: true }),
    ).rejects.toThrow("sandbox gone");
    expect(d.quarantine).toHaveBeenCalledTimes(1);
  });

  it("strictRevoke: a failed token inject scrubs the box again and throws before fn runs", async () => {
    const d = deps({ inject: vi.fn(async () => { throw new Error("setEnv half-written"); }) });
    const fn = vi.fn(async () => "pb");
    await expect(
      withSandboxGithubToken("t1", {}, SANDBOX, fn, { ...d, strictRevoke: true }),
    ).rejects.toThrow("setEnv half-written");
    expect(d.revoke).toHaveBeenCalledWith(SANDBOX, { NODE_OPTIONS });
    expect(fn).not.toHaveBeenCalled();
  });

  it("strictRevoke: when that scrub fails too, it throws and fn never runs", async () => {
    const d = deps({
      inject: vi.fn(async () => { throw new Error("setEnv failed"); }),
      revoke: vi.fn(async () => { throw new Error("sandbox gone"); }),
    });
    const fn = vi.fn(async () => "pb");
    await expect(withSandboxGithubToken("t1", {}, SANDBOX, fn, { ...d, strictRevoke: true })).rejects.toThrow("sandbox gone");
    expect(fn).not.toHaveBeenCalled();
    expect(d.quarantine).toHaveBeenCalledTimes(1);
  });

  it("non-strict: a failed inject is scrubbed (it may have written the token), then fn still runs", async () => {
    const d = deps({ inject: vi.fn(async () => { throw new Error("setEnv failed"); }) });
    await expect(withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", d)).resolves.toBe("pb");
    expect(d.revoke).toHaveBeenCalledTimes(1);
    expect(d.quarantine).not.toHaveBeenCalled();
  });

  it("non-strict: a failed inject whose scrub fails quarantines the sandbox", async () => {
    const d = deps({
      inject: vi.fn(async () => { throw new Error("setEnv failed"); }),
      revoke: vi.fn(async () => { throw new Error("scrub exit 3"); }),
    });
    await expect(withSandboxGithubToken("t1", {}, SANDBOX, async () => "pb", d)).resolves.toBe("pb");
    expect(d.quarantine).toHaveBeenCalledWith(SANDBOX, "t1", "scrub exit 3");
  });
});
