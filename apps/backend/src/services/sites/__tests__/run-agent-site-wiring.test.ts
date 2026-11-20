
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(process.cwd(), "workers/functions/run-agent.ts"), "utf8");

describe("run-agent site wiring", () => {
  it("chooses the sandbox template through sandboxTemplateForRun", () => {
    expect(src).toMatch(/template: sandboxTemplateForRun\(claim\.agent_slug, claim\.payload\)/);
    expect(src).not.toMatch(/template:\s*\n?\s*claim\.agent_slug === "engineer"/);
  });

  it("resolves a site run's backend from the sites row before the sandbox image and the dispatch read it", () => {
    const merged = src.indexOf('step.run("resolve-site-run"');
    const resolve = src.indexOf('step.run("resolve-site-backend"');
    const sandbox = src.indexOf('step.run("resolve-sandbox"');
    const dispatch = src.indexOf("runDispatch(fullCtx, claim.payload)");
    expect(merged).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(merged);
    expect(sandbox).toBeGreaterThan(resolve);
    expect(dispatch).toBeGreaterThan(resolve);
    expect(src.slice(merged, merged + 900)).toMatch(/site_backend: siteRun\.siteBackend/);
    const block = src.slice(src.lastIndexOf("if (", resolve), resolve + 400);
    expect(block).toMatch(/payloadSiteId\(claim\.payload\) && !siteRun/);
    expect(block).toMatch(/resolvePayloadSiteBackend\(claim\.tenant_id, claim\.payload\)/);
    expect(block).toMatch(/site_backend: siteBackend/);
  });

  it("a run whose repo was resolved without a site_id is matched to the owning site before the sandbox", () => {
    const step = src.indexOf('step.run("resolve-site-for-repo"');
    expect(step).toBeGreaterThan(src.indexOf("repo_hint: resolvedCreds.repo_full_name"));
    expect(src.indexOf('step.run("resolve-sandbox"')).toBeGreaterThan(step);
    expect(src.slice(step, step + 500)).toMatch(/site_backend: siteRef\.site_backend/);
  });

  it("never hands a site-bound run to the laptop lane (it would skip the backend resolution and the site image)", () => {
    const deleg = src.indexOf("await shouldDelegateConversationalEngineerToLocal(");
    expect(deleg).toBeGreaterThan(-1);
    const gate = src.slice(src.lastIndexOf("if (", deleg), deleg);
    expect(gate).toMatch(/!payloadSiteId\(claim\.payload\) &&/);
  });

  it("calls onSiteSandboxReady only for a provisioned run that carries a site_id, after bootstrap", () => {
    const id = src.indexOf("const siteReadyId =");
    expect(src.slice(id, id + 220)).toMatch(/resolvedCreds\.provisioned === true && typeof siteIdForRun === "string" && siteIdForRun\.trim\(\)/);
    const prep = src.indexOf('step.run("prepare-site-sandbox"');
    const body = src.slice(prep, prep + 1500);
    expect(body.indexOf("bootstrapRepo()")).toBeGreaterThan(-1);
    expect(body.indexOf("siteSandboxReady(")).toBeGreaterThan(body.indexOf("bootstrapRepo()"));
    const split = src.indexOf('step.run("site-sandbox-ready"');
    expect(split).toBeGreaterThan(src.indexOf('step.run("bootstrap-repo"'));
    expect(src.slice(src.lastIndexOf("if (", split), split)).toMatch(/siteReadyId !== null/);
  });
});
