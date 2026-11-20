import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chain = vi.hoisted(() => [] as Array<[string, unknown[]]>);
vi.mock("e2b", () => {
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => { chain.push([name, args]); return builder; },
  });
  return {
    Template: (...args: unknown[]) => { chain.push(["Template", args]); return builder; },
    waitForPort: (port: number) => ({ waitForPort: port }),
    Sandbox: { create: vi.fn() },
  };
});

import { E2B_VITE_TEMPLATE_ALIAS, E2B_ZAVI_TEMPLATE_ALIAS, SITE_REPO_DIR, VITE_DEV_PORT } from "@/services/sites/contract";
import { TEMPLATE_FILE_PATHS } from "../template-files.generated";
import { DEV_SERVER_CMD, assertLockfilePresent, buildTemplate, lockfileCommands } from "../../../../../../../../scripts/build-e2b-zavi-template";

const calls = (name: string) => chain.filter(([n]) => n === name).map(([, a]) => a);
const allCmds = () => calls("runCmd").flatMap(([c]) => (Array.isArray(c) ? c : [c])) as string[];

describe("vite-react-zavi e2b template", () => {
  buildTemplate();

  it("has its own alias (the supabase starter image is untouched)", () => {
    expect(E2B_ZAVI_TEMPLATE_ALIAS).not.toBe(E2B_VITE_TEMPLATE_ALIAS);
    expect((calls("Template")[0][0] as { fileContextPath: string }).fileContextPath).toMatch(/templates\/vite-react-zavi\/files$/);
  });

  it("copies every starter file into the repo dir and makes it a git checkout", () => {
    const items = calls("copyItems").flatMap(([i]) => i as Array<{ src: string; dest: string }>);
    for (const p of TEMPLATE_FILE_PATHS) expect(items.find((i) => i.src === p), p).toBeDefined();
    expect(allCmds().some((c) => c.includes("git init") && c.includes(SITE_REPO_DIR))).toBe(true);
  });

  it("installs with npm ci --ignore-scripts, validates the manifest, typechecks and builds at bake time", () => {
    const cmds = allCmds();
    expect(cmds.find((c) => c.includes("npm ci"))).toContain("--ignore-scripts");
    expect(cmds.some((c) => c.includes("npm run check && npm run typecheck && npm run build"))).toBe(true);
  });

  it("pre-starts the Vite dev server on the contract port", () => {
    const [[cmd, ready]] = calls("setStartCmd");
    expect(cmd).toBe(DEV_SERVER_CMD);
    expect(ready).toEqual({ waitForPort: VITE_DEV_PORT });
  });

  it("refuses to build without a lockfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "zavi-tpl-"));
    expect(() => assertLockfilePresent(dir)).toThrow(/lockfile/);
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(() => assertLockfilePresent(dir)).not.toThrow();
  });

  it("the lockfile is resolved without install scripts and proven with ci, check, typecheck and build", () => {
    const cmds = lockfileCommands("/home/user/starter");
    expect(cmds[0]).toContain("npm install --package-lock-only --ignore-scripts");
    for (const step of ["npm ci --ignore-scripts", "npm run check", "npm run typecheck", "npm run build"]) {
      expect(cmds.some((c) => c.includes(step)), step).toBe(true);
    }
  });
});
