import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

const stampStart = src.indexOf("Autopilot codegen→push-to-main stamp");
const stampBlock = src.slice(stampStart, stampStart + 9500);

describe("Fault 1 — product-build ALWAYS stamps push_to_main (verification floor bypassed for throwaway repo)", () => {
  it("the push_to_main stamp is NOT gated on !hasVerificationIssue", () => {
    expect(stampBlock).not.toMatch(/&&\s*!hasVerificationIssue/);
  });

  it("the stamp still requires a product-build node + repo/target triple-match", () => {
    expect(stampBlock).toMatch(/isProductBuildNode\b/);
    expect(stampBlock).toMatch(/targetFullName\b/);
    expect(stampBlock).toMatch(/repoHint === targetFullName/);
  });

  it("the stamp sets push_to_main = true", () => {
    expect(stampBlock).toMatch(/\.push_to_main\s*=\s*true/);
  });

  it("isProductBuildNode is derived from stage ∈ {scaffold, build}", () => {
    expect(stampBlock).toMatch(
      /isProductBuildNode\s*=\s*stage === "scaffold" \|\| stage === "build"/,
    );
  });

  it("documents WHY the prod-deploy floor does not apply to the provisioned repo", () => {
    expect(stampBlock).toMatch(/throwaway/i);
    expect(stampBlock).toMatch(/dispatch-decision/);
  });
});

describe("Fault 1 — the prod-repo verification floor is PRESERVED for non-product-build PRs", () => {
  it("the stamp block only ever sets push_to_main inside the isProductBuildNode guard", () => {
    expect(stampBlock).toMatch(
      /isProductBuildPush\s*=\s*isProductBuildNode &&[\s\S]{0,200}!brokeBasePassingTest;/,
    );
    expect(stampBlock).toMatch(
      /if \(isProductBuildPush && !refineBrakeActive\) \{\s*\(merged as Record<string, unknown>\)\.push_to_main = true;/,
    );
  });

  it("post-run does not stamp push_to_main anywhere outside the product-build block", () => {
    const stampCount = (src.match(/\.push_to_main\s*=\s*true/g) ?? []).length;
    expect(stampCount).toBe(1);
  });
});

describe("Auto-publish — refine runs stamp push_to_main by default (setting-gated)", () => {
  it("the stamp `if` is still gated on !refineBrakeActive", () => {
    expect(stampBlock).toMatch(
      /if \(isProductBuildPush && !refineBrakeActive\) \{\s*\(merged as Record<string, unknown>\)\.push_to_main = true;/,
    );
  });

  it("the brake is SETTING-GATED (kill-switch), not unconditional", () => {
    expect(stampBlock).toMatch(
      /refineBrakeActive\s*=\s*isRefineNode && !directMergeEnabled/,
    );
    expect(stampBlock).not.toMatch(/refineBrakeActive\s*=\s*true/);
    expect(stampBlock).not.toContain("isCustomerOriginEdit");
    expect(stampBlock).not.toContain("refine_brake_pr_mode");
  });

  it("directMergeEnabled resolves the enqueue-time decision for refine nodes, true for others", () => {
    expect(stampBlock).toMatch(
      /directMergeEnabled\s*=\s*isRefineNode\s*\?\s*await resolveRefineDirectMerge\(payload, ctx\.tenant_id\)\s*:\s*true;/,
    );
  });

  it("scope: only refine_mode WITHOUT repair_mode gates on the setting — initial builds + in-build repair always direct-push", () => {
    expect(stampBlock).toMatch(
      /isRefineNode\s*=\s*pl\.refine_mode === true && pl\.repair_mode !== true/,
    );
  });

  it("still never fast-forwards a change that broke a base-passing test", () => {
    expect(stampBlock).toMatch(/!brokeBasePassingTest/);
  });

  it("documents the deep dispatch-time guards that stay intact", () => {
    expect(stampBlock).toMatch(/dispatch-decision/);
    expect(stampBlock).toMatch(/protected-path/i);
    expect(stampBlock).toMatch(/kill-switch/i);
  });
});

describe("refine_direct_merge_enabled registry default", () => {
  it("defaults TRUE (auto-publish), boolean, per-tenant overridable (kill-switch)", async () => {
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    const def = APP_SETTINGS.refine_direct_merge_enabled;
    expect(def.type).toBe("boolean");
    expect(def.defaultValue).toBe(true);
    expect(def.scope).toBe("per-tenant");
  });
});

describe("server typecheck verdict never holds a product-build push_to_main", () => {
  it("build-pipeline (payload.stage) runs skip only the post-run final check", () => {
    const helper = readFileSync(join(__dirname, "../typecheck-receipt.ts"), "utf-8");
    expect(helper).toMatch(/if \(opts\.pipelineRun\) return \{ verdict: classifyTypecheck\(receipts\), ranFinal: false \};/);
    const call = src.slice(src.indexOf("typecheckVerdictWithFinalCheck({"), src.indexOf("typecheckVerdictWithFinalCheck({") + 400);
    expect(call).toMatch(/pipelineRun:\s*typeof pipelineStage === "string" && pipelineStage\.length > 0/);
  });

  it("the push_to_main stamp condition reads no typecheck verdict or verification note", () => {
    const cond = stampBlock.slice(stampBlock.indexOf("const isProductBuildPush ="));
    const ifCond = cond.slice(0, cond.indexOf("push_to_main = true"));
    expect(ifCond).toContain("isProductBuildNode");
    expect(ifCond).not.toMatch(/typecheck|verification_notes|hasVerificationIssue/);
  });
});

describe("App database on demand — ensure runs right before the stamp", () => {
  it("ensureAppDbBeforePush is awaited immediately before the push_to_main stamp", () => {
    expect(stampBlock).toMatch(
      /if \(isProductBuildPush\) \{\s*assertNoUnsafeRoleGrant\(built\.files\);\s*(?:\/\/[^\n]*\s*)?if \(!isSiteRunPayload\(payload\) && \(await buildSmokeGateOn\(ctx\.tenant_id\)\)\) \{[^}]*assertSchemaCoversQueries\(built\.files, repoSchema\);\s*\}\s*await ensureAppDbBeforePush\(ctx\.tenant_id, built\.files, merged, payload\);\s*\}\s*liveEditDraft = isProductBuildPush && pl\.refine_mode === true && isLiveEditPayload\(payload\);\s*liveEditBrokeTest =[^;]*;\s*if \(liveEditDraft\) \{[^}]*\} else if \(isProductBuildPush && !refineBrakeActive\) \{\s*\(merged as Record<string, unknown>\)\.push_to_main = true;/,
    );
  });

  it("never records the zavi-metrics.json declaration before the push (dispatch-decision does, after main accepts it)", () => {
    expect(src).not.toContain("recordMetricsDeclaration");
  });

  it("runs for brake-active refines too (review-PR mode): the ensure guard has no refine brake", () => {
    const ensureIf = stampBlock.match(/if \(([^)]*)\) \{\s*assertNoUnsafeRoleGrant\(built\.files\);[\s\S]{0,520}?await ensureAppDbBeforePush/);
    expect(ensureIf?.[1]).toBe("isProductBuildPush");
    const guard = stampBlock.match(/isProductBuildPush\s*=([\s\S]*?);/)?.[1] ?? "";
    expect(guard).not.toContain("refineBrakeActive");
    expect(guard).toContain("!brokeBasePassingTest");
    expect(guard).toContain("repoHint === targetFullName");
  });

  it("the helper throws through (no catch) and records app_db_added only when added", () => {
    const helper = src.slice(src.indexOf("async function ensureAppDbBeforePush("));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toContain("await ensureAppDatabase({ tenant_id, files })");
    expect(body).toMatch(/if \(r\.added\) \(merged as Record<string, unknown>\)\.app_db_added = true;/);
    expect(body).not.toMatch(/catch/);
  });
});

describe("Site roles — unsafe role grant blocks the push", () => {
  it("a hit throws a plain repairable Error naming file:line, rule and the fix", async () => {
    const { assertNoUnsafeRoleGrant } = await import("@/services/provisioning/role-grant-check");
    const { hasRunFailureCode } = await import("@/services/agents/run-failure-code");
    const files = [
      { path: "app/api/signup/route.ts", content: `const { rows } = await query("SELECT count(*)::int AS n FROM users");\nconst role = rows[0].n === 0 ? "owner" : "user";` },
    ];
    let err: unknown;
    try {
      assertNoUnsafeRoleGrant(files);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(hasRunFailureCode(err)).toBe(false);
    expect((err as Error).message).toMatch(/^unsafe_role_grant: app\/api\/signup\/route\.ts:1 /);
    expect((err as Error).message).toContain("requireAdminPage/requireAdminRoute/requireAdminAction");
    expect(() => assertNoUnsafeRoleGrant([{ path: "app/page.tsx", content: `if (user.role === "admin") x();` }])).not.toThrow();
  });

  it("the check is not caught before the stamp and precedes the database setup", () => {
    const block = stampBlock.slice(stampBlock.indexOf("if (isProductBuildPush) {"));
    const upToStamp = block.slice(0, block.indexOf("push_to_main = true"));
    expect(upToStamp.indexOf("assertNoUnsafeRoleGrant(built.files)")).toBeGreaterThan(-1);
    expect(upToStamp.indexOf("assertNoUnsafeRoleGrant(built.files)")).toBeLessThan(upToStamp.indexOf("await ensureAppDbBeforePush"));
    expect(upToStamp).not.toMatch(/\bcatch\b/);
  });
});

describe("DEL-1323 B2 — a push whose SQL queries a table migrate.mjs never creates is refused", () => {
  it("the schema check runs behind build_smoke_gate, after the role check and before the database setup, uncaught", () => {
    const block = stampBlock.slice(stampBlock.indexOf("if (isProductBuildPush) {"));
    const upToStamp = block.slice(0, block.indexOf("push_to_main = true"));
    const roleAt = upToStamp.indexOf("assertNoUnsafeRoleGrant(built.files)");
    const schemaAt = upToStamp.indexOf("assertSchemaCoversQueries(built.files, repoSchema)");
    expect(schemaAt).toBeGreaterThan(roleAt);
    expect(schemaAt).toBeLessThan(upToStamp.indexOf("await ensureAppDbBeforePush"));
    expect(upToStamp.slice(roleAt, schemaAt)).toMatch(
      /if \(!isSiteRunPayload\(payload\) && \(await buildSmokeGateOn\(ctx\.tenant_id\)\)\) \{\s*const repoSchema = await readSchemaBaseline\(\s*\(cmd, timeoutMs\) => execCommand\(sandbox_id, cmd, timeoutMs\),\s*runRepoRoot \?\? "\/home\/user\/repo",\s*built\.files,\s*\);\s*$/,
    );
    expect(upToStamp).not.toMatch(/\bcatch\b/);
    const helper = src.slice(src.indexOf("async function buildSmokeGateOn("));
    expect(helper.slice(0, helper.indexOf("\n}\n"))).toContain('getBoolSetting("build_smoke_gate", tenant_id)');
  });
});

describe("App database on demand — skipped for new-flow site runs", () => {
  it("the helper returns before ensureAppDatabase when the payload carries a site_id", () => {
    const helper = src.slice(src.indexOf("async function ensureAppDbBeforePush("));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    const skip = body.indexOf("if (isSiteRunPayload(payload)) return;");
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(body.indexOf("await ensureAppDatabase({ tenant_id, files })"));
  });

  it("isSiteRunPayload is true only for a non-empty site_id", () => {
    const fn = src.slice(src.indexOf("export function isSiteRunPayload("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/typeof v === "string" && v\.trim\(\)\.length > 0/);
  });
});
