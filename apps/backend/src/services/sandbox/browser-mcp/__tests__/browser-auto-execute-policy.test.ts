import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_EXECUTE_BROWSER_AGENTS,
  isAutoExecuteBrowserAgent,
  AUTO_EXECUTE_OPS,
  isInlineAutoExecutableOp,
} from "../browser-auto-execute-policy";

const SRC_ROOT = join(process.cwd(), "src");

describe("(g) isInlineAutoExecutableOp — Gap3/D2 op-level carveout", () => {
  it("only click + fill are inline-auto-executable", () => {
    expect([...AUTO_EXECUTE_OPS].sort()).toEqual(["click", "fill"]);
    expect(isInlineAutoExecutableOp("click")).toBe(true);
    expect(isInlineAutoExecutableOp("fill")).toBe(true);
  });
  it("the D2 richer ops + unknown/empty ops are NOT inline-auto-executable (→ gate)", () => {
    for (const op of ["download", "file_upload", "execute_js", "evaluate", "nav", "", undefined]) {
      expect(isInlineAutoExecutableOp(op as string | undefined)).toBe(false);
    }
  });
});

describe("(e) isAutoExecuteBrowserAgent — exact-match + defensive", () => {
  it("browser-operator → false (retired 2026-09-30; the carveout is empty)", () => {
    expect(isAutoExecuteBrowserAgent("browser-operator")).toBe(false);
  });
  it("every other agent → false", () => {
    for (const slug of [
      "research",
      "engineer",
      "operator",
      "performance-marketer",
      "qa",
      "BROWSER-OPERATOR",
      "browser-operator-2",
      "browser_operator",
    ]) {
      expect(isAutoExecuteBrowserAgent(slug)).toBe(false);
    }
  });
  it("undefined / empty string → false (fail toward the gate)", () => {
    expect(isAutoExecuteBrowserAgent(undefined)).toBe(false);
    expect(isAutoExecuteBrowserAgent("")).toBe(false);
  });
  it("the allowlist Set is EMPTY (no agent auto-executes browser writes)", () => {
    expect(AUTO_EXECUTE_BROWSER_AGENTS.size).toBe(0);
  });
});

describe("(f) tree-grep allowlist — browser-operator auto-executes ONLY via the policy", () => {
  it("browser-operator is a registered agent dir (src/agents/browser-operator/agent.md exists)", () => {
    expect(existsSync(join(SRC_ROOT, "agents", "browser-operator", "agent.md"))).toBe(
      true,
    );
  });

  it("the literal 'browser-operator' as an AUTO-EXECUTE grant appears ONLY in the policy file", () => {
    const POLICY_FILE = "browser-auto-execute-policy.ts";
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
          continue;
        }
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        if (name === POLICY_FILE) continue;
        if (full.includes(join("agents", "browser-operator"))) continue;
        if (name.endsWith(".test.ts")) continue;

        const content = readFileSync(full, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
          if (!line.includes("browser-operator")) continue;
          if (/new Set\s*\(/.test(line) || /AUTO_EXECUTE/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`);
          }
        }
      }
    };
    walk(SRC_ROOT);

    expect(offenders).toEqual([]);
  });
});
