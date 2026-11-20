import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFirstBuildInstallScript,
  ensureProvisionedBuildDeps,
  isFirstBuildScaffold,
  isProvisionedBuildPayload,
  prepareFirstBuildPreview,
} from "@/services/build/first-build-preview";
import { previewServerAnswers } from "@/services/agents/conductor-driver";

afterEach(() => {
  delete process.env.INSTANT_PREVIEW_ENABLED;
});

describe("isFirstBuildScaffold", () => {
  it("only the scaffold stage of a fresh build on a Zavi-owned repo", () => {
    expect(isFirstBuildScaffold({ stage: "scaffold", target: { github_full_name: "praxis-built/a" } })).toBe(true);
    expect(isFirstBuildScaffold({ stage: "build" })).toBe(false);
    expect(isFirstBuildScaffold({ stage: "scaffold", refine_mode: true })).toBe(false);
    expect(isFirstBuildScaffold({ stage: "scaffold", repair_mode: true })).toBe(false);
    expect(isFirstBuildScaffold({ stage: "scaffold", target: { github_target_mode: "user_repo" } })).toBe(false);
    expect(isFirstBuildScaffold(null)).toBe(false);
  });
});

describe("first build install script", () => {
  it("installs only when node_modules is missing, prefers npm ci with a lockfile, and is bounded", () => {
    const s = buildFirstBuildInstallScript();
    expect(s).toContain("if [ ! -d node_modules ] && [ -f package.json ]; then");
    expect(s).toContain("if [ -f package-lock.json ]; then timeout 600 npm ci");
    expect(s).toContain("else timeout 600 npm install");
    expect(s).toContain("__FBP__OK");
  });
});

describe("prepareFirstBuildPreview", () => {
  it("reports ok only when dependencies are really there", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "__FBP__OK\n", stderr: "", exit_code: 0 });
    expect(await prepareFirstBuildPreview("sb1", exec)).toEqual({ ok: true, reason: "ok" });
    expect(exec.mock.calls[0][2]).toBe(630_000);
    const none = vi.fn().mockResolvedValue({ stdout: "__FBP__NOMODULES\n", stderr: "", exit_code: 0 });
    expect(await prepareFirstBuildPreview("sb1", none)).toEqual({ ok: false, reason: "nomodules" });
  });

  it("never throws out of the run when the exec fails", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("sandbox gone"));
    expect((await prepareFirstBuildPreview("sb1", exec)).ok).toBe(false);
  });

  it("still installs with instant preview switched off, but reports no preview to boot", async () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    const exec = vi.fn().mockResolvedValue({ stdout: "__FBP__OK\n", stderr: "", exit_code: 0 });
    expect(await prepareFirstBuildPreview("sb1", exec)).toEqual({ ok: false, reason: "disabled" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toContain("npm ci --prefer-offline");
  });
});

describe("ensureProvisionedBuildDeps", () => {
  it("installs for every build run even with instant preview off, lockfile required, bounded", async () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    const exec = vi.fn().mockResolvedValue({ stdout: "__FBP__OK\n", stderr: "", exit_code: 0 });
    expect(await ensureProvisionedBuildDeps("sb1", exec)).toEqual({ ok: true, reason: "ok" });
    expect(exec.mock.calls[0][1]).toContain("__FBP__NOLOCK");
    expect(exec.mock.calls[0][1]).toContain("timeout 600 npm ci --prefer-offline");
    expect(exec.mock.calls[0][2]).toBe(630_000);
  });

  it("never throws when the sandbox exec fails", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("sandbox gone"));
    expect(await ensureProvisionedBuildDeps("sb1", exec)).toEqual({ ok: false, reason: "exec" });
  });

  it("matches scaffold, build, refine and repair stages only", () => {
    expect(isProvisionedBuildPayload({ stage: "scaffold" })).toBe(true);
    expect(isProvisionedBuildPayload({ stage: "build" })).toBe(true);
    expect(isProvisionedBuildPayload({ stage: "deploy", refine_mode: true })).toBe(true);
    expect(isProvisionedBuildPayload({ stage: "qa", repair_mode: true })).toBe(true);
    expect(isProvisionedBuildPayload({ stage: "qa" })).toBe(false);
    expect(isProvisionedBuildPayload(null)).toBe(false);
  });
});

describe("previewServerAnswers", () => {
  it("treats 2xx and 3xx as answering, anything else or a failed exec as not", async () => {
    const ok = vi.fn().mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 });
    expect(await previewServerAnswers("sb1", 3000, ok)).toBe(true);
    expect(ok.mock.calls[0][1]).toContain("http://127.0.0.1:3000/");
    expect(await previewServerAnswers("sb1", 3000, vi.fn().mockResolvedValue({ stdout: "307", stderr: "", exit_code: 0 }))).toBe(true);
    expect(await previewServerAnswers("sb1", 3000, vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 }))).toBe(false);
    expect(await previewServerAnswers("sb1", 3000, vi.fn().mockRejectedValue(new Error("x")))).toBe(false);
  });
});

describe("wiring", () => {
  const root = join(__dirname, "../../../..");
  const runAgent = readFileSync(join(root, "workers/functions/run-agent.ts"), "utf-8");
  const driver = readFileSync(join(root, "src/services/agents/conductor-driver.ts"), "utf-8");
  const dispatcher = readFileSync(join(root, "src/services/agents/generic-dispatcher.ts"), "utf-8");

  it("run-agent hides the previous preview and installs at scaffold start, but never boots the preview before code is written", () => {
    const i = runAgent.indexOf("resolvedCreds.provisioned === true && isFirstBuildScaffold(claim.payload)");
    expect(i).toBeGreaterThan(-1);
    const block = runAgent.slice(runAgent.lastIndexOf("if (", i), runAgent.indexOf('step.run("first-build-preview-install"', i) + 200);
    expect(block).toMatch(/resolvedCreds\.provisioned === true && isFirstBuildScaffold\(claim\.payload\)/);
    expect(block.indexOf("hideStaleFirstBuildPreview(")).toBeGreaterThan(-1);
    expect(block.indexOf("hideStaleFirstBuildPreview(")).toBeLessThan(block.indexOf("prepareFirstBuildPreview("));
    expect(runAgent).not.toContain("kickSandboxPreview");
    expect(runAgent).not.toContain("kick-first-build-preview");
    expect(i).toBeGreaterThan(runAgent.indexOf('step.run("bootstrap-repo"'));
  });

  it("the dispatcher boots the first-build preview from the sandbox write hook", () => {
    const i = dispatcher.search(/onWrite:\s*firstBuildPreviewWriteHookFor\(payload/);
    expect(i).toBeGreaterThan(-1);
    expect(dispatcher.slice(i, i + 400)).toContain("kickSandboxPreview({ tenant_id: ctx.tenant_id");
  });

  it("run-agent installs deps for provisioned build and live-edit runs after the draft checkout and the token revoke, before the preview and the engineer", () => {
    const at = (needle: string) => {
      const i = runAgent.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const deps = at('step.run("provisioned-build-deps"');
    const gate = runAgent.slice(runAgent.lastIndexOf("if (", deps), deps);
    expect(gate).toMatch(/provisionedRepo !== null/);
    expect(gate).toMatch(/!isFirstBuildScaffold\(claim\.payload\)/);
    expect(gate).toMatch(/isProvisionedBuildPayload\(claim\.payload\) \|\| isLiveEditPayload\(claim\.payload\)/);
    expect(runAgent.slice(deps, deps + 400)).toContain("provisionedBuildDeps)");
    const fn = at("const provisionedBuildDeps = async () => {");
    expect(runAgent.slice(fn, fn + 300)).toContain("ensureProvisionedBuildDeps(sandbox!.e2b_sandbox_id)");
    expect(deps).toBeGreaterThan(at('step.run("bootstrap-repo"'));
    expect(deps).toBeGreaterThan(at('step.run("first-build-preview-install"'));
    expect(deps).toBeGreaterThan(at('step.run("checkout-live-edit-draft"'));
    expect(deps).toBeLessThan(at('step.run("kick-live-edit-preview"'));
    expect(deps).toBeGreaterThan(at('step.run("revoke-sandbox-github-token"'));
    expect(deps).toBeLessThan(at('step.run("dispatch"'));
  });

  it("the instant preview reuses a running dev server and boots with secrets sanitized", () => {
    expect(driver).toMatch(/if \(await previewServerAnswers\(e2bId, runningPort\)\)/);
    const call = driver.slice(driver.indexOf("await startPreviewServer("), driver.indexOf(");", driver.indexOf("await startPreviewServer(")));
    expect(call).toMatch(/^await startPreviewServer\(\s*e2bId,\s*bootPort,/);
    expect(call.match(/sanitize_secret_env: true/g)).toHaveLength(2);
    expect(call).not.toMatch(/sanitize_secret_env: false/);
  });

  it("first-build codegen never runs a production build in the tree the preview serves", () => {
    const rule = dispatcher.slice(dispatcher.indexOf("const codegenVerifyRule = previewServesBuildRepo(pb, "));
    const step2 = rule.slice(rule.indexOf("? `2. After editing"), rule.indexOf(": `2. After editing"));
    expect(step2.length).toBeGreaterThan(0);
    expect(step2).toContain("never run \\`npm run build\\`");
    expect(step2).toContain("/tmp/verify");
    expect(step2).toContain("Do not call \\`app_verify\\`");
    expect(step2).not.toContain("port: 3100");
  });
});
