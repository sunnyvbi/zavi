
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SDK_ALLOWED_BUILTINS,
  SDK_DISALLOWED_BUILTINS,
  SDK_HARNESS_META_TOOLS,
  classifySdkTool,
  isSdkHarnessMetaTool,
} from "../sdk-builtins";
import { isPreviewAllowedTool } from "@/services/growth/preview-tools";
import { benchSdkToolDecision } from "@/services/eval/model-bench/modes";

type Snapshot = {
  sdk_version: string;
  all_builtin_tools: string[];
  exposed_with_our_disallow: string[];
};

const snapshot = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__/sdk-tool-snapshot.json"), "utf8"),
) as Snapshot;

const pinnedSdk = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "../../../../package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@anthropic-ai/claude-agent-sdk"];

describe("isSdkHarnessMetaTool", () => {
  it("matches the exact raw harness names", () => {
    expect(isSdkHarnessMetaTool("ToolSearch")).toBe(true);
    expect(isSdkHarnessMetaTool("StructuredOutput")).toBe(true);
  });

  it("denies prefixed lookalikes, case and whitespace variants, and non-strings", () => {
    for (const n of [
      "mcp__x__ToolSearch",
      "mcp__praxis-server__ToolSearch",
      "mcp__server__StructuredOutput",
      "toolsearch",
      "structuredoutput",
      " ToolSearch",
      "ToolSearch ",
      "ToolSearchX",
      "",
      "Bash",
      "AskUserQuestion",
    ]) {
      expect(isSdkHarnessMetaTool(n), n).toBe(false);
    }
    for (const n of [undefined, null, 1, {}]) expect(isSdkHarnessMetaTool(n)).toBe(false);
  });
});

describe("classification lists", () => {
  it("are disjoint", () => {
    for (const t of SDK_HARNESS_META_TOOLS) {
      expect(SDK_DISALLOWED_BUILTINS.includes(t), t).toBe(false);
      expect(SDK_ALLOWED_BUILTINS.has(t), t).toBe(false);
    }
    for (const t of SDK_ALLOWED_BUILTINS) expect(SDK_DISALLOWED_BUILTINS.includes(t), t).toBe(false);
  });

  it("keep Bash and the 0.3 container tools disallowed", () => {
    for (const t of ["Bash", "Write", "Edit", "WebFetch", "Task", "Workflow", "TaskCreate"]) {
      expect(classifySdkTool(t), t).toBe("disallowed-builtin");
    }
  });
});

describe("SDK tool snapshot contract (regenerate: scripts/sdk-contract.ts)", () => {
  it("was captured from the pinned SDK version", () => {
    expect(snapshot.sdk_version).toBe(pinnedSdk);
  });

  it("was captured with the harness tools present (deferral + outputFormat on)", () => {
    for (const t of SDK_HARNESS_META_TOOLS) expect(snapshot.all_builtin_tools, t).toContain(t);
    expect(snapshot.all_builtin_tools).toContain("Bash");
  });

  it("classifies every tool the SDK exposes", () => {
    const unclassified = snapshot.all_builtin_tools.filter((t) => classifySdkTool(t) === "unclassified");
    expect(unclassified).toEqual([]);
  });

  it("with our disallowedTools, an agent sees only harness meta and allowed built-ins", () => {
    const leaked = snapshot.exposed_with_our_disallow.filter((t) => {
      const c = classifySdkTool(t);
      return c !== "harness-meta" && c !== "allowed-builtin";
    });
    expect(leaked).toEqual([]);
  });

  it("no container-side built-in (Monitor, Cron*, EnterWorktree, RemoteTrigger...) is exposed", () => {
    expect([...snapshot.exposed_with_our_disallow].sort()).toEqual(
      [...SDK_HARNESS_META_TOOLS, ...SDK_ALLOWED_BUILTINS].sort(),
    );
  });
});

describe("default-deny gates agree on the SDK's own tools", () => {
  for (const t of snapshot.all_builtin_tools) {
    const harness = isSdkHarnessMetaTool(t);
    it(`${t}: ${harness ? "allowed" : "denied"} by preview and bench`, () => {
      expect(isPreviewAllowedTool(t)).toBe(harness);
      const bench = benchSdkToolDecision(t, { allowSandbox: true, isShadowRead: () => true });
      expect(bench.allow).toBe(harness);
    });
  }
});
