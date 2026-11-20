
import { describe, expect, it, vi } from "vitest";

import { ExpectedToolError } from "@/services/tools/types";

import {
  assertDependencyAdmission,
  checkRegistry,
  extractDependencies,
  isExactPin,
  type RepoFileRead,
  lockSyncFailures,
  resolveLockEntry,
  MIN_PACKAGE_AGE_DAYS,
  MIN_WEEKLY_DOWNLOADS,
  siblingLockPath,
} from "../dependency-admission";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function fakeRegistry(
  pkgs: Record<string, { created?: string; downloads?: number; status?: number }>,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const isDownloads = u.includes("api.npmjs.org/downloads");
    const name = decodeURIComponent(u.split("/").slice(isDownloads ? 6 : 3).join("/"));
    const entry = pkgs[name];
    if (!entry || entry.status === 404) {
      return new Response("Not found", { status: 404 });
    }
    if (entry.status && entry.status !== 200) {
      return new Response("err", { status: entry.status });
    }
    if (isDownloads) {
      return new Response(JSON.stringify({ downloads: entry.downloads ?? 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ time: { created: entry.created ?? daysAgo(999) } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

const pkgFileNoLock = (deps: Record<string, string>, dev: Record<string, string> = {}) => [
  {
    path: "package.json",
    action: "modify",
    content: JSON.stringify({ dependencies: deps, devDependencies: dev }),
  },
];

const lockFor = (
  deps: Record<string, string>,
  dev: Record<string, string> = {},
  path = "package-lock.json",
) => ({
  path,
  action: "modify",
  content: JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: deps, devDependencies: dev },
      ...Object.fromEntries(
        Object.entries({ ...deps, ...dev }).map(([n, v]) => [`node_modules/${n}`, { version: v }]),
      ),
    },
  }),
});

const pkgFile = (deps: Record<string, string>, dev: Record<string, string> = {}) => [
  ...pkgFileNoLock(deps, dev),
  lockFor(deps, dev),
];

describe("isExactPin", () => {
  it("accepts exact versions only", () => {
    expect(isExactPin("1.2.3")).toBe(true);
    expect(isExactPin("14.2.35")).toBe(true);
    expect(isExactPin("2.0.0-beta.1")).toBe(true);
  });

  it("rejects every mutable or remote spec", () => {
    for (const bad of [
      "^1.2.3",
      "~1.2.3",
      ">=1.0.0",
      "1.x",
      "*",
      "latest",
      "next",
      "git+https://github.com/evil/pkg.git",
      "http://evil.example/pkg.tgz",
      "file:../pkg",
      "npm:other-pkg@1.0.0",
    ]) {
      expect(isExactPin(bad), bad).toBe(false);
    }
  });
});

describe("extractDependencies", () => {
  it("covers both dependency blocks", () => {
    expect(extractDependencies({ dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } })).toEqual([
      ["a", "1.0.0"],
      ["b", "2.0.0"],
    ]);
  });

  it("tolerates missing blocks", () => {
    expect(extractDependencies({})).toEqual([]);
  });
});

describe("checkRegistry", () => {
  it("REJECTS a hallucinated package (404) — the pure slopsquat precursor", async () => {
    const fetchImpl = fakeRegistry({});
    const reason = await checkRegistry("next-supabase-tailwind-ui", { fetchImpl });
    expect(reason).toMatch(/does not exist on the npm registry/i);
    expect(reason).toMatch(/hallucinated/i);
  });

  it("REJECTS a freshly-registered package — the ATTACKER-REGISTERED slopsquat", async () => {
    const fetchImpl = fakeRegistry({
      "next-supabase-tailwind-ui": { created: daysAgo(2), downloads: 5 },
    });
    const reason = await checkRegistry("next-supabase-tailwind-ui", { fetchImpl });
    expect(reason).toMatch(/2 days ago/);
    expect(reason).toMatch(/slopsquat/i);
  });

  it("REJECTS an established-age package with no adoption", async () => {
    const fetchImpl = fakeRegistry({
      "sleeper-pkg": { created: daysAgo(400), downloads: MIN_WEEKLY_DOWNLOADS - 1 },
    });
    const reason = await checkRegistry("sleeper-pkg", { fetchImpl });
    expect(reason).toMatch(/weekly downloads/i);
  });

  it("ADMITS a real, established, widely-used package", async () => {
    const fetchImpl = fakeRegistry({
      "date-fns": { created: daysAgo(MIN_PACKAGE_AGE_DAYS + 1), downloads: MIN_WEEKLY_DOWNLOADS + 1 },
    });
    expect(await checkRegistry("date-fns", { fetchImpl })).toBeNull();
  });

  it("FAILS CLOSED when the registry is unreachable — never admits an unverified package", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(checkRegistry("anything", { fetchImpl })).rejects.toThrow(ExpectedToolError);
    await expect(checkRegistry("anything", { fetchImpl })).rejects.toThrow(/failing closed/i);
  });

  it("FAILS CLOSED on a 5xx from the registry", async () => {
    const fetchImpl = fakeRegistry({ "some-pkg": { status: 503 } });
    await expect(checkRegistry("some-pkg", { fetchImpl })).rejects.toThrow(/failing closed/i);
  });

  it("RETRIES a rate-limited (429) downloads response instead of reading it as zero", async () => {
    let dlCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.npmjs.org/downloads")) {
        dlCalls += 1;
        if (dlCalls === 1) return new Response("rate limited", { status: 429 });
        return new Response(JSON.stringify({ downloads: 107_693_282 }), { status: 200 });
      }
      return new Response(JSON.stringify({ time: { created: daysAgo(3201) } }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await checkRegistry("tailwindcss", { fetchImpl })).toBeNull();
    expect(dlCalls).toBe(2);
  });

  it("FAILS CLOSED (retryable) if the downloads API stays rate-limited — never 'zero'", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("api.npmjs.org/downloads")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ time: { created: daysAgo(3201) } }), { status: 200 });
    }) as unknown as typeof fetch;

    const err = await checkRegistry("tailwindcss", { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("registry_unreachable");
    expect(String(err.message)).not.toMatch(/slopsquat/i);
  });

  it("FAILS CLOSED if the downloads API answers 200 with no count — never assumes zero", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("api.npmjs.org/downloads")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({ time: { created: daysAgo(3201) } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(checkRegistry("tailwindcss", { fetchImpl })).rejects.toThrow(
      /failing closed rather than assuming zero/i,
    );
  });
});

describe("assertDependencyAdmission — THE GATE", () => {
  it("no-ops when the push contains no package.json (the common case)", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(
        [{ path: "app/page.tsx", action: "modify", content: "export default () => null;" }],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("BLOCKS a hallucinated dependency — the incident replay", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission(pkgFile({ "next-supabase-tailwind-ui": "1.0.0" }), { fetchImpl }),
    ).rejects.toThrow(/does not exist on the npm registry/i);
  });

  it("BLOCKS an attacker-registered squat that WOULD pass an existence check", async () => {
    const fetchImpl = fakeRegistry({
      "react-supabase-client": { created: daysAgo(3), downloads: 11 },
    });
    await expect(
      assertDependencyAdmission(pkgFile({ "react-supabase-client": "1.0.0" }), { fetchImpl }),
    ).rejects.toThrow(/slopsquat/i);
  });

  it("BLOCKS a non-exact pin — a range defeats the lockfile", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission(pkgFile({ next: "^14.2.35" }), { fetchImpl }),
    ).rejects.toThrow(/not an exact version/i);
  });

  it("BLOCKS a git/http spec (remote code, bypasses the registry entirely)", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission(pkgFile({ evil: "git+https://github.com/evil/pkg.git" }), { fetchImpl }),
    ).rejects.toThrow(/not an exact version/i);
  });

  it("ADMITS the template's own dependencies (allowlist) without touching the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(
        pkgFile(
          { "@supabase/supabase-js": "2.105.4", next: "14.2.35", react: "18.3.1", "react-dom": "18.3.1" },
          { typescript: "5.5.4", tailwindcss: "3.4.10", postcss: "8.5.18" },
        ),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ADMITS the auth starter variant's deps (pg, bcryptjs + types) without touching the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(
        pkgFile({ pg: "8.13.1", bcryptjs: "2.4.3" }, { "@types/pg": "8.11.10", "@types/bcryptjs": "2.4.6" }),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ADMITS a legitimate NEW dependency an agent reaches for (no false-positive lockout)", async () => {
    const fetchImpl = fakeRegistry({
      "react-hook-form": { created: daysAgo(1500), downloads: 4_000_000 },
    });
    await expect(
      assertDependencyAdmission(pkgFile({ "react-hook-form": "7.53.0" }), { fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("catches a package.json nested anywhere in the pushed tree", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission(
        [{ path: "apps/site/package.json", action: "create", content: JSON.stringify({ dependencies: { "fake-pkg": "1.0.0" } }) }],
        { fetchImpl },
      ),
    ).rejects.toThrow(/does not exist/i);
  });

  it("ignores a package.json DELETION (no content to admit)", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission([{ path: "package.json", action: "delete" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed package.json rather than silently admitting it", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission([{ path: "package.json", action: "modify", content: "{not json" }], {
        fetchImpl,
      }),
    ).rejects.toThrow(/not valid JSON/i);
  });
});

describe("assertDependencyAdmission — LAYER 5, lock pairing", () => {
  it("BLOCKS a package.json written without its lock (npm ci would have no lock to honor)", async () => {
    const fetchImpl = fakeRegistry({ zod: { created: daysAgo(1500), downloads: 9_000_000 } });
    await expect(
      assertDependencyAdmission(pkgFileNoLock({ zod: "3.23.8" }), { fetchImpl }),
    ).rejects.toThrow(/without package-lock\.json/i);
  });

  it("BLOCKS a lock that is missing a declared dependency — the exact 2026-06-16 outage shape", async () => {
    const fetchImpl = fakeRegistry({ zod: { created: daysAgo(1500), downloads: 9_000_000 } });
    const files = [
      ...pkgFileNoLock({ zod: "3.23.8", clsx: "2.1.1" }),
      lockFor({ clsx: "2.1.1" }),
    ];
    await expect(assertDependencyAdmission(files, { fetchImpl })).rejects.toThrow(
      /"zod" is declared in package\.json but missing from the lock file/i,
    );
  });

  it("BLOCKS a lock pinned to a DIFFERENT version than package.json declares", async () => {
    const fetchImpl = vi.fn();
    const files = [...pkgFileNoLock({ clsx: "2.1.1" }), lockFor({ clsx: "2.0.0" })];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/"clsx" is "2\.1\.1" in package\.json but "2\.0\.0" in the lock file/i);
  });

  it("BLOCKS a lock whose root spec matches but has no resolved package entry", async () => {
    const fetchImpl = vi.fn();
    const files = [
      ...pkgFileNoLock({ clsx: "2.1.1" }),
      {
        path: "package-lock.json",
        action: "modify",
        content: JSON.stringify({ packages: { "": { dependencies: { clsx: "2.1.1" } } } }),
      },
    ];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no resolved entry/i);
  });

  it("ADMITS package.json + a matching regenerated lock (the correct agent behavior)", async () => {
    const fetchImpl = fakeRegistry({
      "react-hook-form": { created: daysAgo(1500), downloads: 4_000_000 },
    });
    await expect(
      assertDependencyAdmission(pkgFile({ "react-hook-form": "7.53.0" }), { fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("pairs per-directory — a nested package.json needs the lock beside IT, not at the root", async () => {
    const fetchImpl = vi.fn();
    const files = [
      {
        path: "apps/site/package.json",
        action: "modify",
        content: JSON.stringify({ dependencies: { clsx: "2.1.1" } }),
      },
      lockFor({ clsx: "2.1.1" }),
    ];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/apps\/site\/package-lock\.json/i);

    await expect(
      assertDependencyAdmission(
        [files[0], lockFor({ clsx: "2.1.1" }, {}, "apps/site/package-lock.json")],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a malformed lock rather than treating it as absent", async () => {
    const fetchImpl = vi.fn();
    const files = [
      ...pkgFileNoLock({ clsx: "2.1.1" }),
      { path: "package-lock.json", action: "modify", content: "{not json" },
    ];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a DELETED lock does not satisfy the pairing", async () => {
    const fetchImpl = vi.fn();
    const files = [
      ...pkgFileNoLock({ clsx: "2.1.1" }),
      { path: "package-lock.json", action: "delete" },
    ];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/without package-lock\.json/i);
  });

  it("does not false-reject on a lockfileVersion 1 lock it cannot evaluate", async () => {
    const fetchImpl = vi.fn();
    const files = [
      ...pkgFileNoLock({ clsx: "2.1.1" }),
      {
        path: "package-lock.json",
        action: "modify",
        content: JSON.stringify({ lockfileVersion: 1, dependencies: { clsx: { version: "2.1.1" } } }),
      },
    ];
    await expect(
      assertDependencyAdmission(files, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });
});

describe("assertDependencyAdmission — LAYER 5 against the branch's existing lock", () => {
  const repoWith = (content: string | null) =>
    async (): Promise<RepoFileRead> =>
      content === null ? { kind: "absent" } : { kind: "found", content };

  it("ADMITS a scripts-only package.json edit when the branch's lock still satisfies it", async () => {
    const fetchImpl = vi.fn();
    const files = [
      {
        path: "package.json",
        action: "modify",
        content: JSON.stringify({
          scripts: { prestart: "node scripts/migrate.mjs" },
          dependencies: { clsx: "2.1.1" },
        }),
      },
    ];
    await expect(
      assertDependencyAdmission(files, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readRepoFile: repoWith(lockFor({ clsx: "2.1.1" }).content),
      }),
    ).resolves.toBeUndefined();
  });

  it("BLOCKS a NEW dependency pushed without its lock, judged against the branch's lock", async () => {
    const fetchImpl = fakeRegistry({ zod: { created: daysAgo(1500), downloads: 9_000_000 } });
    const files = pkgFileNoLock({ clsx: "2.1.1", zod: "3.23.8" });
    await expect(
      assertDependencyAdmission(files, {
        fetchImpl,
        readRepoFile: repoWith(lockFor({ clsx: "2.1.1" }).content),
      }),
    ).rejects.toThrow(/"zod" is declared in package\.json but missing from the lock file/i);
  });

  it("prefers the PUSHED lock over the branch's when both exist", async () => {
    const fetchImpl = fakeRegistry({ zod: { created: daysAgo(1500), downloads: 9_000_000 } });
    await expect(
      assertDependencyAdmission(pkgFile({ zod: "3.23.8" }), {
        fetchImpl,
        readRepoFile: repoWith(lockFor({ clsx: "2.1.1" }).content),
      }),
    ).resolves.toBeUndefined();
  });

  it("ADMITS when the repo has no lock at all — npm ci has nothing to contradict", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(pkgFileNoLock({ clsx: "2.1.1" }), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readRepoFile: repoWith(null),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not strand a push on a pre-existing malformed lock it did not write", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(pkgFileNoLock({ clsx: "2.1.1" }), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readRepoFile: repoWith("{not json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("FAILS CLOSED (retryable) when the branch's lock cannot be read — never admits on a blip", async () => {
    const fetchImpl = vi.fn();
    await expect(
      assertDependencyAdmission(pkgFileNoLock({ clsx: "2.1.1" }), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readRepoFile: async (): Promise<RepoFileRead> => ({ kind: "error", detail: "HTTP 500" }),
      }),
    ).rejects.toThrow(/could not read package-lock\.json/i);
  });

  it("still vets NAMES (layers 1-4) even when layer 5 is satisfied by the branch lock", async () => {
    const fetchImpl = fakeRegistry({});
    await expect(
      assertDependencyAdmission(pkgFileNoLock({ evil: "^1.0.0" }), {
        fetchImpl,
        readRepoFile: repoWith(lockFor({ evil: "^1.0.0" }).content),
      }),
    ).rejects.toThrow(/not an exact version/i);
  });

  it("checks EVERY package.json in the push, not just the first", async () => {
    const fetchImpl = fakeRegistry({ zod: { created: daysAgo(1500), downloads: 9_000_000 } });
    const files = [
      { path: "package.json", action: "modify", content: JSON.stringify({ dependencies: { clsx: "2.1.1" } }) },
      {
        path: "apps/site/package.json",
        action: "modify",
        content: JSON.stringify({ dependencies: { zod: "3.23.8" } }),
      },
    ];
    await expect(
      assertDependencyAdmission(files, {
        fetchImpl,
        readRepoFile: async (path: string): Promise<RepoFileRead> => ({
          kind: "found",
          content: path === "package-lock.json" ? lockFor({ clsx: "2.1.1" }).content : lockFor({}).content,
        }),
      }),
    ).rejects.toThrow(/"zod" is declared in package\.json but missing from the lock file/i);
  });
});

describe("lockSyncFailures", () => {
  it("returns empty for an in-sync pair", () => {
    expect(
      lockSyncFailures(
        { dependencies: { clsx: "2.1.1" }, devDependencies: { typescript: "5.5.4" } },
        {
          packages: {
            "": { dependencies: { clsx: "2.1.1" }, devDependencies: { typescript: "5.5.4" } },
            "node_modules/clsx": {},
            "node_modules/typescript": {},
          },
        },
      ),
    ).toEqual([]);
  });

  it("reports EVERY desynced dep, not just the first (the agent fixes them in one pass)", () => {
    const failures = lockSyncFailures(
      { dependencies: { a: "1.0.0", b: "2.0.0", c: "3.0.0" } },
      { packages: { "": { dependencies: { c: "3.0.0" } }, "node_modules/c": {} } },
    );
    expect(failures).toHaveLength(2);
    expect(failures.join(" ")).toMatch(/"a"/);
    expect(failures.join(" ")).toMatch(/"b"/);
  });
});

describe("lockSyncFailures — optional-dependency closure", () => {
  it("rejects a lock whose package declares an optional dep with no resolved entry", () => {
    const failures = lockSyncFailures(
      { dependencies: { next: "14.2.35" } },
      {
        packages: {
          "": { dependencies: { next: "14.2.35" } },
          "node_modules/next": { optionalDependencies: { "@next/swc-win32-x64-msvc": "14.2.33" } },
        },
      },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Missing: @next\/swc-win32-x64-msvc from lock file/);
  });

  it("admits the lock once the optional entry is present", () => {
    expect(
      lockSyncFailures(
        { dependencies: { next: "14.2.35" } },
        {
          packages: {
            "": { dependencies: { next: "14.2.35" } },
            "node_modules/next": { optionalDependencies: { "@next/swc-win32-x64-msvc": "14.2.33" } },
            "node_modules/@next/swc-win32-x64-msvc": {},
          },
        },
      ),
    ).toEqual([]);
  });

  it("reports EVERY missing platform binary, mirroring the real failure", () => {
    const swc = [
      "@next/swc-darwin-arm64",
      "@next/swc-darwin-x64",
      "@next/swc-linux-arm64-gnu",
      "@next/swc-linux-arm64-musl",
      "@next/swc-linux-x64-gnu",
      "@next/swc-linux-x64-musl",
      "@next/swc-win32-arm64-msvc",
      "@next/swc-win32-ia32-msvc",
      "@next/swc-win32-x64-msvc",
    ];
    const present = ["@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl"];
    const failures = lockSyncFailures(
      { dependencies: { next: "14.2.35" } },
      {
        packages: {
          "": { dependencies: { next: "14.2.35" } },
          "node_modules/next": { optionalDependencies: Object.fromEntries(swc.map((n) => [n, "14.2.33"])) },
          "node_modules/chokidar": { optionalDependencies: { fsevents: "2.3.3" } },
          ...Object.fromEntries(present.map((n) => [`node_modules/${n}`, {}])),
        },
      },
    );
    expect(failures).toHaveLength(8);
    expect(failures.join(" ")).toMatch(/fsevents/);
    for (const n of present) expect(failures.join(" ")).not.toMatch(new RegExp(n.replace(/[/\\]/g, "\\$&")));
  });

  it("does NOT reject a missing REQUIRED sub-dependency edge (npm accepts these)", () => {
    expect(
      lockSyncFailures(
        { dependencies: { tailwindcss: "3.4.1" } },
        {
          packages: {
            "": { dependencies: { tailwindcss: "3.4.1" } },
            "node_modules/tailwindcss": { dependencies: { "postcss-load-config": "^4.0.0" } },
          },
        },
      ),
    ).toEqual([]);
  });

  it("still returns [] for a lockfileVersion 1 lock it cannot evaluate", () => {
    expect(lockSyncFailures({ dependencies: { next: "14.2.35" } }, {})).toEqual([]);
  });

  it("resolves a workspace-local optional entry instead of falsely rejecting", () => {
    expect(
      lockSyncFailures(
        { dependencies: {} },
        {
          packages: {
            "": {},
            "apps/web/node_modules/next": { version: "14.2.33", optionalDependencies: { "@next/swc-darwin-arm64": "14.2.33" } },
            "apps/web/node_modules/@next/swc-darwin-arm64": { version: "14.2.33" },
          },
        },
      ),
    ).toEqual([]);
  });

  it("does NOT let a wrong-version ROOT entry satisfy a workspace-local optional dep", () => {
    const failures = lockSyncFailures(
      { dependencies: {} },
      {
        packages: {
          "": {},
          "apps/web/node_modules/next": { version: "14.2.33", optionalDependencies: { "@next/swc-darwin-arm64": "14.2.33" } },
          "node_modules/@next/swc-darwin-arm64": { version: "14.2.18" },
        },
      },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/14\.2\.18/);
  });

  it("rejects an optional entry that exists at the wrong exact version", () => {
    const failures = lockSyncFailures(
      { dependencies: { next: "14.2.35" } },
      {
        packages: {
          "": { dependencies: { next: "14.2.35" } },
          "node_modules/next": { version: "14.2.35", optionalDependencies: { "@next/swc-linux-x64-gnu": "14.2.33" } },
          "node_modules/@next/swc-linux-x64-gnu": { version: "14.2.18" },
        },
      },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/"14\.2\.33".*"14\.2\.18"/);
  });
});

describe("resolveLockEntry", () => {
  const packages = {
    "": {},
    "node_modules/a": {},
    "apps/web/node_modules/next": {},
    "apps/web/node_modules/dup": {},
    "node_modules/dup": {},
  };

  it("walks up from the owner to the root", () => {
    expect(resolveLockEntry(packages, "apps/web/node_modules/next", "a")).toBe("node_modules/a");
  });

  it("prefers the nearest ancestor over the root", () => {
    expect(resolveLockEntry(packages, "apps/web/node_modules/next", "dup")).toBe("apps/web/node_modules/dup");
  });

  it("resolves from the root package", () => {
    expect(resolveLockEntry(packages, "", "a")).toBe("node_modules/a");
  });

  it("returns undefined when nothing satisfies it", () => {
    expect(resolveLockEntry(packages, "apps/web/node_modules/next", "nope")).toBeUndefined();
  });

  it("handles a scoped name without mis-splitting the path", () => {
    expect(resolveLockEntry({ "node_modules/@next/swc": {} }, "node_modules/next", "@next/swc")).toBe(
      "node_modules/@next/swc",
    );
  });
});

describe("siblingLockPath", () => {
  it("maps a package.json to the lock beside it", () => {
    expect(siblingLockPath("package.json")).toBe("package-lock.json");
    expect(siblingLockPath("apps/site/package.json")).toBe("apps/site/package-lock.json");
  });
});
