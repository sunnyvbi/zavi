import { describe, it, expect } from "vitest";
import {
  evaluateStaleDist,
  resolveNearestPackageRoot,
  isCandidateSrcFile,
  isDistPath,
  detectStaleCommittedDist,
  type StaleDistFileInput,
} from "../stale-committed-dist";
import type { SandboxRunner } from "../helper-detection";

const PKG_DIRS = ["", "apps/backend", "packages/shared-types", "packages/a"];

describe("resolveNearestPackageRoot", () => {
  it("resolves to the deepest ancestor package, not the repo root", () => {
    expect(
      resolveNearestPackageRoot("apps/backend/src/controller/x.ts", PKG_DIRS),
    ).toBe("apps/backend");
    expect(resolveNearestPackageRoot("packages/a/src/x.ts", PKG_DIRS)).toBe(
      "packages/a",
    );
  });

  it("falls back to the repo-root package when no deeper package matches", () => {
    expect(resolveNearestPackageRoot("scripts/x.ts", PKG_DIRS)).toBe("");
  });

  it("returns null when there is no containing package (no root package.json)", () => {
    expect(resolveNearestPackageRoot("apps/backend/src/x.ts", ["packages/a"])).toBe(
      null,
    );
  });
});

describe("isCandidateSrcFile / isDistPath", () => {
  it("accepts a real src .ts and rejects .d.ts / tests / non-ts", () => {
    expect(isCandidateSrcFile("apps/backend/src/controller/x.ts")).toBe(true);
    expect(isCandidateSrcFile("apps/backend/src/x.tsx")).toBe(true);
    expect(isCandidateSrcFile("apps/backend/src/x.d.ts")).toBe(false);
    expect(isCandidateSrcFile("apps/backend/src/x.test.ts")).toBe(false);
    expect(isCandidateSrcFile("apps/backend/src/__tests__/x.ts")).toBe(false);
    expect(isCandidateSrcFile("apps/backend/src/x.js")).toBe(false);
    expect(isCandidateSrcFile("apps/backend/dist/x.ts")).toBe(false);
  });

  it("detects a dist path segment", () => {
    expect(isDistPath("apps/backend/dist/controller/x.js")).toBe(true);
    expect(isDistPath("dist/index.js")).toBe(true);
    expect(isDistPath("apps/backend/src/x.ts")).toBe(false);
    expect(isDistPath("apps/backend/redistribute/x.ts")).toBe(false);
  });
});

const COMMITTED = ["apps/backend", "packages/shared-types"];

describe("evaluateStaleDist", () => {
  it("POSITIVE (PR-#76 shape): fires for the backend, not for the rebuilt shared-types", () => {
    const changed: StaleDistFileInput[] = [
      { path: "apps/backend/src/controller/tutorController.ts", action: "modify" },
      { path: "packages/shared-types/src/index.ts", action: "modify" },
      { path: "packages/shared-types/dist/index.js", action: "modify" },
    ];
    const hits = evaluateStaleDist(changed, COMMITTED, PKG_DIRS);
    expect(hits).toHaveLength(1);
    expect(hits[0].pkgRoot).toBe("apps/backend");
    expect(hits[0].srcFiles).toEqual([
      "apps/backend/src/controller/tutorController.ts",
    ]);
  });

  it("NEG-1: silent when the matching dist was rebuilt in the same diff", () => {
    const changed: StaleDistFileInput[] = [
      { path: "apps/backend/src/controller/tutorController.ts", action: "modify" },
      { path: "apps/backend/dist/controller/tutorController.js", action: "modify" },
    ];
    expect(evaluateStaleDist(changed, COMMITTED, PKG_DIRS)).toEqual([]);
  });

  it("NEG-2: silent when the package does not commit dist", () => {
    const changed: StaleDistFileInput[] = [
      { path: "apps/backend/src/controller/tutorController.ts", action: "modify" },
    ];
    expect(evaluateStaleDist(changed, [], PKG_DIRS)).toEqual([]);
  });

  it("NEG-3: silent when the source file was DELETED", () => {
    const changed: StaleDistFileInput[] = [
      { path: "apps/backend/src/controller/tutorController.ts", action: "delete" },
    ];
    expect(evaluateStaleDist(changed, COMMITTED, PKG_DIRS)).toEqual([]);
  });

  it("NEG-4: silent for .d.ts / test / non-ts changes", () => {
    const changed: StaleDistFileInput[] = [
      { path: "apps/backend/src/x.d.ts", action: "modify" },
      { path: "apps/backend/src/x.test.ts", action: "modify" },
      { path: "apps/backend/src/config.json", action: "modify" },
    ];
    expect(evaluateStaleDist(changed, COMMITTED, PKG_DIRS)).toEqual([]);
  });

  it("NEG-5: attributes to the nearest nested package, never the repo root", () => {
    const changed: StaleDistFileInput[] = [
      { path: "packages/a/src/x.ts", action: "modify" },
    ];
    const hits = evaluateStaleDist(changed, ["packages/a"], PKG_DIRS);
    expect(hits).toHaveLength(1);
    expect(hits[0].pkgRoot).toBe("packages/a");
  });
});

describe("detectStaleCommittedDist (sandbox wrapper, mocked runner)", () => {
  const mkRun =
    (pkgJsonOut: string, distOut: { stdout: string; exit_code: number }): SandboxRunner =>
    async (cmd) => {
      if (cmd.includes("package.json")) {
        return { stdout: pkgJsonOut, stderr: "", exit_code: 0 };
      }
      if (cmd.includes("dist/")) {
        return { stdout: distOut.stdout, stderr: "", exit_code: distOut.exit_code };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    };

  it("end-to-end PR-#76 shape through the wrapper", async () => {
    const run = mkRun(
      "package.json\napps/backend/package.json\npackages/shared-types/package.json\n",
      {
        stdout:
          "apps/backend/dist/controller/tutorController.js\npackages/shared-types/dist/index.js\n",
        exit_code: 0,
      },
    );
    const hits = await detectStaleCommittedDist({
      files: [
        { path: "apps/backend/src/controller/tutorController.ts", action: "modify" },
        { path: "packages/shared-types/dist/index.js", action: "modify" },
      ],
      run,
    });
    expect(hits.map((h) => h.pkgRoot)).toEqual(["apps/backend"]);
  });

  it("fail-open: no tracked dist → empty", async () => {
    const run = mkRun("package.json\napps/backend/package.json\n", {
      stdout: "",
      exit_code: 1,
    });
    const hits = await detectStaleCommittedDist({
      files: [{ path: "apps/backend/src/x.ts", action: "modify" }],
      run,
    });
    expect(hits).toEqual([]);
  });

  it("fail-open: a throwing runner never rejects", async () => {
    const run: SandboxRunner = async () => {
      throw new Error("sandbox gone");
    };
    await expect(
      detectStaleCommittedDist({
        files: [{ path: "apps/backend/src/x.ts", action: "modify" }],
        run,
      }),
    ).resolves.toEqual([]);
  });
});
