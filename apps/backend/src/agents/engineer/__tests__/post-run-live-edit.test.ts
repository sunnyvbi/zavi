import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");
const stampStart = src.indexOf("Autopilot codegen→push-to-main stamp");
const stampBlock = src.slice(stampStart, stampStart + 14000);
const liveBranch = stampBlock.slice(stampBlock.indexOf("if (liveEditDraft) {"), stampBlock.indexOf("} else if (isProductBuildPush && !refineBrakeActive) {"));
const commitStart = src.indexOf("if (liveEditDraft) {\n    const m = merged");
const commitBlock = src.slice(commitStart, src.indexOf("FIX 2 (2026-07-27) — tell the customer", commitStart));

describe("live edit refines go to the draft, never to main", () => {
  it("is decided only for a provisioned product-build refine carrying the draft marker", () => {
    expect(stampBlock).toMatch(/liveEditDraft = isProductBuildPush && pl\.refine_mode === true && isLiveEditPayload\(payload\);/);
  });

  it("a repair of a live-edit change also commits to the draft, so it can never push unpublished edits to main", () => {
    const at = stampBlock.indexOf("liveEditDraft = isProductBuildPush");
    expect(at).toBeGreaterThan(-1);
    const decision = stampBlock.slice(at, stampBlock.indexOf(";", at));
    expect(decision).toContain("isLiveEditPayload(payload)");
    expect(decision).not.toContain("isRefineNode");
    expect(decision).not.toContain("repair_mode");
    const isRefineNodeDef = src.match(/const isRefineNode = ([^;]+);/)?.[1] ?? "";
    expect(isRefineNodeDef).toContain("repair_mode !== true");
  });

  it("the live-edit branch never stamps push_to_main and marks the envelope as a deferred draft", () => {
    expect(liveBranch.length).toBeGreaterThan(0);
    expect(liveBranch).not.toContain("push_to_main");
    expect(liveBranch).toMatch(/\.defer_pr = true;/);
    expect(liveBranch).toMatch(/\.live_edit_draft = true;/);
  });

  it("push_to_main is only reachable when the change is not a live-edit draft", () => {
    expect(stampBlock).toMatch(/\} else if \(isProductBuildPush && !refineBrakeActive\) \{\s*\(merged as Record<string, unknown>\)\.push_to_main = true;/);
    expect((src.match(/\.push_to_main\s*=\s*true/g) ?? []).length).toBe(1);
  });

  it("a live-edit draft never posts the 'going live' message", () => {
    const goingLive = stampBlock.indexOf("refineGoingLiveThreadId = pl.chat_thread_id");
    const elseIf = stampBlock.indexOf("} else if (isProductBuildPush && !refineBrakeActive) {");
    expect(goingLive).toBeGreaterThan(elseIf);
  });

  it("commits to the draft only after the final dispatch validation passed", () => {
    expect(commitStart).toBeGreaterThan(src.indexOf("const check = validateProposalForDispatch(merged"));
    expect(commitBlock).toContain("await commitRefineToDraft({");
  });

  it("a failed draft commit suppresses the run instead of falling back to any push", () => {
    expect(commitBlock).toMatch(/reason: "live_edit_draft_failed"/);
    expect(commitBlock).toMatch(/kind: "suppress"/);
    expect(commitBlock).not.toContain("push_to_main");
    expect(commitBlock).not.toContain("push_branch");
  });

  it("stamps the draft commit on the persisted envelope so history and version previews can resolve it", () => {
    expect(commitBlock).toMatch(/\(envelope as Record<string, unknown>\)\.commit_sha = draftSha;/);
    expect(commitBlock).toMatch(/\(envelope as Record<string, unknown>\)\.live_edit_draft_sha = draftSha;/);
  });
});

describe("live edit round 2", () => {
  it("a live-edit change that broke a base-passing test is suppressed before any dispatch path", () => {
    expect(stampBlock).toMatch(/liveEditBrokeTest =\s*isProductBuildNode &&\s*isRefineNode &&\s*isLiveEditPayload\(payload\) &&\s*brokeBasePassingTest/);
    const guard = src.indexOf("if (liveEditBrokeTest) {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("const check = validateProposalForDispatch(merged"));
    const body = src.slice(guard, src.indexOf("}\n", src.indexOf('reason: "live_edit_broke_test"')));
    expect(body).toMatch(/kind: "suppress"/);
    expect(body).toContain("await withSandboxGithubToken(");
    expect(body).toContain("restoreDraftAfterReset({");
  });

  it("restores the committed draft before suppressing a failed draft commit", () => {
    const failed = commitBlock.slice(commitBlock.indexOf("if (draftError) {"));
    expect(failed.indexOf("await withSandboxGithubToken(")).toBeGreaterThan(-1);
    expect(failed.indexOf("restoreDraftAfterReset({")).toBeGreaterThan(-1);
    expect(failed.indexOf("restoreDraftAfterReset({")).toBeLessThan(failed.indexOf('reason: "live_edit_draft_failed"'));
  });

  it("re-kicks the preview with a dependency install once the draft commit landed", () => {
    expect(commitBlock).toMatch(/kickLiveEditPreview\(\{[\s\S]{0,200}run_id: ctx\.runId,\s*install: true,/);
    expect(commitBlock.indexOf("kickLiveEditPreview(")).toBeGreaterThan(commitBlock.indexOf("m.live_edit_draft_sha = draftSha;"));
  });
});

describe("dispatch treats a live-edit draft as already handled", () => {
  const dispatch = readFileSync(join(__dirname, "../../../../workers/functions/dispatch-decision.ts"), "utf-8");
  const guard = dispatch.slice(dispatch.indexOf("if ((p as { defer_pr?: unknown }).defer_pr === true) {"));
  it("returns before any push_to_main or open_pr work", () => {
    const liveIdx = guard.indexOf("live_edit_draft === true");
    const pushIdx = guard.indexOf("if (p.push_to_main === true)");
    expect(liveIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeLessThan(pushIdx);
  });
});

describe("build_live_edit_enabled registry entry", () => {
  it("is per-tenant, boolean, default ON (Ravi 2026-09-29)", async () => {
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    const def = APP_SETTINGS.build_live_edit_enabled;
    expect(def.type).toBe("boolean");
    expect(def.defaultValue).toBe(true);
    expect(def.scope).toBe("per-tenant");
  });
});

describe("live edit never boots the per-run engineer preview", () => {
  it("the Tier-B boot is skipped for live-edit payloads, so a rejected change is never served", () => {
    const i = src.indexOf("await bootEngineerPreviewForRun({");
    const guard = src.lastIndexOf("if (!isLiveEditPayload(payload)) {", i);
    expect(guard).toBeGreaterThan(-1);
    expect(i - guard).toBeLessThan(80);
  });
});
