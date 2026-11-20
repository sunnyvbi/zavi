import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chain = vi.hoisted(() => [] as Array<[string, unknown[]]>);
vi.mock("e2b", () => {
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, name: string) => (...args: unknown[]) => {
        chain.push([name, args]);
        return builder;
      },
    },
  );
  return {
    Template: (...args: unknown[]) => {
      chain.push(["Template", args]);
      return builder;
    },
    waitForPort: (port: number) => ({ waitForPort: port }),
    Sandbox: { create: vi.fn() },
  };
});

import { E2B_VITE_TEMPLATE_ALIAS, SITE_REPO_DIR, VITE_DEV_PORT } from "@/services/sites/contract";
import { TEMPLATE_FILE_PATHS } from "../template-files.generated";
import {
  VITE_TEMPLATE_FILES_DIR,
  VITE_TEMPLATE_ALIAS,
  DEV_SERVER_CMD,
  assertLockfilePresent,
} from "../../../../../../../../scripts/build-e2b-vite-template";
import { lockfileCommands } from "../../../../../../../../scripts/generate-vite-starter-lockfile";

const calls = (name: string) => chain.filter(([n]) => n === name).map(([, a]) => a);
const allCmds = () => calls("runCmd").flatMap(([c]) => (Array.isArray(c) ? c : [c])) as string[];

describe("scripts/build-e2b-vite-template.ts", () => {
  it("builds from the starter files dir under the contract alias", () => {
    expect(VITE_TEMPLATE_ALIAS).toBe(E2B_VITE_TEMPLATE_ALIAS);
    expect(calls("Template")[0][0]).toEqual({ fileContextPath: VITE_TEMPLATE_FILES_DIR });
    expect(VITE_TEMPLATE_FILES_DIR).toMatch(/templates\/vite-react-supabase\/files$/);
  });

  it("copies every starter file into the repo dir", () => {
    const items = calls("copyItems").flatMap(([i]) => i as Array<{ src: string; dest: string }>);
    for (const p of TEMPLATE_FILE_PATHS) {
      const item = items.find((i) => i.src === p);
      expect(item, p).toBeDefined();
      expect(item!.dest.startsWith(`${SITE_REPO_DIR}/`), p).toBe(true);
    }
  });

  it("makes the repo a git checkout so resetSiteRepo can rewire origin", () => {
    expect(allCmds().some((c) => c.includes("git init") && c.includes(SITE_REPO_DIR))).toBe(true);
  });

  it("installs with npm ci --ignore-scripts and keeps the npm cache and chromium outside the repo", () => {
    const cmds = allCmds();
    const install = cmds.find((c) => c.includes("npm ci"));
    expect(install).toContain("--ignore-scripts");
    const cacheFlag = install!.match(/--cache (\S+)/)?.[1];
    expect(cacheFlag).toBeDefined();
    expect(cacheFlag!.startsWith(SITE_REPO_DIR)).toBe(false);
    const chromium = cmds.find((c) => /playwright install chromium/.test(c));
    expect(chromium).toBeDefined();
    expect(chromium).not.toContain(`PLAYWRIGHT_BROWSERS_PATH=${SITE_REPO_DIR}`);
    expect(cmds.some((c) => c.includes("npm run build"))).toBe(true);
  });

  it("pre-starts the Vite dev server and waits on the contract port", () => {
    const [[cmd, ready]] = calls("setStartCmd");
    expect(cmd).toBe(DEV_SERVER_CMD);
    expect(DEV_SERVER_CMD).toContain(`cd ${SITE_REPO_DIR}`);
    expect(ready).toEqual({ waitForPort: VITE_DEV_PORT });
  });

  it("refuses to build without a lockfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "vite-tpl-"));
    expect(() => assertLockfilePresent(dir)).toThrow(/generate-vite-starter-lockfile/);
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(() => assertLockfilePresent(dir)).not.toThrow();
  });
});

describe("scripts/generate-vite-starter-lockfile.ts", () => {
  it("resolves the lock without running install scripts, then proves it with npm ci, typecheck and build", () => {
    const cmds = lockfileCommands("/home/user/starter");
    expect(cmds[0]).toContain("npm install --package-lock-only --ignore-scripts");
    expect(cmds.some((c) => c.includes("npm ci --ignore-scripts"))).toBe(true);
    expect(cmds.some((c) => c.includes("npm run typecheck"))).toBe(true);
    expect(cmds.some((c) => c.includes("npm run build"))).toBe(true);
    for (const c of cmds) expect(c.startsWith("cd /home/user/starter && ")).toBe(true);
  });
});
